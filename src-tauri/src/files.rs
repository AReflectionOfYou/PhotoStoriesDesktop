// File access for photostories-core's FileAdapter. Paths are absolute.
// Bytes cross the bridge raw (no JSON encoding), so large photos stay cheap.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};

type R<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
}

#[tauri::command]
pub fn read_file(path: String) -> R<Response> {
    Ok(Response::new(fs::read(&path).map_err(|e| format!("{path}: {e}"))?))
}

/// The body is the raw bytes; the path comes percent-encoded in the `x-path` header.
#[tauri::command]
pub fn write_file(request: Request<'_>) -> R<()> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("missing x-path header")?;
    let path = percent_decode(path);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub fn list_dir(path: String) -> R<Vec<Entry>> {
    let mut out = Vec::new();
    for e in fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
        let e = e.map_err(err)?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        out.push(Entry { name, is_directory: e.file_type().map_err(err)?.is_dir() });
    }
    Ok(out)
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn mkdir(path: String) -> R<()> {
    fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn remove(path: String) -> R<()> {
    let p = Path::new(&path);
    let r = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{path}: {e}")),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn size(path: String) -> R<u64> {
    Ok(fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len())
}

pub fn sha256_of(path: &Path) -> R<String> {
    let mut f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

#[tauri::command]
pub async fn sha256(path: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || sha256_of(Path::new(&path))).await.map_err(err)?
}

#[tauri::command]
pub fn copy_file(from: String, to: String) -> R<()> {
    if let Some(parent) = Path::new(&to).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::copy(&from, &to).map(|_| ()).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// Zip `dir` into `zip_path`; the zip's top folder is the directory's name.
#[tauri::command]
pub async fn zip_dir(dir: String, zip_path: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(dir);
        let top = dir.file_name().ok_or("bad folder")?.to_string_lossy().into_owned();
        let file = fs::File::create(&zip_path).map_err(|e| format!("{zip_path}: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let mut entries: Vec<_> = walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect();
        entries.sort();
        for p in entries {
            let rel = p.strip_prefix(&dir).map_err(err)?.to_string_lossy().replace('\\', "/");
            let text = matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("json" | "txt" | "html" | "md"));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(if text { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored })
                .large_file(fs::metadata(&p).map_err(err)?.len() >= 0xFFFF_FFFF);
            zip.start_file(format!("{top}/{rel}"), opts).map_err(err)?;
            let mut f = fs::File::open(&p).map_err(err)?;
            std::io::copy(&mut f, &mut zip).map_err(err)?;
        }
        zip.finish().map_err(err)?.flush().map_err(err)
    })
    .await
    .map_err(err)?
}

/// Unzip into `dir`. Entries that would land outside `dir` are refused.
#[tauri::command]
pub async fn unzip(zip_path: String, dir: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = fs::File::open(&zip_path).map_err(|e| format!("{zip_path}: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(err)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(err)?;
            let Some(name) = entry.enclosed_name() else {
                return Err(format!("unsafe path in zip: {}", entry.name()));
            };
            let s = name.to_string_lossy();
            if s.starts_with("__MACOSX") || s.ends_with(".DS_Store") {
                continue;
            }
            let target = Path::new(&dir).join(&name);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(err)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            let mut out = fs::File::create(&target).map_err(err)?;
            std::io::copy(&mut entry, &mut out).map_err(err)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}
