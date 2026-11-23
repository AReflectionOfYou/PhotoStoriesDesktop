// Whisper speech models. The small model is the default and is downloaded on
// first use; the medium model is an optional upgrade for difficult audio.
// After the download, transcription never needs a network connection.

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

pub const MODELS: &[(&str, u64)] = &[("small", 487_601_967), ("medium", 1_533_763_059)];

pub fn model_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if !MODELS.iter().any(|(n, _)| *n == name) {
        return Err(format!("unknown model {name}"));
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join(format!("ggml-{name}.bin")))
}

#[derive(Serialize)]
pub struct ModelStatus {
    name: String,
    present: bool,
    bytes: u64,
    expected_bytes: u64,
}

#[tauri::command]
pub fn model_status(app: tauri::AppHandle, name: String) -> Result<ModelStatus, String> {
    let p = model_path(&app, &name)?;
    let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let expected = MODELS.iter().find(|(n, _)| *n == name).map(|(_, b)| *b).unwrap_or(0);
    Ok(ModelStatus { name, present: bytes > 0, bytes, expected_bytes: expected })
}

#[derive(Serialize, Clone)]
struct Progress {
    name: String,
    received: u64,
    total: u64,
}

static DOWNLOADING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Marks a model as downloading for as long as it's alive.
struct InProgress(String);
impl InProgress {
    fn start(name: &str) -> Option<Self> {
        let mut set = DOWNLOADING.lock().unwrap();
        set.get_or_insert_with(HashSet::new).insert(name.to_string()).then(|| InProgress(name.to_string()))
    }
}
impl Drop for InProgress {
    fn drop(&mut self) {
        if let Some(set) = DOWNLOADING.lock().unwrap().as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Download a model from the whisper.cpp project, reporting "model-download" progress events.
/// Only one download of a model runs at a time.
#[tauri::command]
pub async fn download_model(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = model_path(&app, &name)?;
    if path.exists() {
        return Ok(());
    }
    let Some(_guard) = InProgress::start(&name) else {
        return Err("already downloading".into());
    };
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let part = path.with_extension("part");
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin");
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut last = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last > 4_000_000 || received == total {
            last = received;
            let _ = app.emit("model-download", Progress { name: name.clone(), received, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && received != total {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("the download stopped early ({received} of {total} bytes); please try again"));
    }
    tokio::fs::rename(&part, &path).await.map_err(|e| e.to_string())
}
