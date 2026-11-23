// Recording a story and transcribing it locally with Whisper, as it is told.
//
// One thread captures the microphone (mono, at the device's rate). Another
// transcribes every couple of seconds: audio is locked in ("committed") in
// chunks of about 25 seconds, and the unfinished tail is re-transcribed each
// time, so the text appears while the person speaks. Nothing leaves the
// computer. Pausing simply stops keeping the microphone's sound.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::models::model_path;

const CHUNK_SECONDS: f64 = 25.0;
const TICK: Duration = Duration::from_millis(1500);

struct Shared {
    samples: Mutex<Vec<f32>>,
    rate: Mutex<u32>,
    paused: AtomicBool,
    running: AtomicBool,
    /// Samples (at the device rate) already transcribed for good, and their text.
    committed: Mutex<(usize, String)>,
    /// Names and words to expect (the project's people), to help spelling.
    hint: String,
}

struct Session {
    shared: Arc<Shared>,
    ctx: Arc<WhisperContext>,
    model: String,
    capture: JoinHandle<()>,
    worker: JoinHandle<()>,
}

#[derive(Default)]
pub struct Recorder {
    session: Mutex<Option<Session>>,
}

#[derive(Serialize, Clone)]
struct Live {
    committed: String,
    partial: String,
    seconds: f64,
}

#[derive(Serialize)]
pub struct Finished {
    text: String,
    seconds: f64,
    model: String,
    wav: Option<String>,
}

/// Loaded models are kept, so the next recording starts at once.
fn context(path: &str) -> Result<Arc<WhisperContext>, String> {
    static CACHE: OnceLock<Mutex<Option<(String, Arc<WhisperContext>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut c = cache.lock().unwrap();
    if let Some((p, ctx)) = c.as_ref() {
        if p == path {
            return Ok(ctx.clone());
        }
    }
    let ctx = Arc::new(WhisperContext::new_with_params(path, WhisperContextParameters::default()).map_err(|e| format!("could not load the speech model: {e}"))?);
    *c = Some((path.to_string(), ctx.clone()));
    Ok(ctx)
}

/// Linear resampling to the 16 kHz Whisper expects.
fn to_16k(src: &[f32], rate: u32) -> Vec<f32> {
    if rate == 16_000 || src.is_empty() {
        return src.to_vec();
    }
    let step = rate as f64 / 16_000.0;
    let n = (src.len() as f64 / step) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 * step;
            let j = t as usize;
            let f = (t - j as f64) as f32;
            let a = src[j];
            let b = *src.get(j + 1).unwrap_or(&a);
            a + (b - a) * f
        })
        .collect()
}

fn transcribe(ctx: &WhisperContext, audio16k: &[f32], prompt: &str) -> Result<String, String> {
    let mut data = audio16k.to_vec();
    // Whisper wants at least a second of audio.
    if data.len() < 17_600 {
        data.resize(17_600, 0.0);
    }
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("auto"));
    p.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4));
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p.set_suppress_blank(true);
    p.set_no_context(true);
    if !prompt.is_empty() {
        p.set_initial_prompt(prompt);
    }
    state.full(p, &data).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for seg in state.as_iter() {
        text.push_str(&seg.to_str_lossy().map_err(|e| e.to_string())?);
    }
    Ok(clean_segment(&text))
}

/// Whisper marks silence and sounds in brackets; leave those out of the words.
fn clean_segment(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for ch in s.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join_text(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a} {b}"),
    }
}

/// Transcribe what's new. With `finish`, everything left is committed.
fn step(app: &tauri::AppHandle, shared: &Shared, ctx: &WhisperContext, finish: bool) -> Result<(), String> {
    let rate = *shared.rate.lock().unwrap();
    if rate == 0 {
        return Ok(());
    }
    let chunk = (CHUNK_SECONDS * rate as f64) as usize;
    let total = shared.samples.lock().unwrap().len();
    loop {
        let (start, text) = shared.committed.lock().unwrap().clone();
        let avail = total - start;
        let take = if avail >= chunk { chunk } else if finish && avail > rate as usize / 3 { avail } else { break };
        let audio = to_16k(&shared.samples.lock().unwrap()[start..start + take], rate);
        // The last words already heard help Whisper keep names and spelling consistent.
        let recent: String = text.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
        let prompt = if recent.is_empty() { shared.hint.clone() } else { recent };
        let words = transcribe(ctx, &audio, &prompt)?;
        *shared.committed.lock().unwrap() = (start + take, join_text(&text, &words));
    }
    let (start, committed) = shared.committed.lock().unwrap().clone();
    let partial = if !finish && total - start > rate as usize / 2 {
        let audio = to_16k(&shared.samples.lock().unwrap()[start..total], rate);
        transcribe(ctx, &audio, if committed.is_empty() { &shared.hint } else { "" })?
    } else {
        String::new()
    };
    let _ = app.emit("transcript", Live { committed, partial, seconds: total as f64 / rate as f64 });
    Ok(())
}

fn capture(shared: Arc<Shared>, ready: mpsc::Sender<Result<(), String>>) {
    let setup = (|| -> Result<cpal::Stream, String> {
        let device = cpal::default_host().default_input_device().ok_or("no microphone was found")?;
        let config = device.default_input_config().map_err(|e| format!("the microphone can't be used: {e}"))?;
        let channels = config.channels() as usize;
        *shared.rate.lock().unwrap() = config.sample_rate().0;
        let on_error = |e| eprintln!("microphone error: {e}");
        let push = {
            let shared = shared.clone();
            move |frames: &mut dyn Iterator<Item = f32>| {
                if shared.paused.load(Ordering::Relaxed) {
                    return;
                }
                let mut buf = shared.samples.lock().unwrap();
                let mut acc = 0.0;
                for (i, v) in frames.enumerate() {
                    acc += v;
                    if (i + 1) % channels == 0 {
                        buf.push(acc / channels as f32);
                        acc = 0.0;
                    }
                }
            }
        };
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let push = push.clone();
                device.build_input_stream(&config.into(), move |d: &[f32], _: &_| push(&mut d.iter().copied()), on_error, None)
            }
            cpal::SampleFormat::I16 => {
                let push = push.clone();
                device.build_input_stream(&config.into(), move |d: &[i16], _: &_| push(&mut d.iter().map(|v| *v as f32 / 32768.0)), on_error, None)
            }
            cpal::SampleFormat::U16 => {
                let push = push.clone();
                device.build_input_stream(&config.into(), move |d: &[u16], _: &_| push(&mut d.iter().map(|v| (*v as f32 - 32768.0) / 32768.0)), on_error, None)
            }
            other => return Err(format!("unsupported microphone format {other:?}")),
        }
        .map_err(|e| format!("the microphone can't be opened: {e}"))?;
        stream.play().map_err(|e| format!("the microphone can't be started: {e}"))?;
        Ok(stream)
    })();
    match setup {
        Ok(stream) => {
            let _ = ready.send(Ok(()));
            while shared.running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(stream);
        }
        Err(e) => {
            shared.running.store(false, Ordering::Relaxed);
            let _ = ready.send(Err(e));
        }
    }
}

#[tauri::command]
pub async fn start_recording(app: tauri::AppHandle, state: tauri::State<'_, Recorder>, model: String, names: Option<Vec<String>>) -> Result<(), String> {
    if state.session.lock().unwrap().is_some() {
        return Err("already recording".into());
    }
    let path = model_path(&app, &model)?;
    if !path.exists() {
        return Err(format!("the {model} speech model hasn't been downloaded yet"));
    }
    let path_s = path.to_string_lossy().into_owned();
    let ctx = tauri::async_runtime::spawn_blocking(move || context(&path_s)).await.map_err(|e| e.to_string())??;
    let shared = Arc::new(Shared { samples: Mutex::new(Vec::new()), rate: Mutex::new(0), paused: AtomicBool::new(false), running: AtomicBool::new(true), committed: Mutex::new((0, String::new())), hint: hint_for(&names.unwrap_or_default()) });
    let (tx, rx) = mpsc::channel();
    let capture = std::thread::spawn({
        let shared = shared.clone();
        move || capture(shared, tx)
    });
    rx.recv().map_err(|e| e.to_string())??;
    let worker = std::thread::spawn({
        let shared = shared.clone();
        let ctx = ctx.clone();
        let app = app.clone();
        move || {
            while shared.running.load(Ordering::Relaxed) {
                let mut waited = Duration::ZERO;
                while waited < TICK && shared.running.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += Duration::from_millis(100);
                }
                if !shared.running.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = step(&app, &shared, &ctx, false) {
                    let _ = app.emit("transcript-error", e);
                }
            }
        }
    });
    *state.session.lock().unwrap() = Some(Session { shared, ctx, model, capture, worker });
    Ok(())
}

/// Whisper's initial prompt: a short list of the names people are likely to say.
fn hint_for(names: &[String]) -> String {
    let mut out = String::new();
    for n in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if out.len() + n.len() > 200 {
            break;
        }
        out.push_str(if out.is_empty() { "People in these photos: " } else { ", " });
        out.push_str(n);
    }
    if !out.is_empty() {
        out.push('.');
    }
    out
}

#[tauri::command]
pub fn pause_recording(state: tauri::State<'_, Recorder>) {
    if let Some(s) = state.session.lock().unwrap().as_ref() {
        s.shared.paused.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn resume_recording(state: tauri::State<'_, Recorder>) {
    if let Some(s) = state.session.lock().unwrap().as_ref() {
        s.shared.paused.store(false, Ordering::Relaxed);
    }
}

/// Stop recording. Unless `discard`, finish the transcript and, if `wav` is
/// given, save the recording there (16 kHz mono WAV).
#[tauri::command]
pub async fn stop_recording(app: tauri::AppHandle, state: tauri::State<'_, Recorder>, discard: bool, wav: Option<String>) -> Result<Finished, String> {
    let Some(s) = state.session.lock().unwrap().take() else {
        return Err("not recording".into());
    };
    s.shared.running.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = s.capture.join();
        let _ = s.worker.join();
        let rate = *s.shared.rate.lock().unwrap();
        let seconds = if rate > 0 { s.shared.samples.lock().unwrap().len() as f64 / rate as f64 } else { 0.0 };
        if discard {
            return Ok(Finished { text: String::new(), seconds, model: s.model, wav: None });
        }
        step(&app, &s.shared, &s.ctx, true)?;
        let text = s.shared.committed.lock().unwrap().1.clone();
        let wav = match wav {
            Some(path) if seconds > 0.0 => {
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let audio = to_16k(&s.shared.samples.lock().unwrap(), rate);
                let spec = hound::WavSpec { channels: 1, sample_rate: 16_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
                let mut w = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
                for v in audio {
                    w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?;
                }
                w.finalize().map_err(|e| e.to_string())?;
                Some(path)
            }
            _ => None,
        };
        Ok(Finished { text, seconds, model: s.model, wav })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transcribe a saved 16 kHz WAV again (for example with the medium model).
#[tauri::command]
pub async fn transcribe_file(app: tauri::AppHandle, path: String, model: String) -> Result<String, String> {
    let model = model_path(&app, &model)?;
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = context(&model.to_string_lossy())?;
        let mut r = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = r.spec();
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => r.samples::<i16>().filter_map(Result::ok).map(|v| v as f32 / 32768.0).collect(),
            hound::SampleFormat::Float => r.samples::<f32>().filter_map(Result::ok).collect(),
        };
        let ch = spec.channels.max(1) as usize;
        let mono: Vec<f32> = samples.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
        let audio = to_16k(&mono, spec.sample_rate);
        let mut text = String::new();
        for part in audio.chunks((CHUNK_SECONDS * 16_000.0) as usize) {
            let prompt: String = text.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
            text = join_text(&text, &transcribe(&ctx, part, &prompt)?);
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_to_16k() {
        let one_second_48k = vec![0.5f32; 48_000];
        assert_eq!(to_16k(&one_second_48k, 48_000).len(), 16_000);
        assert_eq!(to_16k(&one_second_48k, 16_000).len(), 48_000);
    }

    #[test]
    fn drops_bracketed_sounds() {
        assert_eq!(clean_segment(" [MUSIC] Hello (laughs) there  "), "Hello there");
    }

    /// Needs a downloaded model and a spoken WAV:
    ///   say -o /tmp/story.wav --data-format=LEI16@22050 "This is the red house on Elm Street."
    ///   PS_MODEL=.../ggml-small.bin PS_WAV=/tmp/story.wav cargo test -- --ignored
    #[test]
    #[ignore]
    fn transcribes_speech() {
        let model = std::env::var("PS_MODEL").expect("PS_MODEL");
        let wav = std::env::var("PS_WAV").expect("PS_WAV");
        let ctx = context(&model).unwrap();
        let mut r = hound::WavReader::open(&wav).unwrap();
        let rate = r.spec().sample_rate;
        let samples: Vec<f32> = r.samples::<i16>().map(|v| v.unwrap() as f32 / 32768.0).collect();
        let text = transcribe(&ctx, &to_16k(&samples, rate), &hint_for(&["Grandma Rose".into(), "Uncle Bob".into()])).unwrap().to_lowercase();
        println!("heard: {text}");
        for w in ["red house", "elm street", "grandma rose"] {
            assert!(text.contains(w), "expected {w:?} in {text:?}");
        }
    }
}
