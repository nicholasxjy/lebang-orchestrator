use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;
use tokio::{process::Command, sync::Mutex, time::timeout};

use crate::{
    config::{AgentConfig, Config, Role},
    store::RunStore,
};

const LAYOUT_FILE: &str = "herdr-layout.json";
pub(crate) const MISSING_MARKED_RESULT: &str =
    "Herdr transcript did not contain a valid marked result";

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("lebang must run inside a Herdr-managed pane (HERDR_ENV=1)")]
    NotInHerdr,
    #[error("Herdr {action} failed with {code}: {detail}")]
    Command {
        action: String,
        code: i32,
        detail: String,
    },
    #[error("Herdr {0} timed out")]
    Timeout(String),
    #[error("Herdr returned malformed JSON: {0}")]
    Response(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Invalid(String),
    #[error("runtime I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
}

#[derive(Clone, Debug)]
pub struct AgentInvocation {
    pub agent: AgentConfig,
    pub cwd: PathBuf,
    pub prompt: String,
    pub marker: String,
    pub timeout: Duration,
    pub resume_session: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPane {
    pub pane_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HerdrLayout {
    pub version: u32,
    pub repo_root: String,
    pub tab_id: String,
    pub coordinator_pane: String,
    pub agents: BTreeMap<String, AgentPane>,
    pub roster: Vec<AgentConfig>,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError>;
    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError>;
}

pub struct RecordingRuntime {
    responses: Mutex<VecDeque<Result<Value, String>>>,
    invocations: Mutex<Vec<AgentInvocation>>,
    bootstraps: Mutex<usize>,
}

impl RecordingRuntime {
    pub fn new(values: impl IntoIterator<Item = Value>) -> Self {
        Self {
            responses: Mutex::new(values.into_iter().map(Ok).collect()),
            invocations: Mutex::new(Vec::new()),
            bootstraps: Mutex::new(0),
        }
    }

    pub async fn push(&self, value: Value) {
        self.responses.lock().await.push_back(Ok(value));
    }

    pub async fn push_error(&self, message: impl Into<String>) {
        self.responses.lock().await.push_back(Err(message.into()));
    }

    pub async fn invocations(&self) -> Vec<AgentInvocation> {
        self.invocations.lock().await.clone()
    }

    pub async fn bootstrap_count(&self) -> usize {
        *self.bootstraps.lock().await
    }
}

#[async_trait]
impl AgentRuntime for RecordingRuntime {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError> {
        *self.bootstraps.lock().await += 1;
        Ok(HerdrLayout {
            version: 1,
            repo_root: "/recording".into(),
            tab_id: "w1:t1".into(),
            coordinator_pane: "w1:p1".into(),
            agents: BTreeMap::new(),
            roster: Vec::new(),
        })
    }

    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError> {
        self.invocations.lock().await.push(request.clone());
        let response = self
            .responses
            .lock()
            .await
            .pop_front()
            .ok_or_else(|| {
                RuntimeError::Invalid("recording runtime has no queued response".into())
            })?
            .map_err(RuntimeError::Invalid)?;
        Ok(format!(
            "{}_BEGIN\n{}\n{}_END",
            request.marker,
            serde_json::to_string(&response).expect("JSON value"),
            request.marker
        ))
    }
}

pub struct HerdrRuntime {
    repo_root: PathBuf,
    config: Config,
    environment: BTreeMap<String, String>,
    identity_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl HerdrRuntime {
    pub fn new(repo_root: impl AsRef<Path>, config: Config) -> Self {
        Self::with_environment(repo_root, config, std::env::vars().collect())
    }

    pub fn with_environment(
        repo_root: impl AsRef<Path>,
        config: Config,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            repo_root: absolute(repo_root.as_ref()),
            config,
            environment,
            identity_locks: Mutex::new(HashMap::new()),
        }
    }

    async fn bootstrap_inner(
        &self,
        created: &mut Vec<String>,
    ) -> Result<HerdrLayout, RuntimeError> {
        self.assert_session()?;
        let current = self
            .run_checked(
                vec!["pane".into(), "current".into(), "--current".into()],
                &self.repo_root,
                Duration::from_secs(30),
                "pane current",
            )
            .await?;
        let coordinator_pane = response_string(&current, &["pane_id", "paneId"])?
            .ok_or_else(|| RuntimeError::Response("pane current omitted pane_id".into()))?;
        let tab_id = response_string(&current, &["tab_id", "tabId"])?
            .or_else(|| self.environment.get("HERDR_TAB_ID").cloned())
            .ok_or_else(|| RuntimeError::Response("pane current omitted tab_id".into()))?;

        if let Some(layout) = self.load_layout()? {
            self.validate_reusable_layout(&layout, &tab_id).await?;
            return Ok(layout);
        }

        for agent in self.config.agents.values() {
            let existing = self
                .run(
                    vec!["agent".into(), "get".into(), agent.identity.clone()],
                    &self.repo_root,
                    Duration::from_secs(30),
                )
                .await?;
            if existing.code == 0 {
                let cwd = response_string(&existing.stdout, &["cwd"])?
                    .unwrap_or_else(|| "unknown cwd".into());
                let pane = response_string(&existing.stdout, &["pane_id", "paneId"])?
                    .unwrap_or_else(|| "unknown pane".into());
                return Err(RuntimeError::Conflict(format!(
                    "Herdr agent name {} is already in use at {cwd} ({pane}); close it or use this repository's recorded layout",
                    agent.identity
                )));
            }
        }

        let agent_root = self.split_pane(&coordinator_pane, "right", 0.2).await?;
        created.push(agent_root.clone());
        let lower_root = self.split_pane(&agent_root, "down", 0.5).await?;
        created.push(lower_root.clone());

        let mut upper = vec![self.agent_for(Role::Planner)?.clone()];
        upper.extend(self.config.coders().into_iter().cloned());
        upper.sort_by(|left, right| match (left.role, right.role) {
            (Role::Planner, Role::Coder) => std::cmp::Ordering::Less,
            (Role::Coder, Role::Planner) => std::cmp::Ordering::Greater,
            _ => left.identity.cmp(&right.identity),
        });
        let lower = [Role::Tester, Role::Reviewer, Role::Integrator]
            .into_iter()
            .map(|role| self.agent_for(role).cloned())
            .collect::<Result<Vec<_>, _>>()?;

        let upper_panes = self.split_row(&agent_root, upper.len(), created).await?;
        let lower_panes = self.split_row(&lower_root, lower.len(), created).await?;
        let assignments = upper
            .into_iter()
            .zip(upper_panes)
            .chain(lower.into_iter().zip(lower_panes))
            .collect::<Vec<_>>();

        for (agent, pane) in &assignments {
            self.rename_pane(pane, &agent.identity).await?;
            self.start_agent(agent, pane, &self.repo_root, false)
                .await?;
            self.calibrate(agent, pane).await?;
        }

        let agents = assignments
            .into_iter()
            .map(|(agent, pane)| (agent.identity, AgentPane { pane_id: pane }))
            .collect();
        let layout = HerdrLayout {
            version: 1,
            repo_root: path_string(&self.repo_root),
            tab_id,
            coordinator_pane,
            agents,
            roster: self.config.agents.values().cloned().collect(),
        };
        let store = RunStore::new(self.repo_root.join(".orchestrator"));
        store.write_json(&store.root.join(LAYOUT_FILE), &layout)?;
        Ok(layout)
    }

    async fn validate_reusable_layout(
        &self,
        layout: &HerdrLayout,
        current_tab: &str,
    ) -> Result<(), RuntimeError> {
        let expected_roster = self.config.agents.values().cloned().collect::<Vec<_>>();
        if layout.repo_root != path_string(&self.repo_root)
            || layout.tab_id != current_tab
            || layout.roster != expected_roster
        {
            return Err(RuntimeError::Conflict(format!(
                "recorded Herdr layout belongs to repository/tab/roster {}/{}/different configuration; current tab is {current_tab}",
                layout.repo_root, layout.tab_id
            )));
        }
        for (identity, location) in &layout.agents {
            let existing = self
                .run(
                    vec!["agent".into(), "get".into(), identity.clone()],
                    &self.repo_root,
                    Duration::from_secs(30),
                )
                .await?;
            if existing.code != 0 {
                return Err(RuntimeError::Conflict(format!(
                    "recorded Herdr agent {identity} is no longer live in pane {}",
                    location.pane_id
                )));
            }
            let actual = response_string(&existing.stdout, &["pane_id", "paneId"])?;
            if actual.as_deref() != Some(location.pane_id.as_str()) {
                return Err(RuntimeError::Conflict(format!(
                    "Herdr agent {identity} is live in {}, expected {}",
                    actual.unwrap_or_else(|| "an unknown pane".into()),
                    location.pane_id
                )));
            }
            let agent = self.config.agents.get(identity).ok_or_else(|| {
                RuntimeError::Conflict(format!(
                    "recorded Herdr identity {identity} is absent from the current roster"
                ))
            })?;
            self.calibrate(agent, &location.pane_id).await?;
        }
        Ok(())
    }

    async fn split_row(
        &self,
        root: &str,
        count: usize,
        created: &mut Vec<String>,
    ) -> Result<Vec<String>, RuntimeError> {
        let mut panes = vec![root.to_owned()];
        let mut remaining = root.to_owned();
        for slots in (2..=count).rev() {
            let ratio = 1.0 / slots as f32;
            let next = self.split_pane(&remaining, "right", ratio).await?;
            created.push(next.clone());
            panes.push(next.clone());
            remaining = next;
        }
        Ok(panes)
    }

    async fn split_pane(
        &self,
        pane: &str,
        direction: &str,
        ratio: f32,
    ) -> Result<String, RuntimeError> {
        let output = self
            .run_checked(
                vec![
                    "pane".into(),
                    "split".into(),
                    "--pane".into(),
                    pane.into(),
                    "--direction".into(),
                    direction.into(),
                    "--ratio".into(),
                    ratio.to_string(),
                    "--cwd".into(),
                    path_string(&self.repo_root),
                    "--no-focus".into(),
                ],
                &self.repo_root,
                Duration::from_secs(30),
                &format!("split pane {pane}"),
            )
            .await?;
        response_string(&output, &["pane_id", "paneId"])?
            .ok_or_else(|| RuntimeError::Response("pane split omitted pane_id".into()))
    }

    async fn rename_pane(&self, pane: &str, identity: &str) -> Result<(), RuntimeError> {
        self.run_checked(
            vec!["pane".into(), "rename".into(), pane.into(), identity.into()],
            &self.repo_root,
            Duration::from_secs(30),
            &format!("rename pane {pane}"),
        )
        .await?;
        Ok(())
    }

    async fn start_agent(
        &self,
        agent: &AgentConfig,
        pane: &str,
        cwd: &Path,
        resume: bool,
    ) -> Result<(), RuntimeError> {
        let args = self.start_arguments(agent, pane, cwd, resume)?;
        for attempt in 1..=40 {
            let output = self
                .run(args.clone(), cwd, Duration::from_secs(125))
                .await?;
            if output.code == 0 {
                return Ok(());
            }
            let busy = response_error_code(&output.stderr).as_deref() == Some("agent_pane_busy")
                || response_error_code(&output.stdout).as_deref() == Some("agent_pane_busy");
            if !busy || attempt == 40 {
                return Err(command_error(&format!("start {}", agent.identity), output));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        unreachable!()
    }

    fn start_arguments(
        &self,
        agent: &AgentConfig,
        pane: &str,
        cwd: &Path,
        resume: bool,
    ) -> Result<Vec<String>, RuntimeError> {
        let sandbox = match agent.role {
            Role::Coder | Role::Tester => "workspace-write",
            Role::Planner | Role::Reviewer | Role::Integrator => "read-only",
        };
        let instructions = self.developer_instructions(agent)?;
        let mut args = vec![
            "agent".into(),
            "start".into(),
            agent.identity.clone(),
            "--kind".into(),
            "codex".into(),
            "--pane".into(),
            pane.into(),
            "--timeout".into(),
            "120000".into(),
            "--".into(),
        ];
        if resume {
            args.extend(["resume".into(), "--last".into()]);
        }
        args.extend([
            "--model".into(),
            agent.model.clone(),
            "--cd".into(),
            path_string(cwd),
            "--no-alt-screen".into(),
            "--sandbox".into(),
            sandbox.into(),
        ]);
        if matches!(agent.role, Role::Coder | Role::Tester) {
            args.extend([
                "--add-dir".into(),
                path_string(&self.repo_root.join(".git")),
            ]);
        }
        args.extend([
            "--ask-for-approval".into(),
            "never".into(),
            "-c".into(),
            format!(
                "model_reasoning_effort={}",
                toml_string(agent.thinking.as_str())
            ),
            "-c".into(),
            format!(
                "plan_mode_reasoning_effort={}",
                toml_string(agent.thinking.as_str())
            ),
            "-c".into(),
            format!("developer_instructions={}", toml_string(&instructions)),
        ]);
        Ok(args)
    }

    fn developer_instructions(&self, agent: &AgentConfig) -> Result<String, RuntimeError> {
        let skill = self.resolve_skill(&agent.skill)?;
        let roster = self
            .config
            .agents
            .values()
            .map(|member| format!("{}:{}", member.identity, member.role.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!(
            "You are {}. Your orchestration role is {}. Operate in {} mode. The fixed team roster is: {}. Follow this role Skill:\n\n{}",
            agent.identity,
            agent.role.as_str(),
            agent.mode.as_str(),
            roster,
            skill
        ))
    }

    fn resolve_skill(&self, skill: &str) -> Result<String, RuntimeError> {
        let override_path = self.repo_root.join(".skills").join(skill).join("SKILL.md");
        if override_path.is_file() {
            return Ok(std::fs::read_to_string(override_path)?);
        }
        builtin_skill(skill).map(str::to_owned).ok_or_else(|| {
            RuntimeError::Invalid(format!("configured skill does not exist: {skill}"))
        })
    }

    async fn calibrate(&self, agent: &AgentConfig, pane: &str) -> Result<(), RuntimeError> {
        let footer = self.read_footer(pane).await?;
        let lower = footer.to_lowercase();
        if !lower.contains(&agent.model.to_lowercase()) {
            return Err(RuntimeError::Invalid(format!(
                "Codex footer for {} does not show configured model {}: {footer}",
                agent.identity, agent.model
            )));
        }
        if !lower.contains(agent.thinking.as_str()) {
            return Err(RuntimeError::Invalid(format!(
                "Codex footer for {} does not show configured thinking {}: {footer}",
                agent.identity,
                agent.thinking.as_str()
            )));
        }
        Ok(())
    }

    async fn read_footer(&self, pane: &str) -> Result<String, RuntimeError> {
        let output = self
            .run_checked(
                vec![
                    "pane".into(),
                    "read".into(),
                    pane.into(),
                    "--source".into(),
                    "detection".into(),
                    "--lines".into(),
                    "20".into(),
                ],
                &self.repo_root,
                Duration::from_secs(30),
                &format!("read footer in {pane}"),
            )
            .await?;
        response_text(&output)
    }

    async fn rebind_if_needed(
        &self,
        agent: &AgentConfig,
        pane: &str,
        cwd: &Path,
        resume_session: bool,
    ) -> Result<(), RuntimeError> {
        let existing = self
            .run(
                vec!["agent".into(), "get".into(), agent.identity.clone()],
                cwd,
                Duration::from_secs(30),
            )
            .await?;
        let needs_start = existing.code != 0;
        let current_cwd = if needs_start {
            None
        } else {
            response_string(&existing.stdout, &["cwd"])?
        };
        if !needs_start && current_cwd.as_deref() == Some(path_string(cwd).as_str()) {
            return Ok(());
        }
        if !needs_start {
            let _ = self
                .run(
                    vec![
                        "agent".into(),
                        "prompt".into(),
                        agent.identity.clone(),
                        "/quit".into(),
                        "--wait".into(),
                        "--timeout".into(),
                        "30000".into(),
                    ],
                    cwd,
                    Duration::from_secs(35),
                )
                .await?;
        }
        self.start_agent(agent, pane, cwd, resume_session).await?;
        self.calibrate(agent, pane).await
    }

    async fn identity_lock(&self, identity: &str) -> Arc<Mutex<()>> {
        let mut locks = self.identity_locks.lock().await;
        locks
            .entry(identity.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn agent_for(&self, role: Role) -> Result<&AgentConfig, RuntimeError> {
        self.config
            .agent_for_role(role.as_str())
            .map_err(|error| RuntimeError::Invalid(error.to_string()))
    }

    fn assert_session(&self) -> Result<(), RuntimeError> {
        if self.environment.get("HERDR_ENV").map(String::as_str) != Some("1") {
            return Err(RuntimeError::NotInHerdr);
        }
        Ok(())
    }

    fn load_layout(&self) -> Result<Option<HerdrLayout>, RuntimeError> {
        let path = self.repo_root.join(".orchestrator").join(LAYOUT_FILE);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(
            RunStore::new(self.repo_root.join(".orchestrator")).read_json(&path)?,
        ))
    }

    async fn cleanup(&self, created: &[String]) {
        for pane in created.iter().rev() {
            let _ = self
                .run(
                    vec!["pane".into(), "close".into(), pane.clone()],
                    &self.repo_root,
                    Duration::from_secs(10),
                )
                .await;
        }
    }

    async fn run_checked(
        &self,
        args: Vec<String>,
        cwd: &Path,
        duration: Duration,
        action: &str,
    ) -> Result<String, RuntimeError> {
        let output = self.run(args, cwd, duration).await?;
        if output.code != 0 {
            return Err(command_error(action, output));
        }
        Ok(output.stdout)
    }

    async fn run(
        &self,
        args: Vec<String>,
        cwd: &Path,
        duration: Duration,
    ) -> Result<ProcessOutput, RuntimeError> {
        let mut command = Command::new(&self.config.herdr.command);
        command
            .args(args)
            .current_dir(cwd)
            .envs(&self.environment)
            .kill_on_drop(true);
        let action = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let output = timeout(duration, command.output())
            .await
            .map_err(|_| RuntimeError::Timeout(action))??;
        Ok(ProcessOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[async_trait]
impl AgentRuntime for HerdrRuntime {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError> {
        let mut created = Vec::new();
        match self.bootstrap_inner(&mut created).await {
            Ok(layout) => Ok(layout),
            Err(error) => {
                self.cleanup(&created).await;
                Err(error)
            }
        }
    }

    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError> {
        self.assert_session()?;
        let layout = self.load_layout()?.ok_or_else(|| {
            RuntimeError::Invalid("no recorded Herdr layout; run lebang plan first".into())
        })?;
        let pane = layout
            .agents
            .get(&request.agent.identity)
            .ok_or_else(|| {
                RuntimeError::Invalid(format!(
                    "recorded Herdr layout has no agent {}",
                    request.agent.identity
                ))
            })?
            .pane_id
            .clone();
        let lock = self.identity_lock(&request.agent.identity).await;
        let _guard = lock.lock().await;
        self.rebind_if_needed(&request.agent, &pane, &request.cwd, request.resume_session)
            .await?;
        let transport = format!(
            "{}\n\nHerdr result transport:\nEnd the response with {}_BEGIN on its own line, then one compact JSON object on one line, then {}_END on its own line. Return exactly the keys defined by resultContract and no additional top-level keys. The JSON must be syntactically valid; JSON-escape every quote and backslash inside string values.\nDo not place any text after the end marker.",
            request.prompt, request.marker, request.marker
        );
        self.run_checked(
            vec![
                "agent".into(),
                "prompt".into(),
                request.agent.identity.clone(),
                transport,
                "--wait".into(),
                "--timeout".into(),
                request.timeout.as_millis().to_string(),
            ],
            &request.cwd,
            request.timeout + Duration::from_secs(5),
            &format!("prompt {}", request.agent.identity),
        )
        .await?;
        let output = self
            .run_checked(
                vec![
                    "agent".into(),
                    "read".into(),
                    request.agent.identity.clone(),
                    "--source".into(),
                    "recent-unwrapped".into(),
                    "--lines".into(),
                    "1000".into(),
                ],
                &request.cwd,
                Duration::from_secs(30),
                &format!("read {}", request.agent.identity),
            )
            .await?;
        response_text(&output)
    }
}

pub fn parse_marked_result<T: DeserializeOwned>(
    transcript: &str,
    marker: &str,
) -> Result<T, RuntimeError> {
    let transcript = transcript
        .lines()
        .map(|line| line.strip_prefix("  ").unwrap_or(line))
        .collect::<String>();
    let begin = format!("{marker}_BEGIN");
    let end = format!("{marker}_END");
    let mut offset = 0;
    let mut last = None;
    while let Some(relative_start) = transcript[offset..].find(&begin) {
        let start = offset + relative_start + begin.len();
        let Some(relative_end) = transcript[start..].find(&end) else {
            break;
        };
        let finish = start + relative_end;
        let candidate = transcript[start..finish].trim();
        if let Ok(value) = serde_json::from_str(candidate) {
            last = Some(value);
        }
        offset = finish + end.len();
    }
    last.ok_or_else(|| RuntimeError::Invalid(MISSING_MARKED_RESULT.into()))
}

#[derive(Debug)]
struct ProcessOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

fn command_error(action: &str, output: ProcessOutput) -> RuntimeError {
    RuntimeError::Command {
        action: action.into(),
        code: output.code,
        detail: if output.stderr.trim().is_empty() {
            output.stdout.trim().into()
        } else {
            output.stderr.trim().into()
        },
    }
}

fn response_string(output: &str, keys: &[&str]) -> Result<Option<String>, RuntimeError> {
    let value: Value =
        serde_json::from_str(output).map_err(|error| RuntimeError::Response(error.to_string()))?;
    Ok(find_string(&value, keys))
}

fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Array(values) => values.iter().find_map(|value| find_string(value, keys)),
        Value::Object(values) => {
            for (key, value) in values {
                if keys.contains(&key.as_str())
                    && let Some(value) = value.as_str()
                {
                    return Some(value.to_owned());
                }
                if let Some(value) = find_string(value, keys) {
                    return Some(value);
                }
            }
            None
        }
        _ => None,
    }
}

fn response_text(output: &str) -> Result<String, RuntimeError> {
    let Ok(value) = serde_json::from_str::<Value>(output) else {
        return Ok(output.to_owned());
    };
    let mut strings = Vec::new();
    collect_strings(&value, &mut strings);
    strings.sort_by_key(|value| std::cmp::Reverse(value.len()));
    Ok(strings.join("\n"))
}

fn collect_strings(value: &Value, target: &mut Vec<String>) {
    match value {
        Value::String(value) => target.push(value.clone()),
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_strings(value, target)),
        Value::Object(values) => values
            .values()
            .for_each(|value| collect_strings(value, target)),
        _ => {}
    }
}

fn response_error_code(output: &str) -> Option<String> {
    serde_json::from_str::<Value>(output)
        .ok()
        .and_then(|value| find_string(&value, &["code"]))
}

fn toml_string(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '"' => encoded.push_str("\\\""),
            '\\' => encoded.push_str("\\\\"),
            character if character.is_control() => {
                encoded.push_str(&format!("\\u{:04X}", character as u32));
            }
            character => encoded.push(character),
        }
    }
    encoded.push('"');
    encoded
}

fn builtin_skill(name: &str) -> Option<&'static str> {
    match name {
        "planner" => Some(include_str!("../skills/planner/SKILL.md")),
        "coder" => Some(include_str!("../skills/coder/SKILL.md")),
        "tester" => Some(include_str!("../skills/tester/SKILL.md")),
        "reviewer" => Some(include_str!("../skills/reviewer/SKILL.md")),
        "integrator" => Some(include_str!("../skills/integrator/SKILL.md")),
        _ => None,
    }
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .expect("current directory")
            .join(path)
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::toml_string;

    #[test]
    fn toml_string_round_trips_without_literal_control_characters() {
        let original = "first line\nsecond\tline\r\u{007f}";
        let encoded = toml_string(original);

        assert!(!encoded.chars().any(char::is_control));
        let parsed = toml::from_str::<toml::Table>(&format!("value = {encoded}")).unwrap();
        assert_eq!(parsed["value"].as_str(), Some(original));
    }
}
