//! Spotify's own web player in a window of the app, for any account (free or
//! Premium): sign-in happens on Spotify's page, so the app never sees the
//! password. The window gets no access to the app (no capability lists it,
//! and remote pages get no IPC) and keeps its cookies in its own folder, apart
//! from the app's pages. What it plays shows up in the home screen's music tab
//! like any other player.

use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "spotify";
const URL: &str = "https://open.spotify.com/";

pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("web").join("spotify");
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(URL.parse().unwrap()))
        .title("Spotify")
        .theme(Some(Theme::Dark))
        .maximized(true)
        .data_directory(data)
        // Only secure pages (Spotify and the sign-in providers it sends to).
        .on_navigation(|url| url.scheme() == "https")
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
