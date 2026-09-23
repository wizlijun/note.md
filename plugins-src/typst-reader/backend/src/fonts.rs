//! User-initiated font downloads use the same verified system installer as the host.
use crate::world;
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize)]
pub struct FontStatus {
    pub style: String,
    pub stage: &'static str,
    pub completed: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct FontInstaller {
    state: Arc<Mutex<FontStatus>>,
}

impl FontInstaller {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(FontStatus {
                style: String::new(),
                stage: "idle",
                completed: 0,
                total: 0,
                error: None,
            })),
        }
    }

    pub fn status(&self) -> FontStatus {
        self.state.lock().unwrap().clone()
    }

    pub fn start(&self, style: &str) -> Result<FontStatus, String> {
        let specs = notemd_fonts::bundle(style)?;
        if style != "cjk" && style != "wonderous" {
            return Err("unknown font bundle".into());
        }
        {
            let mut state = self.state.lock().unwrap();
            if state.stage == "downloading" {
                return Err("a font download is already running".into());
            }
            *state = FontStatus {
                style: style.into(),
                stage: "downloading",
                completed: 0,
                total: specs.len(),
                error: None,
            };
        }
        let state = self.state.clone();
        let style = style.to_owned();
        let worker = std::thread::Builder::new()
            .name("notemd-font-download".into())
            .spawn(move || {
                let result = notemd_fonts::install(&style, |completed| {
                    state.lock().unwrap().completed = completed;
                });
                if result.is_ok() {
                    world::refresh_fonts();
                }
                let mut status = state.lock().unwrap();
                match result {
                    Ok(()) => status.stage = "complete",
                    Err(error) => {
                        status.stage = "error";
                        status.error = Some(error);
                    }
                }
            });
        if let Err(error) = worker {
            let message = format!("start font download worker: {error}");
            let mut status = self.state.lock().unwrap();
            status.stage = "error";
            status.error = Some(message.clone());
            return Err(message);
        }
        Ok(self.status())
    }
}
