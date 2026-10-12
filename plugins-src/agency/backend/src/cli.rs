//! The CLI host is temporary. Hand the queue to this binary in a new session,
//! and return only after the runner has acquired the shared lock and saved its job.
use crate::{bridge::AgencyHost, plugin::AgencyPlugin};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn flag<'a>(context: &'a Value, key: &str) -> Option<&'a str> {
    context
        .get("cli")
        .and_then(|v| v.get("flags"))
        .and_then(|v| v.get(key))
        .or_else(|| context.get(key))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

pub(crate) fn options(context: &Value) -> Result<(String, String, String), String> {
    let date = flag(context, "date");
    let from = flag(context, "from");
    let to = flag(context, "to");
    let (start, end) = match (date, from, to) {
        (Some(date), None, None) => (date, date),
        (None, Some(start), Some(end)) => (start, end),
        _ => {
            return Err(
                "请使用 --date YYYY-MM-DD，或同时提供 --from 和 --to；两种方式不能混用".into(),
            )
        }
    };
    crate::plugin::date_range(start, end)?;
    let harness = match flag(context, "agent").unwrap_or("codex") {
        "codex" | "notemd.codex-agent" => "notemd.codex-agent",
        "claude" | "notemd.claude-agent" => "notemd.claude-agent",
        "deepseek" | "notemd.deepseek-agent" => "notemd.deepseek-agent",
        _ => return Err("--agent 支持 codex、claude 或 deepseek".into()),
    };
    Ok((start.into(), end.into(), harness.into()))
}

pub(crate) fn spawn(root: &Path, context: &Value) -> Result<Value, String> {
    let (start, end, harness) = options(context)?;
    spawn_with(
        &std::env::current_exe().map_err(|e| e.to_string())?,
        root,
        &start,
        &end,
        &harness,
    )
}

fn spawn_with(
    exe: &Path,
    root: &Path,
    start: &str,
    end: &str,
    harness: &str,
) -> Result<Value, String> {
    let handoff = tempfile::tempdir().map_err(|e| e.to_string())?;
    let receipt = handoff.path().join("started.json");
    let mut command = Command::new(exe);
    command
        .arg("--queue-runner")
        .arg(root)
        .arg(start)
        .arg(end)
        .arg(harness)
        .arg(&receipt)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Agency 后台队列：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(bytes) = std::fs::read(&receipt) {
            if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    let _ = child.wait();
                    return Err(error.into());
                }
                value["runner_pid"] = json!(child.id());
                value["background"] = json!(true);
                return Ok(value);
            }
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            // It may have published the atomic acknowledgement between our read
            // and this exit check (a rejected duplicate exits especially fast).
            if std::fs::read(&receipt)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some()
            {
                continue;
            }
            return Err("Agency 后台启动失败，尚未确认任务；请查询 status".into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Agency 后台启动超时，尚未确认任务；请查询 status".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Runs on a current-thread runtime: no worker can start a model before the
/// durable startup acknowledgement has been written.
pub(crate) async fn run(args: &[String]) -> Result<(), String> {
    if args.len() != 6 {
        return Err("invalid queue runner arguments".into());
    }
    let root = Path::new(&args[1])
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let receipt = Path::new(&args[5]);
    let host = AgencyHost::standalone(&root, &args[4]).await?;
    let mut plugin = AgencyPlugin::new();
    let started = plugin.start_range(
        &host,
        root.clone(),
        args[2].clone(),
        args[3].clone(),
        args[4].clone(),
    );
    let acknowledgement = match &started {
        Ok(job) => job.clone(),
        Err(error) => json!({"error":error}),
    };
    let mut file = tempfile::NamedTempFile::new_in(receipt.parent().ok_or("invalid receipt")?)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&acknowledgement).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.persist(receipt).map_err(|e| e.to_string())?;
    started?;
    let completion = async {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let job = plugin.current_job(&root)?.ok_or("后台队列回执丢失")?;
            if job.state != "running" {
                return if job.state == "done" {
                    Ok(())
                } else {
                    Err(format!(
                        "Agency 队列结束：{}；请查询 status 查看逐日结果",
                        job.state
                    ))
                };
            }
        }
    }
    .await;
    // Always allow the provider to terminate its model process group, including
    // an I/O error while reading the durable queue receipt.
    host.close().await;
    completion
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_day_and_range_cli_envelopes() {
        let (start, end, agent) = options(&json!({"cli":{"flags":{"date":"2026-09-22"}}})).unwrap();
        assert_eq!(start, end);
        assert_eq!(agent, "notemd.codex-agent");
        let (start, end, agent) =
            options(&json!({"from":"2026-09-20","to":"2026-09-22","agent":"deepseek"})).unwrap();
        assert_eq!(
            (start.as_str(), end.as_str(), agent.as_str()),
            ("2026-09-20", "2026-09-22", "notemd.deepseek-agent")
        );
    }

    #[test]
    fn rejects_ambiguous_missing_and_invalid_dates_before_spawn() {
        for input in [
            json!({}),
            json!({"from":"2026-09-20"}),
            json!({"date":"2026-09-20","from":"2026-09-20","to":"2026-09-21"}),
            json!({"date":"2026-02-30"}),
            json!({"from":"2026-09-22","to":"2026-09-20"}),
            json!({"from":"2026-09-01","to":"2026-10-02"}),
            json!({"date":"2026-09-20","agent":"other"}),
        ] {
            assert!(options(&input).is_err(), "{input}");
        }
    }

    #[test]
    fn executable_exit_without_ack_is_not_reported_as_started() {
        let temp = tempfile::tempdir().unwrap();
        assert!(spawn_with(
            Path::new("/usr/bin/true"),
            temp.path(),
            "2026-09-20",
            "2026-09-20",
            "notemd.codex-agent"
        )
        .is_err());
    }
}
