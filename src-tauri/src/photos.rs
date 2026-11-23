// The source folder's thumbnail grid, and decoding photos into upright JPEGs
// for the editor. The person's own files are only ever read.

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageReader};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;
use tauri::Manager;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp", "heic", "heif"];

#[derive(Serialize)]
pub struct SourcePhoto {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct Listing {
    photos: Vec<SourcePhoto>,
    folders: Vec<String>,
}

/// Photos directly inside `dir` (and its subfolders' names, for browsing).
#[tauri::command]
pub fn list_images(dir: String) -> Result<Listing, String> {
    let mut photos = Vec::new();
    let mut folders = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| format!("{dir}: {e}"))?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            folders.push(p.to_string_lossy().into_owned());
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let meta = e.metadata().map_err(|e| e.to_string())?;
        photos.push(SourcePhoto {
            path: p.to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
        });
    }
    photos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    folders.sort();
    Ok(Listing { photos, folders })
}

/// Decode a photo, turned upright according to its EXIF orientation.
fn decode(path: &Path) -> Result<DynamicImage, String> {
    let direct = (|| -> Result<DynamicImage, String> {
        let mut decoder = ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?.into_decoder().map_err(|e| e.to_string())?;
        let orientation = decoder.orientation().map_err(|e| e.to_string())?;
        let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
        img.apply_orientation(orientation);
        Ok(img)
    })();
    match direct {
        Ok(img) => Ok(img),
        Err(e) => convert_with_system(path).ok_or(e),
    }
}

/// HEIC and other formats the image library can't read: on a Mac, ask the
/// built-in `sips` tool for a JPEG copy in a temporary folder.
fn convert_with_system(path: &Path) -> Option<DynamicImage> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::env::temp_dir().join(format!("photostories-{}.jpg", std::process::id()));
    let ok = std::process::Command::new("sips").args(["-s", "format", "jpeg"]).arg(path).arg("--out").arg(&out).output().ok()?.status.success();
    if !ok {
        return None;
    }
    let img = image::open(&out).ok();
    let _ = fs::remove_file(&out);
    img
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    img.to_rgb8().write_with_encoder(JpegEncoder::new_with_quality(&mut buf, quality)).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn cache_path(app: &tauri::AppHandle, path: &str, max: u32) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let key = hex::encode(Sha256::digest(format!("{path}|{}|{modified}|{max}", meta.len())));
    let dir = app.path().app_cache_dir().ok()?.join("thumbs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{key}.jpg")))
}

/// A small JPEG preview, cached by path, size and modification time.
#[tauri::command]
pub async fn thumbnail(app: tauri::AppHandle, path: String, max: u32) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cached = cache_path(&app, &path, max);
        if let Some(c) = &cached {
            if let Ok(bytes) = fs::read(c) {
                return Ok(Response::new(bytes));
            }
        }
        let img = decode(Path::new(&path))?;
        let bytes = encode_jpeg(&img.thumbnail(max, max), 80)?;
        if let Some(c) = cached {
            let _ = fs::write(c, &bytes);
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The photo as an upright JPEG, optionally scaled down so its long edge is at most `max_long_edge`.
#[tauri::command]
pub async fn render_jpeg(path: String, max_long_edge: Option<u32>, quality: Option<u8>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut img = decode(Path::new(&path))?;
        if let Some(m) = max_long_edge {
            if img.width().max(img.height()) > m {
                img = img.resize(m, m, image::imageops::FilterType::Lanczos3);
            }
        }
        Ok(Response::new(encode_jpeg(&img, quality.unwrap_or(92))?))
    })
    .await
    .map_err(|e| e.to_string())?
}
