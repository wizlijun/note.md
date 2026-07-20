//! Host-side CoreLocation (macOS), exposed to plugins via `host.location.get`
//! (capability `location`).
//!
//! WHY the host does this: a plugin's spawned binary is not an app bundle, so
//! it can't be attributed by TCC. The host IS a signed bundle carrying
//! `NSLocationUsageDescription`, so macOS attributes the request to note.md.
//!
//! ARCHITECTURE: a persistent `CLLocationManager` + delegate is created ONCE on
//! the main thread; its callbacks are driven by the app's NORMAL run loop (tao's
//! event loop). We do NOT run a nested run loop — an earlier attempt did, and
//! the authorization prompt never appeared (status stayed NotDetermined). A
//! `host.location.get` call kicks off `requestWhenInUseAuthorization` +
//! `startUpdatingLocation` on the main thread and returns immediately; the
//! calling (off-main) request thread waits on a condvar that the delegate /
//! reverse-geocode completion signals.

use serde_json::Value;

/// Blocking one-shot location read → `{country, province, city, poi}`.
#[cfg(target_os = "macos")]
pub fn fetch_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Value, String> {
    mac::fetch_once(app)
}

#[cfg(not(target_os = "macos"))]
pub fn fetch_once<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<Value, String> {
    Err("location is only supported on macOS".into())
}

#[cfg(target_os = "macos")]
#[allow(unused_unsafe)]
mod mac {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_core_location::{
        CLAuthorizationStatus, CLGeocoder, CLLocation, CLLocationManager, CLLocationManagerDelegate,
        CLPlacemark,
    };
    use objc2_foundation::{NSArray, NSError};
    use serde_json::{json, Value};
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, LazyLock, Mutex};
    use std::time::{Duration, Instant};

    const WAIT_SECS: u64 = 90; // authorization prompt + first fix + geocode

    /// Cross-thread rendezvous: the delegate/geocode (main thread) stores a
    /// plain-Send result and wakes the waiting request thread.
    struct Shared {
        result: Mutex<Option<Result<Value, String>>>,
        cv: Condvar,
        busy: AtomicBool, // a fix is being reverse-geocoded / already handled
    }
    static SHARED: LazyLock<Arc<Shared>> = LazyLock::new(|| {
        Arc::new(Shared {
            result: Mutex::new(None),
            cv: Condvar::new(),
            busy: AtomicBool::new(false),
        })
    });

    /// First-wins: record the outcome and wake the waiter.
    fn finish(shared: &Shared, res: Result<Value, String>) {
        let mut g = shared.result.lock().unwrap();
        if g.is_none() {
            *g = Some(res);
            shared.cv.notify_all();
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "NotemdLocationDelegate"]
        #[ivars = Arc<Shared>]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl CLLocationManagerDelegate for Delegate {
            #[unsafe(method(locationManager:didUpdateLocations:))]
            unsafe fn did_update(&self, manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
                let shared = self.ivars().clone();
                if shared.busy.swap(true, Ordering::SeqCst) {
                    return; // only handle the first fix
                }
                unsafe { manager.stopUpdatingLocation() };
                let Some(loc) = locations.lastObject() else {
                    shared.busy.store(false, Ordering::SeqCst);
                    return;
                };
                // Reverse geocode; completion lands on the main queue (normal run
                // loop drains it). The geocoder lives in the thread-local so it
                // outlives this callback.
                LOC.with(|cell| {
                    let slot = cell.borrow();
                    let Some(objs) = slot.as_ref() else { return };
                    let sh = shared.clone();
                    let block = RcBlock::new(
                        move |placemarks: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                            finish(&sh, placemark_result(placemarks, error));
                        },
                    );
                    type GeoBlock = block2::Block<dyn Fn(*mut NSArray<CLPlacemark>, *mut NSError)>;
                    let block_ptr: *mut GeoBlock = &*block as *const GeoBlock as *mut GeoBlock;
                    unsafe { objs.geocoder.reverseGeocodeLocation_completionHandler(&loc, block_ptr) };
                });
            }

            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            unsafe fn did_change_auth(&self, manager: &CLLocationManager) {
                let status = unsafe { manager.authorizationStatus() };
                if matches!(
                    status,
                    CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted
                ) {
                    finish(
                        self.ivars(),
                        Err("location access denied — enable note.md in System Settings ▸ Privacy & Security ▸ Location Services".into()),
                    );
                } else if matches!(
                    status,
                    CLAuthorizationStatus::AuthorizedAlways | CLAuthorizationStatus::AuthorizedWhenInUse
                ) {
                    unsafe { manager.startUpdatingLocation() };
                }
            }
        }
    );

    impl Delegate {
        fn new(shared: Arc<Shared>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(shared);
            unsafe { msg_send![super(this), init] }
        }
    }

    struct LocObjs {
        manager: Retained<CLLocationManager>,
        _delegate: Retained<Delegate>,
        geocoder: Retained<CLGeocoder>,
    }
    // Main-thread-only: the manager/delegate/geocoder must persist across calls
    // and live on the main thread (created + used there). objc2 types aren't
    // Send, so a thread-local (not app state) is the right home.
    thread_local! {
        static LOC: RefCell<Option<LocObjs>> = const { RefCell::new(None) };
    }

    pub fn fetch_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Value, String> {
        // Arm a fresh request.
        {
            *SHARED.result.lock().unwrap() = None;
            SHARED.busy.store(false, Ordering::SeqCst);
        }
        // Kick off on the main thread; the NORMAL run loop drives the callbacks.
        app.run_on_main_thread(|| {
            LOC.with(|cell| {
                let mut slot = cell.borrow_mut();
                if slot.is_none() {
                    let manager = unsafe { CLLocationManager::new() };
                    let delegate = Delegate::new(SHARED.clone());
                    unsafe { manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
                    let geocoder = unsafe { CLGeocoder::new() };
                    *slot = Some(LocObjs { manager, _delegate: delegate, geocoder });
                }
                let objs = slot.as_ref().unwrap();
                let status = unsafe { objs.manager.authorizationStatus() };
                if matches!(
                    status,
                    CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted
                ) {
                    finish(
                        &SHARED,
                        Err("location access denied — enable note.md in System Settings ▸ Privacy & Security ▸ Location Services".into()),
                    );
                    return;
                }
                if status == CLAuthorizationStatus::NotDetermined {
                    unsafe { objs.manager.requestWhenInUseAuthorization() };
                }
                unsafe { objs.manager.startUpdatingLocation() };
            });
        })
        .map_err(|e| format!("run_on_main_thread: {e}"))?;

        // Wait (off-main) for the delegate / geocode to produce a result.
        let mut g = SHARED.result.lock().unwrap();
        let deadline = Instant::now() + Duration::from_secs(WAIT_SECS);
        loop {
            if let Some(res) = g.take() {
                return res;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("timed out waiting for a location fix — if no permission prompt appeared, check System Settings ▸ Privacy & Security ▸ Location Services (note.md)".into());
            }
            let (ng, _timeout) = SHARED.cv.wait_timeout(g, deadline - now).unwrap();
            g = ng;
        }
    }

    fn placemark_result(placemarks: *mut NSArray<CLPlacemark>, error: *mut NSError) -> Result<Value, String> {
        if !placemarks.is_null() {
            let arr = unsafe { &*placemarks };
            if let Some(pm) = arr.firstObject() {
                return Ok(place_of(&pm));
            }
        }
        let msg = if error.is_null() {
            "no placemark".to_string()
        } else {
            unsafe { (*error).localizedDescription() }.to_string()
        };
        Err(format!("reverse geocode failed: {msg}"))
    }

    fn opt_str(s: Option<Retained<objc2_foundation::NSString>>) -> String {
        s.map(|v| v.to_string()).unwrap_or_default()
    }

    fn place_of(pm: &CLPlacemark) -> Value {
        let poi = unsafe { pm.areasOfInterest() }
            .and_then(|a| a.firstObject())
            .map(|s| s.to_string())
            .or_else(|| unsafe { pm.name() }.map(|s| s.to_string()))
            .unwrap_or_default();
        json!({
            "country": opt_str(unsafe { pm.country() }),
            "province": opt_str(unsafe { pm.administrativeArea() }),
            "city": opt_str(unsafe { pm.locality() }),
            "poi": poi,
        })
    }
}
