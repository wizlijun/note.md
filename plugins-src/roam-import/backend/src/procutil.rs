//! Shared child-process helper: concurrently drain both output pipes and
//! poll `try_wait` under one deadline; kill and reap on timeout. Every
//! subprocess this crate spawns — `roam
//! --version`/`roam list-graphs` (`roam_cli::run`), and the login-shell
//! `command -v roam` lookup (`discover::shell_lookup`) — goes through this,
//! so none of them can block the plugin's protocol read loop past its
//! budget: `on_ui_request` runs `roam_cli::probe` synchronously on that
//! loop (see plugin.rs), and the host's default `ui.request` timeout is 30s.
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn nonblocking(pipe: &impl AsRawFd) -> io::Result<()> {
    // SAFETY: the pipe owns this live fd throughout both fcntl calls. Only
    // the read end is changed; the child's write end remains blocking.
    let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Drain a bounded batch so a continuously busy pipe cannot starve the other
/// pipe or the deadline. Returns true only at EOF.
fn drain(pipe: &mut impl Read, output: &mut Vec<u8>) -> io::Result<bool> {
    let mut buffer = [0; 8192];
    for _ in 0..32 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(n) => output.extend_from_slice(&buffer[..n]),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

pub fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    let program = cmd.get_program().to_string_lossy().to_string();
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {program}: {e}"))?;
    let deadline = Instant::now() + timeout;
    let result = (|| {
        let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
        let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
        nonblocking(&stdout_pipe).map_err(|e| e.to_string())?;
        nonblocking(&stderr_pipe).map_err(|e| e.to_string())?;
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let (mut stdout_done, mut stderr_done) = (false, false);
        let mut status = None;
        loop {
            if Instant::now() >= deadline {
                return Err(format!("{program} timed out after {}s", timeout.as_secs()));
            }
            let before = stdout.len() + stderr.len();
            if !stdout_done {
                stdout_done = drain(&mut stdout_pipe, &mut stdout).map_err(|e| e.to_string())?;
            }
            if !stderr_done {
                stderr_done = drain(&mut stderr_pipe, &mut stderr).map_err(|e| e.to_string())?;
            }
            if status.is_none() {
                status = child.try_wait().map_err(|e| e.to_string())?;
            }
            if stdout_done && stderr_done {
                if let Some(status) = status {
                    return Ok(Output {
                        status,
                        stdout,
                        stderr,
                    });
                }
            }
            // Keep collecting until both EOFs, even if the child exited. A
            // descendant holding a pipe open is still bounded by the deadline.
            if stdout.len() + stderr.len() == before {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
    })();
    if let Err(mut error) = result {
        // Also reap after I/O/poll errors. kill may race with a natural exit;
        // wait is required in either case. Pipes have already been dropped.
        let _ = child.kill();
        if let Err(e) = child.wait() {
            error.push_str(&format!("; cannot reap {program}: {e}"));
        }
        return Err(error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_output_of_a_fast_command() {
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("hi");
        let out = run_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[test]
    fn kills_and_errors_on_timeout() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        let started = Instant::now();
        let err = run_with_timeout(cmd, Duration::from_millis(150)).unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "must not block for anywhere near the child's own 5s sleep"
        );
    }
}
