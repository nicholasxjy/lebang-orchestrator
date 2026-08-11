use lebang_orchestrator::{
    config::Config,
    runtime::{AgentRuntime, HerdrRuntime},
};

#[tokio::test]
#[ignore = "opt-in: creates the configured team in the current Herdr tab"]
async fn bootstraps_a_real_current_tab_team() {
    if std::env::var("LEBANG_REAL_HERDR_SMOKE").as_deref() != Ok("1") {
        eprintln!("set LEBANG_REAL_HERDR_SMOKE=1 to run this opt-in test");
        return;
    }
    assert_eq!(std::env::var("HERDR_ENV").as_deref(), Ok("1"));
    let repo = std::env::var("LEBANG_REAL_HERDR_REPO")
        .expect("set LEBANG_REAL_HERDR_REPO to an initialized Git repository");
    let config = Config::load(
        std::path::Path::new(&repo)
            .join(".orchestrator/config.toml")
            .as_ref(),
    )
    .expect("load smoke-test configuration");
    let expected = config.agents.len();
    let layout = HerdrRuntime::new(&repo, config)
        .bootstrap()
        .await
        .expect("bootstrap real Herdr team");
    assert_eq!(layout.agents.len(), expected);
    assert_eq!(layout.repo_root, repo);
}
