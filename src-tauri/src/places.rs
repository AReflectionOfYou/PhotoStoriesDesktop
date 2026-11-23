// Turning a photo's map coordinates into a place name, using OpenStreetMap's
// public Nominatim service. Only the coordinates are sent; it runs only when
// the person asks for it (or has said to do it for every photo).

use std::time::Duration;

/// The address parts OpenStreetMap has for a spot, as JSON text
/// (e.g. {"city":"…","state":"…","country":"…"}), or None if it has none.
#[tauri::command]
pub async fn place_name(lat: f64, lon: f64) -> Result<Option<String>, String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Ok(None);
    }
    let client = reqwest::Client::builder()
        // Nominatim's usage policy asks each app to name itself.
        .user_agent(concat!("PhotoStoriesDesktop/", env!("CARGO_PKG_VERSION"), " (+https://github.com/AReflectionOfYou/PhotoStoriesDesktop)"))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat:.6}&lon={lon:.6}&zoom=14&accept-language=en");
    let text = client.get(&url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("address").map(|a| a.to_string()))
}
