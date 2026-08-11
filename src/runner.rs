use std::{path::Path, sync::Arc, time::Duration};

use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    config::AgentConfig,
    model::{AgentRunRecord, StructuredResult},
    runtime::{AgentInvocation, AgentRuntime, RuntimeError, parse_marked_result},
    store::{RunStore, StoreError, utc_now},
};

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("agent run failed: {detail}; run record: {record}")]
    Failed { detail: String, record: String },
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Clone, Debug)]
pub struct AgentRunRequest {
    pub agent: AgentConfig,
    pub task_id: String,
    pub cwd: std::path::PathBuf,
    pub prompt: String,
    pub state_transition: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AgentRunArtifact {
    pub run_id: String,
    pub record_path: std::path::PathBuf,
    pub log_path: std::path::PathBuf,
}

#[derive(Clone)]
pub struct AgentRunner {
    pub repo_root: std::path::PathBuf,
    pub store: RunStore,
    runtime: Arc<dyn AgentRuntime>,
    timeout: Duration,
}

impl AgentRunner {
    pub fn new(
        repo_root: impl AsRef<Path>,
        store: RunStore,
        runtime: Arc<dyn AgentRuntime>,
    ) -> Self {
        Self {
            repo_root: repo_root.as_ref().to_path_buf(),
            store,
            runtime,
            timeout: Duration::from_secs(3600),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn run<T: StructuredResult>(
        &self,
        request: AgentRunRequest,
    ) -> Result<(T, AgentRunArtifact), RunnerError> {
        let run_id = Uuid::new_v4().simple().to_string();
        let marker = format!("LEBANG_RESULT_{}", run_id.to_uppercase());
        let start_time = utc_now();
        let mut stdout = String::new();
        let mut stderr = String::new();
        let result = match self
            .runtime
            .invoke(AgentInvocation {
                agent: request.agent.clone(),
                cwd: request.cwd.clone(),
                prompt: request.prompt,
                marker: marker.clone(),
                timeout: self.timeout,
            })
            .await
        {
            Ok(transcript) => {
                stdout = transcript;
                match parse_marked_result::<T>(&stdout, &marker) {
                    Ok(value) => match value.validate_result() {
                        Ok(()) => Some(value),
                        Err(error) => {
                            stderr = error.to_string();
                            None
                        }
                    },
                    Err(error) => {
                        stderr = error.to_string();
                        None
                    }
                }
            }
            Err(error) => {
                stderr = error.to_string();
                None
            }
        };
        let structured_result = result
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .expect("structured result serializes");
        let record = AgentRunRecord {
            run_id: run_id.clone(),
            task_id: request.task_id.clone(),
            agent: request.agent.identity.clone(),
            role: request.agent.role.as_str().into(),
            model: request.agent.model.clone(),
            cwd: request.cwd.display().to_string(),
            start_time,
            end_time: utc_now(),
            exit_code: if result.is_some() { 0 } else { 1 },
            stdout: stdout.clone(),
            stderr: stderr.clone(),
            structured_result,
            state_transition: request.state_transition,
        };
        let record_path = self.store.write_result(
            &request.task_id,
            request.agent.role.as_str(),
            &run_id,
            &record,
        )?;
        let log_path = self.store.write_log(
            &format!(
                "{}-{}-{run_id}.log",
                request.task_id, request.agent.identity
            ),
            &format_log(&record),
        )?;
        let artifact = AgentRunArtifact {
            run_id,
            record_path,
            log_path,
        };
        match result {
            Some(value) => Ok((value, artifact)),
            None => Err(RunnerError::Failed {
                detail: stderr,
                record: artifact.record_path.display().to_string(),
            }),
        }
    }
}

fn format_log(record: &AgentRunRecord) -> String {
    let mut metadata = serde_json::to_value(record).expect("run record serializes");
    if let Value::Object(object) = &mut metadata {
        object.remove("stdout");
        object.remove("stderr");
    }
    format!(
        "{}\n--- Herdr transcript ---\n{}\n--- stderr ---\n{}\n",
        serde_json::to_string_pretty(&metadata).expect("JSON value"),
        record.stdout,
        record.stderr
    )
}
