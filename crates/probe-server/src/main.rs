//! `probe-server --listen 127.0.0.1:0 [--exit-on-stdin-eof]`

use std::net::SocketAddr;

use clap::Parser;
use tokio::io::AsyncReadExt as _;

#[derive(Parser)]
struct Args {
    /// Address to listen on; port 0 lets the OS choose.
    #[arg(long, default_value = "127.0.0.1:4000")]
    listen: SocketAddr,
    /// Exit when stdin reaches EOF, so the server never outlives the harness that spawned it.
    #[arg(long)]
    exit_on_stdin_eof: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();
    let args = Args::parse();
    let running = probe_server::start(args.listen).await?;
    // Readiness line: harnesses read it instead of polling. The socket is already listening.
    println!("LISTENING {}", running.base_url());
    if args.exit_on_stdin_eof {
        let mut sink = Vec::new();
        drop(tokio::io::stdin().read_to_end(&mut sink).await);
    } else {
        tokio::signal::ctrl_c().await?;
    }
    tracing::info!("stopping");
    running.stop().await?;
    Ok(())
}
