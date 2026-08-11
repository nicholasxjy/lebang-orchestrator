use clap::Parser;

#[tokio::main]
async fn main() {
    let cli = lebang_orchestrator::cli::Cli::parse();
    match lebang_orchestrator::cli::execute(cli).await {
        Ok(output) => print!("{output}"),
        Err(error) => {
            eprintln!("lebang: {error}");
            std::process::exit(2);
        }
    }
}
