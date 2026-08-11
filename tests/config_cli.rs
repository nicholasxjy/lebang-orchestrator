use clap::Parser;
use lebang_orchestrator::{
    cli::{Cli, Command},
    config::{Config, DEFAULT_CONFIG},
};

#[test]
fn global_paths_are_accepted_after_subcommands() {
    let cli = Cli::try_parse_from([
        "lebang",
        "status",
        "--repo",
        "/tmp/project",
        "--config",
        "/tmp/team.toml",
    ])
    .expect("global options after a subcommand should parse");

    assert_eq!(cli.repo.unwrap().to_str(), Some("/tmp/project"));
    assert_eq!(cli.config.unwrap().to_str(), Some("/tmp/team.toml"));
    assert!(matches!(cli.command, Command::Status));
}

#[test]
fn embedded_toml_declares_exactly_one_singleton_and_a_coder() {
    let config = Config::parse(DEFAULT_CONFIG).expect("embedded config must be valid");

    assert_eq!(config.agent_for_role("planner").unwrap().identity, "lebang");
    assert_eq!(
        config.agent_for_role("tester").unwrap().identity,
        "westbrook"
    );
    assert_eq!(config.agent_for_role("reviewer").unwrap().identity, "curry");
    assert_eq!(
        config.agent_for_role("integrator").unwrap().identity,
        "duncan"
    );
    assert_eq!(config.coders().len(), 1);
    assert_eq!(config.coders()[0].identity, "kd");
}

#[test]
fn toml_rejects_invalid_rosters_identities_and_codex_settings() {
    let no_coder = DEFAULT_CONFIG.replace("role = \"coder\"", "role = \"reviewer\"");
    assert!(
        Config::parse(&no_coder)
            .unwrap_err()
            .to_string()
            .contains("coder")
    );

    let bad_identity = DEFAULT_CONFIG.replace("[agents.kd]", "[agents.Bad_Agent]");
    assert!(
        Config::parse(&bad_identity)
            .unwrap_err()
            .to_string()
            .contains("must match")
    );

    let non_codex = DEFAULT_CONFIG.replacen("agent = \"codex\"", "agent = \"pi\"", 1);
    assert!(
        Config::parse(&non_codex)
            .unwrap_err()
            .to_string()
            .contains("agent")
    );

    let bad_mode = DEFAULT_CONFIG.replacen("mode = \"plan\"", "mode = \"chat\"", 1);
    assert!(
        Config::parse(&bad_mode)
            .unwrap_err()
            .to_string()
            .contains("mode")
    );

    let bad_thinking = DEFAULT_CONFIG.replacen("thinking = \"high\"", "thinking = \"max\"", 1);
    assert!(
        Config::parse(&bad_thinking)
            .unwrap_err()
            .to_string()
            .contains("thinking")
    );
}

#[test]
fn clap_exposes_the_complete_command_surface() {
    for args in [
        vec!["lebang", "init"],
        vec!["lebang", "plan", "goal"],
        vec!["lebang", "run"],
        vec!["lebang", "status"],
        vec!["lebang", "task", "T1"],
        vec!["lebang", "retry", "T1"],
        vec!["lebang", "review", "T1"],
        vec!["lebang", "integrate"],
        vec!["lebang", "resume"],
        vec!["lebang", "graph"],
        vec!["lebang", "logs", "T1"],
    ] {
        Cli::try_parse_from(args).unwrap();
    }
}
