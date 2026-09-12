use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use clap::{Parser, Subcommand};
use thiserror::Error;
use tokio::process::Command as TokioCommand;

use crate::{
    config::{Config, DEFAULT_CONFIG},
    orchestrator::Orchestrator,
    store::RunStore,
};

#[derive(Debug, Parser)]
#[command(
    name = "lebang",
    version,
    about = "Git-native mixed-agent team orchestration through Herdr"
)]
pub struct Cli {
    #[arg(long, global = true, value_name = "PATH")]
    pub repo: Option<PathBuf>,

    #[arg(long, global = true, value_name = "PATH")]
    pub config: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create .orchestrator/config.toml without overwriting it.
    Init,
    /// Ask the configured planner to create and persist a task DAG.
    Plan { goal: String },
    /// Run ready tasks through coding, testing, and review.
    Run,
    /// Show persisted run and task status.
    Status,
    /// Show one persisted task as JSON.
    Task { id: String },
    /// Retry a stopped task with its recorded owner.
    Retry { id: String },
    /// Refresh test evidence and rerun review for a task.
    Review { id: String },
    /// Integrate approved task commits and validate the repository.
    Integrate,
    /// Recover interrupted orchestration state.
    Resume,
    /// Print the task DAG in DOT format.
    Graph,
    /// Print preserved agent logs for a task.
    Logs { id: String },
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Config(#[from] crate::config::ConfigError),
    #[error(transparent)]
    Orchestrator(#[from] crate::orchestrator::OrchestratorError),
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
    #[error("I/O failed for {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}

pub async fn execute(cli: Cli) -> Result<String, CliError> {
    let cwd = std::env::current_dir().map_err(|source| CliError::Io {
        path: ".".into(),
        source,
    })?;
    let repo = resolve_repo(cli.repo.as_deref().unwrap_or(&cwd)).await?;
    if matches!(cli.command, Command::Init) {
        return initialize(&repo);
    }
    let store = RunStore::new(repo.join(".orchestrator"));
    match &cli.command {
        Command::Status => return print_status(&store),
        Command::Task { id } => {
            let task = store
                .load_plan()?
                .tasks
                .into_iter()
                .find(|task| task.id == *id)
                .ok_or_else(|| CliError::Invalid(format!("unknown task: {id}")))?;
            return Ok(format!(
                "{}\n",
                serde_json::to_string_pretty(&task).expect("task serializes")
            ));
        }
        Command::Graph => return print_graph(&store),
        Command::Logs { id } => return print_logs(&store, id),
        _ => {}
    }

    let config_path = cli
        .config
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .unwrap_or_else(|| repo.join(".orchestrator/config.toml"));
    if !config_path.is_file() {
        return Err(CliError::Invalid(format!(
            "configuration file does not exist: {}; run lebang init first",
            config_path.display()
        )));
    }
    let config = Config::load(&config_path)?;
    let orchestrator = Orchestrator::production(&repo, config);
    let value = match cli.command {
        Command::Plan { goal } => {
            serde_json::to_value(orchestrator.plan_goal(&goal).await?).expect("plan serializes")
        }
        Command::Run => serde_json::to_value(orchestrator.run().await?).expect("result serializes"),
        Command::Retry { id } => {
            orchestrator.retry(&id).await?;
            serde_json::to_value(orchestrator.run().await?).expect("result serializes")
        }
        Command::Review { id } => {
            orchestrator.review_task(&id).await?;
            serde_json::to_value(orchestrator.run().await?).expect("result serializes")
        }
        Command::Integrate => {
            serde_json::to_value(orchestrator.integrate().await?).expect("result serializes")
        }
        Command::Resume => {
            serde_json::to_value(orchestrator.resume().await?).expect("result serializes")
        }
        Command::Init
        | Command::Status
        | Command::Task { .. }
        | Command::Graph
        | Command::Logs { .. } => {
            unreachable!("handled before configuration")
        }
    };
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&value).expect("JSON value")
    ))
}

async fn resolve_repo(path: &Path) -> Result<PathBuf, CliError> {
    let output = TokioCommand::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(path)
        .output()
        .await
        .map_err(|source| CliError::Io {
            path: path.display().to_string(),
            source,
        })?;
    if !output.status.success() {
        return Err(CliError::Invalid(format!(
            "{} is not inside a Git repository",
            path.display()
        )));
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    ))
}

fn initialize(repo: &Path) -> Result<String, CliError> {
    let directory = repo.join(".orchestrator");
    fs::create_dir_all(&directory).map_err(|source| CliError::Io {
        path: directory.display().to_string(),
        source,
    })?;
    let path = directory.join("config.toml");
    if path.exists() {
        if !path.is_file() {
            return Err(CliError::Invalid(format!(
                "configuration path is not a file: {}",
                path.display()
            )));
        }
        return Ok(format!(
            "Configuration already exists: {}\nReview every agent's model, mode, thinking, and validation_commands before running lebang plan.\n",
            path.display()
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|source| CliError::Io {
            path: path.display().to_string(),
            source,
        })?;
    file.write_all(DEFAULT_CONFIG.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|source| CliError::Io {
            path: path.display().to_string(),
            source,
        })?;
    Ok(format!(
        "Created {}\nReview every agent's model, mode, thinking, and validation_commands before running lebang plan.\n",
        path.display()
    ))
}

fn print_status(store: &RunStore) -> Result<String, CliError> {
    let plan = store.load_plan()?;
    let state = store.load_state()?;
    let headers = [
        "ID",
        "TITLE",
        "STATUS",
        "AGENT",
        "DEPENDENCIES",
        "BRANCH",
        "REVIEWS",
        "BLOCKER",
    ];
    let mut rows = Vec::new();
    for task in &plan.tasks {
        rows.push(vec![
            task.id.clone(),
            task.title.clone(),
            task.status.as_str().into(),
            task.assigned_agent.clone().unwrap_or_else(|| "-".into()),
            if task.dependencies.is_empty() {
                "-".into()
            } else {
                task.dependencies.join(",")
            },
            task.branch.clone().unwrap_or_else(|| "-".into()),
            task.review_attempts.to_string(),
            if matches!(
                task.status,
                crate::model::TaskStatus::Blocked
                    | crate::model::TaskStatus::Failed
                    | crate::model::TaskStatus::Interrupted
            ) {
                store
                    .latest_history_reason(&task.id)?
                    .unwrap_or_else(|| "-".into())
            } else {
                "-".into()
            },
        ]);
    }
    let widths = headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            rows.iter()
                .map(|row| row[index].len())
                .max()
                .unwrap_or(0)
                .max(header.len())
        })
        .collect::<Vec<_>>();
    let render = |row: &[String]| {
        row.iter()
            .enumerate()
            .map(|(index, value)| format!("{value:<width$}", width = widths[index]))
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = vec![
        format!("run={} status={:?}", state.run_id, state.status).to_lowercase(),
        render(
            &headers
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>(),
        ),
    ];
    lines.extend(rows.iter().map(|row| render(row)));
    let mut counts = BTreeMap::new();
    for task in &plan.tasks {
        *counts.entry(task.status.as_str()).or_insert(0usize) += 1;
    }
    lines.push(format!(
        "summary {}",
        counts
            .into_iter()
            .map(|(status, count)| format!("{status}={count}"))
            .collect::<Vec<_>>()
            .join(" ")
    ));
    Ok(format!("{}\n", lines.join("\n")))
}

fn print_graph(store: &RunStore) -> Result<String, CliError> {
    let mut lines = vec!["digraph tasks {".to_owned()];
    for task in store.load_plan()?.tasks {
        let title = task.title.replace('"', "\\\"");
        lines.push(format!(
            "  \"{}\" [label=\"{}: {}\\n{}\"];",
            task.id,
            task.id,
            title,
            task.status.as_str()
        ));
        for dependency in task.dependencies {
            lines.push(format!("  \"{dependency}\" -> \"{}\";", task.id));
        }
    }
    lines.push("}".into());
    Ok(format!("{}\n", lines.join("\n")))
}

fn print_logs(store: &RunStore, task_id: &str) -> Result<String, CliError> {
    if !store.logs_dir.is_dir() {
        return Err(CliError::Invalid(format!(
            "no logs found for task {task_id}"
        )));
    }
    let mut paths = fs::read_dir(&store.logs_dir)
        .map_err(|source| CliError::Io {
            path: store.logs_dir.display().to_string(),
            source,
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{task_id}-")) && name.ends_with(".log")
                })
        })
        .collect::<Vec<_>>();
    paths.sort();
    if paths.is_empty() {
        return Err(CliError::Invalid(format!(
            "no logs found for task {task_id}"
        )));
    }
    let mut output = String::new();
    for path in paths {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("log");
        let content = fs::read_to_string(&path).map_err(|source| CliError::Io {
            path: path.display().to_string(),
            source,
        })?;
        output.push_str(&format!("== {name} ==\n{content}"));
    }
    Ok(output)
}
