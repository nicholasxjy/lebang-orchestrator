use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, Utc};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::model::{AgentRunRecord, Plan, RunState, RunStatus, StructuredResult, Task, TaskStatus};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("an orchestration plan already exists in {0}")]
    PlanExists(String),
    #[error("cannot read valid JSON from {path}: {detail}")]
    InvalidJson { path: String, detail: String },
    #[error("malformed state: {0}")]
    MalformedState(String),
    #[error("store I/O failed for {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("task {task_id} is already locked by process {pid}")]
    Locked { task_id: String, pid: u32 },
    #[error("another orchestration command is already running for {0}")]
    RunLocked(String),
    #[error(transparent)]
    Model(#[from] crate::model::ModelError),
}

#[derive(Clone, Debug)]
pub struct RunStore {
    pub root: PathBuf,
    pub tasks_dir: PathBuf,
    pub runs_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub history_dir: PathBuf,
    pub locks_dir: PathBuf,
}

impl RunStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        Self {
            tasks_dir: root.join("tasks"),
            runs_dir: root.join("runs"),
            logs_dir: root.join("logs"),
            history_dir: root.join("history"),
            locks_dir: root.join("locks"),
            root,
        }
    }

    pub fn acquire_run_lock(&self) -> Result<RunLock, StoreError> {
        create_dir_all(&self.locks_dir)?;
        let path = self.locks_dir.join(".orchestration.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|source| StoreError::Io {
                path: path.display().to_string(),
                source,
            })?;
        match file.try_lock() {
            Ok(()) => Ok(RunLock { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err(StoreError::RunLocked(self.root.display().to_string()))
            }
            Err(std::fs::TryLockError::Error(source)) => Err(StoreError::Io {
                path: path.display().to_string(),
                source,
            }),
        }
    }

    pub fn initialize(&self, plan: &Plan) -> Result<(), StoreError> {
        plan.validate()?;
        if self.root.join("plan.json").exists() {
            return Err(StoreError::PlanExists(self.root.display().to_string()));
        }
        for directory in [
            &self.root,
            &self.tasks_dir,
            &self.runs_dir,
            &self.logs_dir,
            &self.history_dir,
            &self.locks_dir,
        ] {
            create_dir_all(directory)?;
        }
        for task in &plan.tasks {
            self.write_json(&self.tasks_dir.join(format!("{}.json", task.id)), task)?;
        }
        let now = utc_now();
        self.write_json(
            &self.root.join("state.json"),
            &RunState {
                run_id: Uuid::new_v4(),
                status: RunStatus::Planned,
                goal: plan.goal.clone(),
                base_commit: plan.base_commit.clone(),
                created_at: now.clone(),
                updated_at: now,
                integration_branch: None,
                integration_worktree: None,
                integrated_commits: Vec::new(),
                result: None,
            },
        )?;
        // Publishing the plan is the initialization commit point: all snapshots exist first.
        self.write_json(&self.root.join("plan.json"), plan)?;
        self.append_jsonl(
            &self.history_dir.join("run.jsonl"),
            &serde_json::json!({
                "timestamp": utc_now(),
                "event": "plan_created",
                "goal": plan.goal,
            }),
        )?;
        Ok(())
    }

    pub fn load_plan(&self) -> Result<Plan, StoreError> {
        let mut plan = Plan::from_value(self.read_value(&self.root.join("plan.json"))?)?;
        for task in &mut plan.tasks {
            let snapshot: Task =
                self.read_json(&self.tasks_dir.join(format!("{}.json", task.id)))?;
            if snapshot.id != task.id {
                return Err(StoreError::MalformedState(format!(
                    "task snapshot {} contains id {}",
                    task.id, snapshot.id
                )));
            }
            *task = snapshot;
            task.validate()?;
        }
        plan.validate()?;
        Ok(plan)
    }

    pub fn save_task(&self, task: &Task) -> Result<(), StoreError> {
        task.validate()?;
        self.write_json(&self.tasks_dir.join(format!("{}.json", task.id)), task)
    }

    pub fn replace_plan(&self, plan: &Plan, agent: &str, reason: &str) -> Result<(), StoreError> {
        plan.validate()?;
        let previous = self.load_plan()?;
        let previous_by_id = previous
            .tasks
            .iter()
            .map(|task| (task.id.clone(), task.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut next = plan.clone();
        for old in &previous.tasks {
            if !next.tasks.iter().any(|task| task.id == old.id) {
                let mut invalidated = old.clone();
                invalidated.status = TaskStatus::Invalidated;
                next.tasks.push(invalidated);
            }
        }
        next.validate()?;
        for task in &next.tasks {
            match previous_by_id.get(&task.id) {
                Some(old) if old != task => self.append_history(
                    &task.id,
                    &serde_json::json!({
                        "event": "task_replanned", "agent": agent, "reason": reason,
                        "before": old, "after": task,
                    }),
                )?,
                None => self.append_history(
                    &task.id,
                    &serde_json::json!({
                        "event": "task_added_by_replan", "agent": agent,
                        "reason": reason, "after": task,
                    }),
                )?,
                _ => {}
            }
        }
        self.write_json(&self.root.join("plan.json"), &next)?;
        for task in &next.tasks {
            self.save_task(task)?;
        }
        self.append_jsonl(
            &self.history_dir.join("run.jsonl"),
            &serde_json::json!({
                "timestamp": utc_now(), "event": "plan_replaced",
                "agent": agent, "reason": reason,
            }),
        )
    }

    pub fn load_state(&self) -> Result<RunState, StoreError> {
        let state: RunState = self
            .read_json(&self.root.join("state.json"))
            .map_err(|error| StoreError::MalformedState(error.to_string()))?;
        state
            .validate()
            .map_err(|error| StoreError::MalformedState(error.to_string()))?;
        Ok(state)
    }

    pub fn save_state(&self, state: &RunState) -> Result<(), StoreError> {
        let mut state = state.clone();
        state.updated_at = utc_now();
        state
            .validate()
            .map_err(|error| StoreError::MalformedState(error.to_string()))?;
        self.write_json(&self.root.join("state.json"), &state)
    }

    pub fn append_history(&self, task_id: &str, entry: &Value) -> Result<(), StoreError> {
        let mut object = Map::new();
        object.insert("timestamp".into(), Value::String(utc_now()));
        if let Some(entries) = entry.as_object() {
            object.extend(entries.clone());
        }
        self.append_jsonl(
            &self.history_dir.join(format!("{task_id}.jsonl")),
            &Value::Object(object),
        )
    }

    pub fn latest_history_reason(&self, task_id: &str) -> Result<Option<String>, StoreError> {
        let path = self.history_dir.join(format!("{task_id}.jsonl"));
        if !path.exists() {
            return Ok(None);
        }
        let content = read_to_string(&path)?;
        for line in content.lines().rev() {
            let value: Value =
                serde_json::from_str(line).map_err(|error| StoreError::InvalidJson {
                    path: path.display().to_string(),
                    detail: error.to_string(),
                })?;
            if let Some(reason) = value.get("reason").and_then(Value::as_str) {
                return Ok(Some(reason.to_owned()));
            }
        }
        Ok(None)
    }

    pub fn write_result<T: Serialize>(
        &self,
        task_id: &str,
        role: &str,
        run_id: &str,
        result: &T,
    ) -> Result<PathBuf, StoreError> {
        let path = self
            .runs_dir
            .join(task_id)
            .join(role)
            .join(format!("{run_id}.json"));
        self.write_json(&path, result)?;
        Ok(path)
    }

    pub fn latest_structured_result<T: StructuredResult>(
        &self,
        task_id: &str,
        role: &str,
    ) -> Result<Option<T>, StoreError> {
        let Some(path) = self.latest_run_path(task_id, role)? else {
            return Ok(None);
        };
        let record: Value = self.read_json(&path)?;
        if record.get("exitCode").and_then(Value::as_i64) != Some(0) {
            return Ok(None);
        }
        let value =
            record
                .get("structuredResult")
                .cloned()
                .ok_or_else(|| StoreError::InvalidJson {
                    path: path.display().to_string(),
                    detail: "run record has no structured result".into(),
                })?;
        let result: T = serde_json::from_value(value).map_err(|error| StoreError::InvalidJson {
            path: path.display().to_string(),
            detail: error.to_string(),
        })?;
        result.validate_result()?;
        Ok(Some(result))
    }

    pub fn latest_failed_run(
        &self,
        task_id: &str,
        role: &str,
        agent: &str,
    ) -> Result<Option<AgentRunRecord>, StoreError> {
        let Some(path) = self.latest_run_path(task_id, role)? else {
            return Ok(None);
        };
        let record: AgentRunRecord = self.read_json(&path)?;
        if record.agent == agent && record.exit_code != 0 {
            Ok(Some(record))
        } else {
            Ok(None)
        }
    }

    fn latest_run_path(&self, task_id: &str, role: &str) -> Result<Option<PathBuf>, StoreError> {
        let directory = self.runs_dir.join(task_id).join(role);
        if !directory.exists() {
            return Ok(None);
        }
        let mut paths = fs::read_dir(&directory)
            .map_err(|source| StoreError::Io {
                path: directory.display().to_string(),
                source,
            })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort_by(|left, right| {
            let modified = |path: &Path| {
                path.metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            };
            modified(right)
                .cmp(&modified(left))
                .then_with(|| right.cmp(left))
        });
        Ok(paths.into_iter().next())
    }

    pub fn write_log(&self, name: &str, content: &str) -> Result<PathBuf, StoreError> {
        let path = self.logs_dir.join(name);
        create_dir_all(&self.logs_dir)?;
        fs::write(&path, content).map_err(|source| StoreError::Io {
            path: path.display().to_string(),
            source,
        })?;
        Ok(path)
    }

    pub fn acquire_task_lock(&self, task_id: &str) -> Result<TaskLock, StoreError> {
        crate::model::validate_task_id(task_id)?;
        create_dir_all(&self.locks_dir)?;
        let path = self.locks_dir.join(format!("{task_id}.lock"));
        let nonce = Uuid::new_v4().simple().to_string();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let record = serde_json::json!({
                        "taskId": task_id,
                        "pid": std::process::id(),
                        "nonce": nonce,
                        "createdAt": utc_now(),
                    });
                    writeln!(
                        file,
                        "{}",
                        serde_json::to_string(&record).expect("lock JSON")
                    )
                    .map_err(|source| StoreError::Io {
                        path: path.display().to_string(),
                        source,
                    })?;
                    file.sync_all().map_err(|source| StoreError::Io {
                        path: path.display().to_string(),
                        source,
                    })?;
                    return Ok(TaskLock {
                        path,
                        nonce: nonce.clone(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let existing: Value = self.read_json(&path)?;
                    let pid = existing.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    if pid_is_alive(pid) {
                        return Err(StoreError::Locked {
                            task_id: task_id.into(),
                            pid,
                        });
                    }
                    fs::remove_file(&path).map_err(|source| StoreError::Io {
                        path: path.display().to_string(),
                        source,
                    })?;
                    self.append_history(
                        task_id,
                        &serde_json::json!({
                            "event": "stale_lock_removed",
                            "agent": "lebang",
                            "reason": format!("owner process {pid} is not running"),
                        }),
                    )?;
                }
                Err(source) => {
                    return Err(StoreError::Io {
                        path: path.display().to_string(),
                        source,
                    });
                }
            }
        }
    }

    pub fn append_jsonl<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), StoreError> {
        if let Some(parent) = path.parent() {
            create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|source| StoreError::Io {
                path: path.display().to_string(),
                source,
            })?;
        let value = serde_json::to_value(value).map_err(|error| StoreError::InvalidJson {
            path: path.display().to_string(),
            detail: error.to_string(),
        })?;
        writeln!(
            file,
            "{}",
            serde_json::to_string(&sort_json(value)).expect("JSON value")
        )
        .map_err(|source| StoreError::Io {
            path: path.display().to_string(),
            source,
        })?;
        file.sync_all().map_err(|source| StoreError::Io {
            path: path.display().to_string(),
            source,
        })
    }

    pub fn read_json<T: DeserializeOwned>(&self, path: &Path) -> Result<T, StoreError> {
        serde_json::from_value(self.read_value(path)?).map_err(|error| StoreError::InvalidJson {
            path: path.display().to_string(),
            detail: error.to_string(),
        })
    }

    pub fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), StoreError> {
        if let Some(parent) = path.parent() {
            create_dir_all(parent)?;
        }
        let temporary = path.with_file_name(format!(
            ".{}.{}.{}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("state"),
            std::process::id(),
            Uuid::new_v4()
        ));
        let value = serde_json::to_value(value).map_err(|error| StoreError::InvalidJson {
            path: path.display().to_string(),
            detail: error.to_string(),
        })?;
        let bytes = serde_json::to_vec_pretty(&sort_json(value)).expect("JSON value");
        let result = (|| -> Result<(), StoreError> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|source| StoreError::Io {
                    path: temporary.display().to_string(),
                    source,
                })?;
            file.write_all(&bytes)
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|source| StoreError::Io {
                    path: temporary.display().to_string(),
                    source,
                })?;
            file.sync_all().map_err(|source| StoreError::Io {
                path: temporary.display().to_string(),
                source,
            })?;
            fs::rename(&temporary, path).map_err(|source| StoreError::Io {
                path: path.display().to_string(),
                source,
            })?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn read_value(&self, path: &Path) -> Result<Value, StoreError> {
        let input = read_to_string(path)?;
        serde_json::from_str(&input).map_err(|error| StoreError::InvalidJson {
            path: path.display().to_string(),
            detail: error.to_string(),
        })
    }
}

#[derive(Debug)]
pub struct TaskLock {
    path: PathBuf,
    nonce: String,
}

// Keep the inode in place; closing the descriptor releases the OS lock even after a crash.
#[derive(Debug)]
pub struct RunLock {
    _file: fs::File,
}

impl Drop for TaskLock {
    fn drop(&mut self) {
        let Ok(input) = fs::read_to_string(&self.path) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(&input) else {
            return;
        };
        if value.get("nonce").and_then(Value::as_str) == Some(self.nonce.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn create_dir_all(path: &Path) -> Result<(), StoreError> {
    fs::create_dir_all(path).map_err(|source| StoreError::Io {
        path: path.display().to_string(),
        source,
    })
}

fn read_to_string(path: &Path) -> Result<String, StoreError> {
    let mut input = String::new();
    let mut file = fs::File::open(path).map_err(|source| StoreError::Io {
        path: path.display().to_string(),
        source,
    })?;
    file.read_to_string(&mut input)
        .map_err(|source| StoreError::Io {
            path: path.display().to_string(),
            source,
        })?;
    Ok(input)
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(sort_json).collect()),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, sort_json(value)))
                    .collect(),
            )
        }
        scalar => scalar,
    }
}

fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 performs an existence/permission check and does not signal the process.
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
