//! skymap's native shell. Everything the user sees is the web client in
//! `../src`; this crate exists to package it for Android (and later iOS and
//! desktop) and to hand it the device capabilities a WebView doesn't get on
//! its own, starting with location. atproto-iroh-core links in here when
//! Tables arrive.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .run(tauri::generate_context!())
        .expect("error while running skymap");
}
