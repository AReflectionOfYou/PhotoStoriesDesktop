// Photo Stories desktop: the Rust layer. It does only what the shared
// TypeScript library (photostories-core) and the web front end cannot:
// file access for the library's adapter, image decoding and thumbnails,
// microphone capture with local Whisper transcription, the one-time model
// download, and keeping API keys in the system keychain.

mod audio;
mod files;
mod models;
mod photos;
mod secrets;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(audio::Recorder::default())
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
            files::list_dir,
            files::exists,
            files::mkdir,
            files::remove,
            files::size,
            files::sha256,
            files::copy_file,
            files::zip_dir,
            files::unzip,
            photos::list_images,
            photos::thumbnail,
            photos::render_jpeg,
            audio::preload_model,
            audio::start_recording,
            audio::pause_recording,
            audio::resume_recording,
            audio::stop_recording,
            audio::transcribe_file,
            models::model_status,
            models::download_model,
            secrets::set_api_key,
            secrets::get_api_key,
            secrets::delete_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Photo Stories");
}
