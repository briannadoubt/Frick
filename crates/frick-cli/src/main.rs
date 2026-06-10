//! The `frick` CLI binary (FR-252). Thin wrapper: parse argv, drive
//! [`frick_cli::run`], map the returned exit code onto `process::exit`.

use std::io::{self, Write};

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut stdout_lock = stdout.lock();
    let mut stderr_lock = stderr.lock();
    let code = frick_cli::run(&argv, &mut stdout_lock, &mut stderr_lock).await;
    let _ = stdout_lock.flush();
    let _ = stderr_lock.flush();
    std::process::exit(code);
}
