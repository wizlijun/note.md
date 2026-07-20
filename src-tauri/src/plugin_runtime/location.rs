//! Host-side CoreLocation (macOS), exposed to plugins via `host.location.get`
//! (capability `location`).
//!
//! WHY the host does this instead of the plugin: a plugin's spawned binary is
//! NOT an app bundle, so `requestWhenInUseAuthorization` never prompts — the
//! authorization status stays `NotDetermined` and every read times out
//! ("authorization prompt timed out"). The host IS a signed bundle carrying
//! `NSLocationUsageDescription`, so macOS attributes TCC to note.md and prompts
//! correctly. `fetch_once` MUST run on the MAIN thread: CLGeocoder completion
//! blocks land on the main queue, and a nested run loop drains them — the same
//! nested-run-loop pattern the native dialogs already rely on.

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
    use objc2_core_location::{
        CLAuthorizationStatus, CLGeocoder, CLLocationManager, CLPlacemark,
    };
    use objc2_foundation::{NSArray, NSDate, NSError, NSRunLoop};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const AUTH_WAIT_SECS: u64 = 60; // first-run authorization prompt
    const FIX_WAIT_SECS: u64 = 30; // waiting for a location fix
    const GEO_WAIT_SECS: u64 = 15; // waiting for reverse geocode
    const FRESH_SECS: f64 = 300.0; // accept a fix ≤ 5 min old

    /// Pump the main run loop for `seconds` (also drains GCD blocks on the main
    /// queue). Only valid on the main thread.
    fn pump(seconds: f64) {
        unsafe {
            let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
            NSRunLoop::currentRunLoop().runUntilDate(&until);
        }
    }

    fn wait_authorized(manager: &CLLocationManager) -> Result<(), String> {
        let t0 = Instant::now();
        loop {
            let s = unsafe { manager.authorizationStatus() };
            // `requestWhenInUseAuthorization` grants `AuthorizedWhenInUse`, not
            // `AuthorizedAlways`; both are valid for a foreground read.
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
                pump(0.2);
                continue;
            }
            return Err(format!("location authorization denied/restricted ({s:?})"));
        }
    }

    pub fn fetch_once() -> Result<Value, String> {
        let manager = unsafe { CLLocationManager::new() };
        if unsafe { manager.authorizationStatus() } == CLAuthorizationStatus::NotDetermined {
            unsafe { manager.requestWhenInUseAuthorization() };
        }
        wait_authorized(&manager)?;

        // Short start/stop + poll `.location` (behaviorally equivalent to
        // requestLocation, without a delegate).
        unsafe { manager.startUpdatingLocation() };
        let t0 = Instant::now();
        let loc = loop {
            let fresh = unsafe { manager.location() }.filter(|l| {
                let age = unsafe { l.timestamp().timeIntervalSinceNow() };
                age > -FRESH_SECS
            });
            if let Some(l) = fresh {
                break l;
            }
            if t0.elapsed() > Duration::from_secs(FIX_WAIT_SECS) {
                unsafe { manager.stopUpdatingLocation() };
                return Err("location fix timed out".into());
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
        loop {
            if let Some(res) = slot.lock().unwrap().take() {
                return res;
            }
            if t1.elapsed() > Duration::from_secs(GEO_WAIT_SECS) {
                return Err("reverse geocode timed out".into());
            }
            pump(0.2);
        }
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
