//! Host-side CoreLocation (macOS), exposed to plugins via `host.location.get`
//! (capability `location`).
//!
//! WHY the host does this instead of the plugin: a plugin's spawned binary is
//! NOT an app bundle, so it can't be attributed by TCC. The host IS a signed
//! bundle carrying `NSLocationUsageDescription`, so macOS attributes the
//! request to note.md and prompts correctly.
//!
//! WHY a delegate: on macOS the authorization prompt only appears when a
//! `CLLocationManager` with a DELEGATE set makes a location request. Polling
//! `authorizationStatus` without a delegate leaves the status at
//! `NotDetermined` forever (no prompt). We set a minimal delegate, then
//! `startUpdatingLocation` (which triggers the prompt), and poll for the
//! result while pumping the main run loop.
//!
//! `fetch_once` MUST run on the MAIN thread (CLGeocoder completion blocks land
//! on the main queue; a nested run loop drains them — the same pattern the
//! native dialogs already rely on).

use serde_json::{json, Value};

/// Blocking one-shot location read → `{country, province, city, poi}`.
/// MUST be called on the main thread (see module note). Non-macOS: unsupported.
#[cfg(target_os = "macos")]
pub fn fetch_once() -> Result<Value, String> {
    mac::fetch_once()
}

#[cfg(not(target_os = "macos"))]
pub fn fetch_once() -> Result<Value, String> {
    Err("location is only supported on macOS".into())
}

#[cfg(target_os = "macos")]
#[allow(unused_unsafe)]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_core_location::{
        CLAuthorizationStatus, CLGeocoder, CLLocationManager, CLLocationManagerDelegate,
        CLPlacemark,
    };
    use objc2_foundation::{NSArray, NSDate, NSError, NSRunLoop};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const WAIT_SECS: u64 = 90; // authorization prompt + first fix, combined
    const GEO_WAIT_SECS: u64 = 15; // waiting for reverse geocode
    const FRESH_SECS: f64 = 300.0; // accept a fix ≤ 5 min old

    // A minimal CLLocationManagerDelegate. Its mere presence is what makes the
    // authorization prompt appear; all delegate methods are optional so we
    // implement none and poll the manager instead.
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "NotemdLocationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}
        unsafe impl CLLocationManagerDelegate for Delegate {}
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            unsafe { msg_send![Self::alloc(), init] }
        }
    }

    /// Pump the main run loop for `seconds` (also drains GCD blocks on the main
    /// queue). Only valid on the main thread.
    fn pump(seconds: f64) {
        unsafe {
            let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
            NSRunLoop::currentRunLoop().runUntilDate(&until);
        }
    }

    pub fn fetch_once() -> Result<Value, String> {
        let manager = unsafe { CLLocationManager::new() };
        // Delegate MUST be set before requesting authorization / updates, or no
        // prompt appears. Keep it alive for the whole fetch (manager holds a
        // weak reference).
        let delegate = Delegate::new();
        unsafe {
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }

        if unsafe { manager.authorizationStatus() } == CLAuthorizationStatus::NotDetermined {
            unsafe { manager.requestWhenInUseAuthorization() };
        }
        // startUpdatingLocation is what actually triggers the prompt on macOS
        // (with a delegate set); it also begins delivering fixes.
        unsafe { manager.startUpdatingLocation() };

        // Combined wait: authorization prompt resolves, then a fresh fix lands.
        let t0 = Instant::now();
        let loc = loop {
            let s = unsafe { manager.authorizationStatus() };
            if matches!(
                s,
                CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted
            ) {
                unsafe { manager.stopUpdatingLocation() };
                return Err(format!(
                    "location access denied — enable note.md in System Settings ▸ Privacy & Security ▸ Location Services ({s:?})"
                ));
            }
            if matches!(
                s,
                CLAuthorizationStatus::AuthorizedAlways | CLAuthorizationStatus::AuthorizedWhenInUse
            ) {
                let fresh = unsafe { manager.location() }.filter(|l| {
                    let age = unsafe { l.timestamp().timeIntervalSinceNow() };
                    age > -FRESH_SECS
                });
                if let Some(l) = fresh {
                    break l;
                }
            }
            if t0.elapsed() > Duration::from_secs(WAIT_SECS) {
                unsafe { manager.stopUpdatingLocation() };
                let s = unsafe { manager.authorizationStatus() };
                return Err(format!("timed out waiting for location (auth status: {s:?})"));
            }
            pump(0.2);
        };
        unsafe { manager.stopUpdatingLocation() };

        // Reverse geocode (completion block lands on the main queue; pump drains).
        let slot: Arc<Mutex<Option<Result<Value, String>>>> = Arc::new(Mutex::new(None));
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
        type GeoBlock = block2::Block<dyn Fn(*mut NSArray<CLPlacemark>, *mut NSError)>;
        let block_ptr: *mut GeoBlock = &*block as *const GeoBlock as *mut GeoBlock;
        unsafe { geocoder.reverseGeocodeLocation_completionHandler(&loc, block_ptr) };
        let t1 = Instant::now();
        let result = loop {
            if let Some(res) = slot.lock().unwrap().take() {
                break res;
            }
            if t1.elapsed() > Duration::from_secs(GEO_WAIT_SECS) {
                break Err("reverse geocode timed out".into());
            }
            pump(0.2);
        };
        drop(delegate); // keep the delegate alive until we're fully done
        result
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
