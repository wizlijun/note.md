use notemd_plugin_sdk::{self as sdk, plugin_protocol as proto};
use serde_json::{json, Value};

#[derive(Default)]
pub struct HealthPlugin;

// Native CLI timeouts measure silence. Sorting a multi-year snapshot can take
// longer than one timeout, so keep the host informed even between parser events.
struct Heartbeat {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Heartbeat {
    fn start(host: sdk::Host) -> Self {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::spawn(move || loop {
            std::thread::park_timeout(std::time::Duration::from_secs(20));
            if stopped.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            host.log_info("Health Sync is still processing the export");
        });
        Self {
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

impl sdk::NotemdPlugin for HealthPlugin {
    fn activate(&mut self, _: &sdk::Host, _: &proto::ActivateParams) -> Result<(), String> {
        Ok(())
    }
    fn deactivate(&mut self, _: &sdk::Host) {}
    fn execute_command(
        &mut self,
        host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        if params.command == "open" {
            return Ok(json!({"ok":true}));
        }
        let _heartbeat = Heartbeat::start(host.clone());
        let data = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    crate::cli::run(&params.command, &params.context, &mut |m| host.log_info(m))
                })
                .join()
        })
        .map_err(|_| "Health command worker failed")??;
        if data["complete"].as_bool() == Some(false) {
            Ok(
                json!({"__notemd_cli_result":{"exit_code":4,"data":data,"message":"Health operation has gaps, conflicts or errors; inspect the report"}}),
            )
        } else {
            Ok(data)
        }
    }
    fn on_ui_request(
        &mut self,
        host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        // The host strips plugin. before forwarding ui.request.
        let command = method.strip_prefix("plugin.").unwrap_or(method);
        let _heartbeat = Heartbeat::start(host.clone());
        std::thread::scope(|scope| {
            scope
                .spawn(|| crate::cli::run(command, &params, &mut |m| host.log_info(m)))
                .join()
        })
        .map_err(|_| "Health UI worker failed")?
    }
}
