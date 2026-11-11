//! A single PulseAudio stream (also supported by PipeWire's Pulse server), with
//! bounded in-memory voices. No subprocess, file access or decoding per key.
use super::*;
use std::{
    ffi::{c_char, c_int, c_void},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
const RATE: u32 = 48_000;
const VOICES: usize = 24;
#[repr(C)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}
#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}
#[link(name = "pulse-simple")]
unsafe extern "C" {
    fn pa_simple_new(
        server: *const c_char,
        name: *const c_char,
        dir: c_int,
        dev: *const c_char,
        stream: *const c_char,
        spec: *const SampleSpec,
        map: *const c_void,
        attr: *const BufferAttr,
        error: *mut c_int,
    ) -> *mut c_void;
    fn pa_simple_write(
        s: *mut c_void,
        data: *const c_void,
        bytes: usize,
        error: *mut c_int,
    ) -> c_int;
    fn pa_simple_flush(s: *mut c_void, error: *mut c_int) -> c_int;
    fn pa_simple_free(s: *mut c_void);
}
struct Output(*mut c_void);
impl Output {
    fn new() -> Result<Self> {
        // PA_SAMPLE_FLOAT32LE = 5, PA_STREAM_PLAYBACK = 1. Data is explicitly LE.
        let spec = SampleSpec {
            format: 5,
            rate: RATE,
            channels: 1,
        };
        let attr = BufferAttr {
            maxlength: RATE / 5 * 4,
            tlength: RATE / 50 * 4,
            prebuf: 0,
            minreq: RATE / 100 * 4,
            fragsize: u32::MAX,
        };
        let mut error = 0;
        let stream = unsafe {
            pa_simple_new(
                ptr::null(),
                c"Sumi Write".as_ptr(),
                1,
                ptr::null(),
                c"Typing feedback".as_ptr(),
                &spec,
                ptr::null(),
                &attr,
                &mut error,
            )
        };
        if stream.is_null() {
            Err(format!("Typing audio output unavailable ({error})"))
        } else {
            Ok(Self(stream))
        }
    }
    fn write(&self, frames: &[f32]) -> bool {
        let bytes: Vec<u8> = frames.iter().flat_map(|v| v.to_le_bytes()).collect();
        unsafe { pa_simple_write(self.0, bytes.as_ptr().cast(), bytes.len(), ptr::null_mut()) >= 0 }
    }
    fn flush(&self) -> bool {
        unsafe { pa_simple_flush(self.0, ptr::null_mut()) >= 0 }
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        unsafe { pa_simple_free(self.0) }
    }
}
struct Voice {
    sample: Arc<Vec<f32>>,
    offset: usize,
    gain: f32,
}
#[derive(Default)]
struct Mixer {
    voices: Vec<Voice>,
    next: usize,
    scheduled: u32,
    epoch: u64,
}
impl Mixer {
    fn render(&mut self, count: usize) -> Vec<f32> {
        let mut frames = vec![0.; count];
        for voice in &mut self.voices {
            for value in &mut frames {
                if let Some(sample) = voice.sample.get(voice.offset) {
                    *value += sample * voice.gain * 0.55;
                    voice.offset += 1;
                } else {
                    break;
                }
            }
        }
        self.voices.retain(|v| v.offset < v.sample.len());
        for value in &mut frames {
            *value = value.clamp(-1., 1.);
        }
        frames
    }
}
pub struct Engine {
    bank: HashMap<String, Vec<Arc<Vec<f32>>>>,
    mixer: Arc<Mutex<Mixer>>,
    ready: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Engine {
    pub fn new(bank: &str, offline: bool) -> Result<Self> {
        let paths: HashMap<String, Vec<String>> = serde_json::from_str(bank).map_err(crate::err)?;
        let mut bank = HashMap::new();
        for (role, files) in paths {
            let mut samples = Vec::new();
            for file in files {
                samples.push(Arc::new(decode(&std::fs::read(file).map_err(crate::err)?)?));
            }
            bank.insert(role, samples);
        }
        let mixer = Arc::new(Mutex::new(Mixer::default()));
        let ready = Arc::new(AtomicBool::new(offline));
        let closed = Arc::new(AtomicBool::new(false));
        let worker = if offline {
            None
        } else {
            let (started, receiver) = std::sync::mpsc::sync_channel(1);
            let (mixer, ready, thread_closed) = (mixer.clone(), ready.clone(), closed.clone());
            let handle = thread::spawn(move || {
                let output = match Output::new() {
                    Ok(output) => output,
                    Err(error) => {
                        let _ = started.send(Err(error));
                        return;
                    }
                };
                ready.store(true, Ordering::Release);
                if started.send(Ok(())).is_err() {
                    ready.store(false, Ordering::Release);
                    return;
                }
                let mut epoch = 0;
                while !thread_closed.load(Ordering::Acquire) {
                    let (frames, current) = match mixer.lock() {
                        Ok(mut mixer) => (mixer.render(480), mixer.epoch),
                        Err(_) => break,
                    };
                    if current != epoch {
                        if !output.flush() {
                            break;
                        }
                        epoch = current;
                    }
                    if !output.write(&frames) {
                        break;
                    }
                }
                let _ = output.flush();
                ready.store(false, Ordering::Release);
            });
            match receiver.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(Ok(())) => Some(handle),
                result => {
                    closed.store(true, Ordering::Release);
                    return Err(match result {
                        Ok(Err(error)) => error,
                        _ => "Typing audio output timed out".into(),
                    });
                }
            }
        };
        Ok(Self {
            bank,
            mixer,
            ready,
            closed,
            worker,
        })
    }
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire) && !self.closed.load(Ordering::Acquire)
    }
    pub fn play(&self, role: Role) {
        if !self.ready() {
            return;
        }
        let Some(samples) = self.bank.get(role.name()).filter(|s| !s.is_empty()) else {
            return;
        };
        let Ok(mut mixer) = self.mixer.lock() else {
            return;
        };
        let sample = samples[mixer.next % samples.len()].clone();
        mixer.next = mixer.next.wrapping_add(1);
        if mixer.voices.len() == VOICES {
            mixer.voices.remove(0);
        }
        let gain = match role {
            Role::Modifier => 0.6,
            Role::KeyUp | Role::SpaceUp => 0.32,
            _ => 1.,
        };
        mixer.voices.push(Voice {
            sample,
            offset: 0,
            gain,
        });
        mixer.scheduled = mixer.scheduled.saturating_add(1);
    }
    pub fn stop(&self) {
        if let Ok(mut mixer) = self.mixer.lock() {
            mixer.voices.clear();
            mixer.epoch = mixer.epoch.wrapping_add(1);
        }
    }
    #[cfg(test)]
    pub fn render(&self) -> (f32, u32) {
        let mut mixer = self.mixer.lock().unwrap();
        let frames = mixer.render(4096);
        (
            frames.into_iter().map(f32::abs).fold(0., f32::max),
            mixer.scheduled,
        )
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.stop();
        // Audio-server stalls must not hold up plugin shutdown. The worker owns
        // its stream and shared state and frees them when the server returns.
        if let Some(worker) = self.worker.take() {
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}
fn decode(raw: &[u8]) -> Result<Vec<f32>> {
    let invalid = || "Sound file must be short 48 kHz mono PCM16 WAV".to_owned();
    if raw.len() < 12 || &raw[..4] != b"RIFF" || &raw[8..12] != b"WAVE" {
        return Err(invalid());
    }
    let mut offset = 12usize;
    let mut format = false;
    let mut data = None;
    while offset.checked_add(8).is_some_and(|end| end <= raw.len()) {
        let size = u32::from_le_bytes(raw[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= raw.len())
            .ok_or_else(invalid)?;
        match &raw[offset..offset + 4] {
            b"fmt " => {
                let b = &raw[start..end];
                format = b.len() >= 16
                    && b[..4] == [1, 0, 1, 0]
                    && u32::from_le_bytes(b[4..8].try_into().unwrap()) == RATE
                    && b[12..16] == [2, 0, 16, 0];
            }
            b"data" => data = Some(&raw[start..end]),
            _ => {}
        }
        offset = end.checked_add(size % 2).ok_or_else(invalid)?;
    }
    let data = data
        .filter(|d| format && !d.is_empty() && d.len() % 2 == 0 && d.len() <= RATE as usize * 5 * 2)
        .ok_or_else(invalid)?;
    Ok(data
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.)
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncated_and_non_pcm_audio() {
        for bytes in [
            vec![],
            b"RIFFxxxxWAVEdata\xff\xff\xff\xff".to_vec(),
            b"RIFFxxxxWAVEfmt \x02\x00\x00\x00xx".to_vec(),
        ] {
            assert!(decode(&bytes).is_err());
        }
    }
    #[test]
    fn rapid_feedback_has_a_fixed_voice_budget() {
        let engine = Engine {
            bank: HashMap::from([("key".into(), vec![Arc::new(vec![0.5; 100])])]),
            mixer: Arc::new(Mutex::new(Mixer::default())),
            ready: Arc::new(AtomicBool::new(true)),
            closed: Arc::new(AtomicBool::new(false)),
            worker: None,
        };
        for _ in 0..1000 {
            engine.play(Role::Key);
        }
        assert_eq!(engine.mixer.lock().unwrap().voices.len(), VOICES);
        assert!(engine.render().0 <= 1.);
        engine.play(Role::Key);
        engine.stop();
        let mixer = engine.mixer.lock().unwrap();
        assert!(mixer.voices.is_empty());
        assert_eq!(mixer.epoch, 1);
    }
    #[test]
    fn overlapping_voices_mix_and_stop_is_immediate_in_mixer() {
        let mut mixer = Mixer::default();
        mixer.voices.push(Voice {
            sample: Arc::new(vec![0.5; 100]),
            offset: 0,
            gain: 1.,
        });
        assert!(mixer.render(10).iter().all(|v| *v > 0.));
        assert_eq!(mixer.voices[0].offset, 10);
        mixer.voices.clear();
        assert_eq!(mixer.render(10), vec![0.; 10]);
    }
}
