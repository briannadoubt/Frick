//! The `frick` CLI binary (FR-252). Command surface lands as the rewrite
//! progresses; `--version` works today so packaging can be wired early.

use clap::Parser;

#[derive(Parser)]
#[command(name = "frick", version, about = "Frick fullstack realtime framework")]
struct Cli {}

fn main() {
    let _cli = Cli::parse();
    println!("frick (Rust) — rewrite in progress; see scope epic FR-236");
}
