use std::{collections::BTreeMap, path::Path};

use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_CONFIG: &str = include_str!("../.orchestrator/config.toml");

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("configuration failed validation: {0}")]
    Invalid(String),
    #[error("cannot load configuration from {path}: {source}")]
    Load {
        path: String,
        source: std::io::Error,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Planner,
    Coder,
    Tester,
    Reviewer,
    Integrator,
}

impl Role {
    pub const SINGLETONS: [Self; 4] = [
        Self::Planner,
        Self::Tester,
        Self::Reviewer,
        Self::Integrator,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::Coder => "coder",
            Self::Tester => "tester",
            Self::Reviewer => "reviewer",
            Self::Integrator => "integrator",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Codex,
    Claude,
    OpenCode,
    Pi,
    Gemini,
}

impl AgentKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
            Self::Gemini => "gemini",
        }
    }

    pub const fn exit_command(self) -> &'static str {
        match self {
            Self::Claude | Self::OpenCode => "/exit",
            Self::Codex | Self::Pi | Self::Gemini => "/quit",
        }
    }

    pub const fn supports_thinking(self, thinking: Thinking) -> bool {
        use Thinking as T;
        match self {
            Self::Codex => !matches!(thinking, T::Off | T::Max),
            Self::Claude => !matches!(thinking, T::Off | T::Minimal),
            Self::Pi => true,
            Self::OpenCode => !matches!(thinking, T::Off | T::Max),
            Self::Gemini => matches!(thinking, T::Default),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Build,
    Plan,
}

impl AgentMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Plan => "plan",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Thinking {
    #[default]
    Default,
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Thinking {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HerdrConfig {
    pub command: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct RawAgentConfig {
    role: Role,
    agent: AgentKind,
    model: String,
    mode: AgentMode,
    #[serde(default)]
    thinking: Thinking,
    skill: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub identity: String,
    pub role: Role,
    pub agent: AgentKind,
    pub model: String,
    pub mode: AgentMode,
    pub thinking: Thinking,
    pub skill: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    max_workers: usize,
    max_review_attempts: u32,
    #[serde(default = "default_timeout_seconds")]
    agent_timeout_seconds: u32,
    #[serde(default = "default_timeout_seconds")]
    validation_timeout_seconds: u32,
    validation_commands: Vec<Vec<String>>,
    herdr: HerdrConfig,
    agents: BTreeMap<String, RawAgentConfig>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub max_workers: usize,
    pub max_review_attempts: u32,
    pub agent_timeout_seconds: u32,
    pub validation_timeout_seconds: u32,
    pub validation_commands: Vec<Vec<String>>,
    pub herdr: HerdrConfig,
    pub agents: BTreeMap<String, AgentConfig>,
}

fn default_timeout_seconds() -> u32 {
    3600
}

impl Config {
    pub fn parse(input: &str) -> Result<Self, ConfigError> {
        let raw: RawConfig =
            toml::from_str(input).map_err(|error| ConfigError::Invalid(error.to_string()))?;
        Self::from_raw(raw)
    }

    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let input = std::fs::read_to_string(path).map_err(|source| ConfigError::Load {
            path: path.display().to_string(),
            source,
        })?;
        Self::parse(&input)
    }

    fn from_raw(raw: RawConfig) -> Result<Self, ConfigError> {
        if raw.agent_timeout_seconds == 0 || raw.validation_timeout_seconds == 0 {
            return Err(ConfigError::Invalid(
                "agent_timeout_seconds and validation_timeout_seconds must be at least 1".into(),
            ));
        }
        if raw.max_workers == 0 {
            return Err(ConfigError::Invalid(
                "max_workers must be at least 1".into(),
            ));
        }
        if raw.max_review_attempts == 0 {
            return Err(ConfigError::Invalid(
                "max_review_attempts must be at least 1".into(),
            ));
        }
        if raw.validation_commands.is_empty()
            || raw
                .validation_commands
                .iter()
                .any(|command| command.is_empty() || command.iter().any(|part| part.is_empty()))
        {
            return Err(ConfigError::Invalid(
                "validation_commands must contain at least one non-empty command".into(),
            ));
        }
        if raw.herdr.command.trim().is_empty() {
            return Err(ConfigError::Invalid(
                "herdr.command must not be empty".into(),
            ));
        }

        let identity_pattern = Regex::new(r"^[a-z][a-z0-9_-]{0,31}$").expect("valid regex");
        let mut agents = BTreeMap::new();
        for (identity, agent) in raw.agents {
            if !identity_pattern.is_match(&identity) {
                return Err(ConfigError::Invalid(format!(
                    "agent identity {identity} must match [a-z][a-z0-9_-]{{0,31}} for Herdr"
                )));
            }
            if agent.model.trim().is_empty() || agent.skill.trim().is_empty() {
                return Err(ConfigError::Invalid(format!(
                    "agent {identity} model and skill must not be empty"
                )));
            }
            if !identity_pattern.is_match(&agent.skill) {
                return Err(ConfigError::Invalid(format!(
                    "agent {identity} skill must be a safe skill name"
                )));
            }
            if !agent.agent.supports_thinking(agent.thinking) {
                return Err(ConfigError::Invalid(format!(
                    "agent {identity}: thinking {} is not supported by {}",
                    agent.thinking.as_str(),
                    agent.agent.as_str()
                )));
            }
            if agent.agent == AgentKind::OpenCode
                && !agent
                    .model
                    .split_once('/')
                    .is_some_and(|(provider, model)| {
                        !provider.trim().is_empty() && !model.trim().is_empty()
                    })
            {
                return Err(ConfigError::Invalid(format!(
                    "agent {identity}: opencode model must use provider/model format"
                )));
            }
            agents.insert(
                identity.clone(),
                AgentConfig {
                    identity,
                    role: agent.role,
                    agent: agent.agent,
                    model: agent.model,
                    mode: agent.mode,
                    thinking: agent.thinking,
                    skill: agent.skill,
                },
            );
        }

        let coder_count = agents
            .values()
            .filter(|agent| agent.role == Role::Coder)
            .count();
        if coder_count == 0 {
            return Err(ConfigError::Invalid(
                "expected at least one configured coder".into(),
            ));
        }
        for role in Role::SINGLETONS {
            let count = agents.values().filter(|agent| agent.role == role).count();
            if count != 1 {
                return Err(ConfigError::Invalid(format!(
                    "expected exactly one configured {}, found {count}",
                    role.as_str()
                )));
            }
        }

        Ok(Self {
            max_workers: raw.max_workers,
            max_review_attempts: raw.max_review_attempts,
            agent_timeout_seconds: raw.agent_timeout_seconds,
            validation_timeout_seconds: raw.validation_timeout_seconds,
            validation_commands: raw.validation_commands,
            herdr: raw.herdr,
            agents,
        })
    }

    pub fn agent_for_role(&self, role: &str) -> Result<&AgentConfig, ConfigError> {
        let mut matches = self
            .agents
            .values()
            .filter(|agent| agent.role.as_str() == role);
        let first = matches.next().ok_or_else(|| {
            ConfigError::Invalid(format!("expected exactly one configured {role}, found 0"))
        })?;
        if matches.next().is_some() {
            return Err(ConfigError::Invalid(format!(
                "expected exactly one configured {role}, found multiple"
            )));
        }
        Ok(first)
    }

    pub fn coders(&self) -> Vec<&AgentConfig> {
        self.agents
            .values()
            .filter(|agent| agent.role == Role::Coder)
            .collect()
    }
}
