//! pos-log v2 plugin entry point.
//! 线程分工：主线程 = CoreLocation 服务（CLGeocoder 完成块落主队列，见
//! location.rs 模块注释）；SDK serve 循环跑在副线程的 tokio runtime 上。
//! serve 结束（宿主关管道 / $deactivate）→ fetch_tx 随 plugin 一起 drop →
//! service_loop 的 recv() Err → 主线程退出，进程干净收尾。
mod location;
mod logbook;
mod plugin;

fn main() {
    let (fetch_tx, fetch_rx) = std::sync::mpsc::channel::<location::FetchJob>();
    let serve = std::thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(notemd_plugin_sdk::serve(plugin::PosLogPlugin::new(fetch_tx)));
    });
    #[cfg(target_os = "macos")]
    {
        let mut provider = location::CoreLocationProvider::new();
        location::service_loop(fetch_rx, &mut provider);
    }
    #[cfg(not(target_os = "macos"))]
    drop(fetch_rx);
    let _ = serve.join();
}
