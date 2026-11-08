use super::*;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_void, CStr, CString},
    panic::{catch_unwind, AssertUnwindSafe},
};
unsafe extern "C" {
    fn sumi_editor_mount(
        parent: *mut c_void,
        webview_sibling: i32,
        json: *const c_char,
        callback: extern "C" fn(*mut c_void, *const c_char, *mut *mut c_char) -> i64,
        free_reply: extern "C" fn(*mut c_char),
        context: *mut c_void,
    ) -> *mut c_void;
    fn sumi_editor_command(editor: *mut c_void, json: *const c_char) -> i32;
    fn sumi_editor_inspect(editor: *mut c_void) -> *mut c_char;
    fn sumi_editor_free_string(value: *mut c_char);
    fn sumi_editor_detach(editor: *mut c_void);
    fn sumi_editor_supported() -> i32;
    fn sumi_editor_register_cascade(json: *const c_char, error: *mut *mut c_char) -> i32;
    fn sumi_editor_register_font(
        path: *const c_char,
        family: *const c_char,
        error: *mut *mut c_char,
    ) -> i32;
}
struct Surface {
    handle: *mut c_void,
    generation: u64,
    _handler: Box<EventHandler>,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe { sumi_editor_detach(self.handle) }
    }
}
thread_local! {static SURFACES:RefCell<HashMap<(String,String),Surface>>=RefCell::new(HashMap::new());}
extern "C" fn free_reply(json: *mut c_char) {
    if !json.is_null() {
        unsafe {
            drop(CString::from_raw(json));
        }
    }
}
extern "C" fn event(
    context: *mut c_void,
    json: *const c_char,
    projection: *mut *mut c_char,
) -> i64 {
    if context.is_null() || json.is_null() {
        return -1;
    }
    // Never unwind across the Objective-C boundary. Context lives until detach completes.
    catch_unwind(AssertUnwindSafe(|| unsafe {
        let handler = &*(context as *const EventHandler);
        let event: NativeEvent = serde_json::from_slice(CStr::from_ptr(json).to_bytes()).ok()?;
        let reply = handler(event).ok()?;
        let revision = i64::try_from(reply.revision).ok()?;
        if !projection.is_null() {
            if let Some(text) = reply.clipboard_text {
                *projection = encode(&serde_json::json!({"clipboard_text": text})).ok()?.into_raw();
            } else if let Some(value) = reply.projection {
                *projection = encode(&value).ok()?.into_raw();
            }
        }
        Some(revision)
    }))
    .ok()
    .flatten()
    .unwrap_or(-1)
}
fn encode(value: &impl Serialize) -> Result<CString, String> {
    CString::new(serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub fn register_font(path: &std::path::Path, expected_family: &str) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let family = CString::new(expected_family).map_err(|e| e.to_string())?;
    let mut error = std::ptr::null_mut();
    let code = unsafe { sumi_editor_register_font(path.as_ptr(), family.as_ptr(), &mut error) };
    let message = if error.is_null() {
        "writing font registration failed".into()
    } else {
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { sumi_editor_free_string(error) };
        message
    };
    if code == 0 {
        Ok(())
    } else {
        Err(message)
    }
}
pub fn register_font_cascade(alias: &str, families: &[String]) -> Result<(), String> {
    let json = encode(&serde_json::json!({"alias":alias,"families":families}))?;
    let mut error = std::ptr::null_mut();
    let code = unsafe { sumi_editor_register_cascade(json.as_ptr(), &mut error) };
    let message = if error.is_null() {
        "writing font cascade registration failed".into()
    } else {
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { sumi_editor_free_string(error) };
        message
    };
    if code == 0 {
        Ok(())
    } else {
        Err(message)
    }
}
pub fn mount(
    parent: *mut c_void,
    window: &str,
    config: SurfaceConfig,
    handler: EventHandler,
) -> Result<(), String> {
    if unsafe { sumi_editor_supported() } == 0 {
        return Err("Sumi requires macOS 13 or later".into());
    }
    let key = (window.to_owned(), config.surface_id.clone());
    if SURFACES.with(|s| s.borrow().contains_key(&key)) {
        return Err("surface already mounted; detach before mounting a new generation".into());
    }
    let mut handler = Box::new(handler);
    let json = encode(&config)?;
    let handle = unsafe {
        sumi_editor_mount(
            parent,
            1,
            json.as_ptr(),
            event,
            free_reply,
            (&mut *handler as *mut EventHandler).cast(),
        )
    };
    if handle.is_null() {
        return Err("native editor mount failed".into());
    }
    SURFACES.with(|s| {
        s.borrow_mut().insert(
            key,
            Surface {
                handle,
                generation: config.generation,
                _handler: handler,
            },
        )
    });
    Ok(())
}
fn handle(window: &str, id: &str, generation: u64) -> Result<*mut c_void, String> {
    SURFACES.with(|s| {
        let s = s.borrow();
        let surface = s
            .get(&(window.to_owned(), id.to_owned()))
            .ok_or("surface not mounted")?;
        if surface.generation != generation {
            return Err("stale surface generation".into());
        }
        Ok(surface.handle)
    })
}
pub fn command(
    window: &str,
    id: &str,
    generation: u64,
    command: SurfaceCommand,
) -> Result<(), String> {
    let ptr = handle(window, id, generation)?;
    let json = encode(&command)?;
    match unsafe { sumi_editor_command(ptr, json.as_ptr()) } {
        0 => Ok(()),
        1 => Err("composition active".into()),
        2 => Err("stale document revision".into()),
        3 => Err("invalid native command".into()),
        _ => Err("native editor failure".into()),
    }
}
pub fn inspect(window: &str, id: &str, generation: u64) -> Result<SurfaceState, String> {
    let ptr = handle(window, id, generation)?;
    let json = unsafe { sumi_editor_inspect(ptr) };
    if json.is_null() {
        return Err("native inspection failed".into());
    }
    let result = unsafe {
        serde_json::from_slice(CStr::from_ptr(json).to_bytes()).map_err(|e| e.to_string())
    };
    unsafe { sumi_editor_free_string(json) };
    result
}
pub fn detach(window: &str, id: &str, generation: u64) -> Result<(), String> {
    if inspect(window, id, generation)?.composing {
        return Err("composition active".into());
    }
    handle(window, id, generation)?;
    // Drop outside the RefCell borrow: resigning first responder may emit an event.
    let surface = SURFACES.with(|s| s.borrow_mut().remove(&(window.to_owned(), id.to_owned())));
    drop(surface);
    Ok(())
}

pub fn detach_window(window: &str) {
    let removed = SURFACES.with(|s| {
        let mut s = s.borrow_mut();
        let keys: Vec<_> = s
            .keys()
            .filter(|(label, _)| label == window)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| s.remove(&key))
            .collect::<Vec<_>>()
    });
    drop(removed);
}

pub fn is_supported() -> bool {
    unsafe { sumi_editor_supported() != 0 }
}
