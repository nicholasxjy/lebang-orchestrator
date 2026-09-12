use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    config::{AgentConfig, AgentKind, Role, Thinking},
    runtime::RuntimeError,
    store::RunStore,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub(crate) enum NativeSession {
    Id(String),
    Path(String),
}

pub(crate) struct AgentLaunch {
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

pub(crate) fn prepare(
    agent: &AgentConfig,
    cwd: &Path,
    git_dir: &Path,
    store: &RunStore,
    instructions: &str,
    session: Option<&NativeSession>,
    environment: &BTreeMap<String, String>,
) -> Result<AgentLaunch, RuntimeError> {
    let writable = matches!(agent.role, Role::Coder | Role::Tester);
    let mut launch = AgentLaunch {
        arguments: Vec::new(),
        environment: BTreeMap::new(),
    };
    let args = &mut launch.arguments;
    match agent.agent {
        AgentKind::Codex => {
            if let Some(NativeSession::Id(id)) = session {
                args.extend(["resume".into(), id.clone()]);
            }
            args.extend([
                "--model".into(),
                agent.model.clone(),
                "--cd".into(),
                path(cwd),
                "--no-alt-screen".into(),
                "--sandbox".into(),
                if writable {
                    "workspace-write".into()
                } else {
                    "read-only".into()
                },
                "--ask-for-approval".into(),
                "never".into(),
            ]);
            if writable {
                args.extend(["--add-dir".into(), path(git_dir)]);
            }
            if agent.thinking != Thinking::Default {
                args.extend([
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
                ]);
            }
            args.extend([
                "-c".into(),
                format!("developer_instructions={}", toml_string(instructions)),
            ]);
        }
        AgentKind::Claude => {
            let prompt = write_prompt(store, agent, instructions)?;
            if let Some(NativeSession::Id(id)) = session {
                args.extend(["--resume".into(), id.clone()]);
            }
            let tools = if writable {
                "Bash,Edit,Write,Read,Glob,Grep"
            } else {
                "Read,Glob,Grep"
            };
            args.extend([
                "--model".into(),
                agent.model.clone(),
                "--append-system-prompt-file".into(),
                prompt,
                "--permission-mode".into(),
                "dontAsk".into(),
                "--tools".into(),
                tools.into(),
                "--allowedTools".into(),
                tools.into(),
                "--disallowedTools".into(),
                "mcp__*".into(),
            ]);
            if agent.thinking != Thinking::Default {
                args.extend(["--effort".into(), agent.thinking.as_str().into()]);
            }
            if writable {
                args.extend(["--add-dir".into(), path(git_dir)]);
            }
        }
        AgentKind::Pi => {
            let prompt = write_prompt(store, agent, instructions)?;
            if let Some(NativeSession::Id(id) | NativeSession::Path(id)) = session {
                args.extend(["--session".into(), id.clone()]);
            }
            args.extend([
                "--model".into(),
                agent.model.clone(),
                "--append-system-prompt".into(),
                prompt,
                "--tools".into(),
                if writable {
                    "read,bash,edit,write,grep,find,ls".into()
                } else {
                    "read,grep,find,ls".into()
                },
                "--approve".into(),
            ]);
            if agent.thinking != Thinking::Default {
                args.extend(["--thinking".into(), agent.thinking.as_str().into()]);
            }
        }
        AgentKind::OpenCode => {
            let name = format!("lebang-{}", agent.identity);
            let mut permissions =
                json!({"*":"deny", "read":"allow", "glob":"allow", "grep":"allow", "list":"allow"});
            if writable {
                permissions["edit"] = json!("allow");
                permissions["bash"] = json!("allow");
                permissions["external_directory"] =
                    json!({format!("{}/**", path(git_dir)):"allow"});
            }
            let mut member = json!({"description":format!("Lebang {}", agent.role.as_str()),
                "mode":"primary", "model":agent.model, "prompt":instructions, "permission":permissions});
            if agent.thinking != Thinking::Default {
                member["reasoningEffort"] = json!(agent.thinking.as_str());
            }
            let overlay = json!({"agent":{&name:member.clone()}});
            let config_path = store
                .root
                .join("agent-config")
                .join(format!("{}.opencode.json", agent.identity));
            store.write_json(&config_path, &overlay)?;
            // Preserve any provider configuration supplied by the launching shell.
            let mut config: Value = match environment.get("OPENCODE_CONFIG_CONTENT") {
                Some(value) => serde_json::from_str(value).map_err(|_| {
                    RuntimeError::Invalid("OPENCODE_CONFIG_CONTENT must contain valid JSON".into())
                })?,
                None => json!({}),
            };
            let object = config.as_object_mut().ok_or_else(|| {
                RuntimeError::Invalid("OPENCODE_CONFIG_CONTENT must be an object".into())
            })?;
            let agents = object
                .entry("agent")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| {
                    RuntimeError::Invalid("OpenCode agent configuration must be an object".into())
                })?;
            agents.insert(name.clone(), member);
            launch
                .environment
                .insert("OPENCODE_CONFIG_CONTENT".into(), config.to_string());
            args.extend([
                path(cwd),
                "--model".into(),
                agent.model.clone(),
                "--agent".into(),
                name,
            ]);
            if let Some(NativeSession::Id(id)) = session {
                args.extend(["--session".into(), id.clone()]);
            }
        }
        AgentKind::Gemini => {
            let policy = store
                .root
                .join("agent-config")
                .join(format!("{}.gemini.toml", agent.identity));
            std::fs::create_dir_all(policy.parent().expect("policy parent"))?;
            let mut tools = vec![
                "read_file",
                "read_many_files",
                "list_directory",
                "glob",
                "grep_search",
            ];
            if writable {
                tools.extend(["run_shell_command", "write_file", "replace"]);
            }
            let policy_value = json!({"rule":[
                {"toolName":"*", "decision":"deny", "priority":998},
                {"toolName":tools, "decision":"allow", "priority":999}
            ]});
            std::fs::write(
                &policy,
                toml::to_string(&policy_value).map_err(|e| RuntimeError::Invalid(e.to_string()))?,
            )?;
            args.extend([
                "--model".into(),
                agent.model.clone(),
                "--approval-mode".into(),
                "default".into(),
                "--policy".into(),
                path(&policy),
                "--skip-trust".into(),
            ]);
            if writable {
                args.extend(["--include-directories".into(), path(git_dir)]);
            }
            match session {
                Some(NativeSession::Id(id)) => args.extend(["--resume".into(), id.clone()]),
                Some(NativeSession::Path(file)) => {
                    args.extend(["--session-file".into(), file.clone()])
                }
                None => {}
            }
        }
    }
    Ok(launch)
}

fn write_prompt(
    store: &RunStore,
    agent: &AgentConfig,
    instructions: &str,
) -> Result<String, RuntimeError> {
    let prompt = store
        .root
        .join("agent-prompts")
        .join(format!("{}.txt", agent.identity));
    std::fs::create_dir_all(prompt.parent().expect("prompt parent"))?;
    std::fs::write(&prompt, instructions)?;
    Ok(path(&prompt))
}

fn path(value: &Path) -> String {
    value.to_string_lossy().into_owned()
}

fn toml_string(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '"' => encoded.push_str("\\\""),
            '\\' => encoded.push_str("\\\\"),
            character if character.is_control() => {
                encoded.push_str(&format!("\\u{:04X}", character as u32))
            }
            character => encoded.push(character),
        }
    }
    encoded.push('"');
    encoded
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
