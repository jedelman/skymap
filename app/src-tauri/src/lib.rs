//! skymap's native shell. Everything the user sees is the web client in
//! `../src`; this crate exists to package it for Android (and later iOS and
//! desktop) and to hand it the device capabilities a WebView doesn't get on
//! its own: location, the system browser, and the OAuth redirect back into
//! the app. atproto-iroh-core links in here when Tables arrive.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        // OAuth: open the authorization page in the system browser, and catch
        // the org.jason-edelman.skymap:/oauth/callback redirect coming back.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .run(tauri::generate_context!())
        .expect("error while running skymap");
}
