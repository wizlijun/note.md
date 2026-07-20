//! CoreLocation 取位 + 反查，跑在**主线程**（CLGeocoder 完成块落主 dispatch 队列，
//! 只有主线程 run loop 会排干它；NSRunLoop 泵同时驱动 CLLocationManager 回调）。
//! 对外形状：`LocationProvider` trait（测试注入假实现）+ `service_loop`（主线程
//! 消费 FetchJob channel，直到发送端全部关闭）。
#![allow(unused_unsafe)]

use crate::logbook::Place;

pub trait LocationProvider {
    fn fetch(&mut self) -> Result<Place, String>;
}

/// 一次取位请求：主线程做完后经 oneshot 回给 tokio 侧。
pub struct FetchJob {
    pub reply: tokio::sync::oneshot::Sender<Result<Place, String>>,
}

/// 主线程服务循环。`provider` 由调用方注入（生产 = CoreLocationProvider，
/// 测试 = 假实现）。channel 关闭（serve 结束、插件退出）即返回。
pub fn service_loop(rx: std::sync::mpsc::Receiver<FetchJob>, provider: &mut dyn LocationProvider) {
    while let Ok(job) = rx.recv() {
        let _ = job.reply.send(provider.fetch());
    }
}

// ── CoreLocation 实现（仅 macOS）─────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub use mac::CoreLocationProvider;

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_core_location::{CLAuthorizationStatus, CLGeocoder, CLLocationManager, CLPlacemark};
    use objc2_foundation::{NSArray, NSDate, NSError, NSRunLoop};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const AUTH_WAIT_SECS: u64 = 60; // 首次授权弹窗等待
    const FIX_WAIT_SECS: u64 = 30; // 定位等待
    const GEO_WAIT_SECS: u64 = 15; // 反查等待
    const FRESH_SECS: f64 = 300.0; // 位置新鲜度：5 分钟内

    pub struct CoreLocationProvider {
        manager: Retained<CLLocationManager>,
    }

    impl CoreLocationProvider {
        /// 必须在主线程构造（也在主线程使用）。构造即申请授权（spec §3：启动时申请）。
        pub fn new() -> Self {
            let manager = unsafe { CLLocationManager::new() };
            let me = Self { manager };
            me.ensure_authorization_requested();
            me
        }

        fn status(&self) -> CLAuthorizationStatus {
            unsafe { self.manager.authorizationStatus() }
        }

        fn ensure_authorization_requested(&self) {
            if self.status() == CLAuthorizationStatus::NotDetermined {
                unsafe { self.manager.requestWhenInUseAuthorization() };
            }
        }

        /// 泵一格主 run loop（同时排干主队列上的 GCD block）。
        fn pump(seconds: f64) {
            unsafe {
                let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
                NSRunLoop::currentRunLoop().runUntilDate(&until);
            }
        }

        fn wait_authorized(&self) -> Result<(), String> {
            let t0 = Instant::now();
            loop {
                let s = self.status();
                // `requestWhenInUseAuthorization` grants `AuthorizedWhenInUse`, not
                // `AuthorizedAlways`; both are valid for foreground location reads.
                // Accepting only `Always` here rejected every granted user as
                // "denied", which surfaced as the "无法获取位置" warning.
                if matches!(
                    s,
                    CLAuthorizationStatus::AuthorizedAlways
                        | CLAuthorizationStatus::AuthorizedWhenInUse
                ) {
                    return Ok(());
                }
                if s == CLAuthorizationStatus::NotDetermined {
                    if t0.elapsed() > Duration::from_secs(AUTH_WAIT_SECS) {
                        return Err("authorization prompt timed out".into());
                    }
                    Self::pump(0.2);
                    continue;
                }
                return Err(format!("location authorization denied/restricted ({s:?})"));
            }
        }
    }

    impl LocationProvider for CoreLocationProvider {
        fn fetch(&mut self) -> Result<Place, String> {
            self.ensure_authorization_requested();
            self.wait_authorized()?;

            // 短启停 + 轮询 .location（spec 偏离①：免 delegate，行为等价 requestLocation）
            unsafe { self.manager.startUpdatingLocation() };
            let t0 = Instant::now();
            let loc = loop {
                let fresh = unsafe { self.manager.location() }.filter(|l| {
                    let age = unsafe { l.timestamp().timeIntervalSinceNow() };
                    age > -FRESH_SECS
                });
                if let Some(l) = fresh {
                    break l;
                }
                if t0.elapsed() > Duration::from_secs(FIX_WAIT_SECS) {
                    unsafe { self.manager.stopUpdatingLocation() };
                    return Err("location fix timed out".into());
                }
                Self::pump(0.2);
            };
            unsafe { self.manager.stopUpdatingLocation() };

            // 反查（完成块落主队列；pump 排干）
            let slot: Arc<Mutex<Option<Result<Place, String>>>> = Arc::new(Mutex::new(None));
            let slot_in = slot.clone();
            let block = RcBlock::new(
                move |placemarks: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                    let mut out = slot_in.lock().unwrap();
                    if !placemarks.is_null() {
                        let arr = unsafe { &*placemarks };
                        if let Some(pm) = arr.firstObject() {
                            *out = Some(Ok(place_of(&pm)));
                            return;
                        }
                    }
                    let msg = if error.is_null() {
                        "no placemark".to_string()
                    } else {
                        unsafe { (*error).localizedDescription() }.to_string()
                    };
                    *out = Some(Err(format!("reverse geocode failed: {msg}")));
                },
            );
            let geocoder = unsafe { CLGeocoder::new() };
            // 生成的绑定要 `*mut Block`（镜像 ObjC 非 const 块指针）；块本身只被
            // invoke，不被改写，const→mut cast 安全。
            type GeoBlock = block2::Block<dyn Fn(*mut NSArray<CLPlacemark>, *mut NSError)>;
            let block_ptr: *mut GeoBlock = &*block as *const GeoBlock as *mut GeoBlock;
            unsafe { geocoder.reverseGeocodeLocation_completionHandler(&loc, block_ptr) };
            let t1 = Instant::now();
            loop {
                if let Some(res) = slot.lock().unwrap().take() {
                    return res;
                }
                if t1.elapsed() > Duration::from_secs(GEO_WAIT_SECS) {
                    return Err("reverse geocode timed out".into());
                }
                Self::pump(0.2);
            }
        }
    }

    fn opt_str(s: Option<Retained<objc2_foundation::NSString>>) -> String {
        s.map(|v| v.to_string()).unwrap_or_default()
    }

    fn place_of(pm: &CLPlacemark) -> Place {
        let poi = unsafe { pm.areasOfInterest() }
            .and_then(|a| a.firstObject())
            .map(|s| s.to_string())
            .or_else(|| unsafe { pm.name() }.map(|s| s.to_string()))
            .unwrap_or_default();
        Place {
            country: opt_str(unsafe { pm.country() }),
            province: opt_str(unsafe { pm.administrativeArea() }),
            city: opt_str(unsafe { pm.locality() }),
            poi,
        }
    }
}
