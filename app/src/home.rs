//! The full-screen home screen: window, data commands and the `cui` protocol
//! that serves game art, app icons and the music cover to the page.
//!
//! Protocol paths (http://cui.localhost/… on Windows):
//!   /art/<game id>/<hero|capsule|header|logo>   Steam's own files
//!   /icon/<app id>                              PNG, cached in app data
//!   /cover                                      current track's cover

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::library::{self, Library};
use crate::media::MEDIA;
use crate::store::Store;

pub const LABEL: &str = "home";
const RESCAN_AFTER: Duration = Duration::from_secs(60);
const ICON_SIZE: i32 = 128;
/// Apps pinned until the user chooses: matched by id, in this order.
const DEFAULT_PINNED: [&str; 7] = [
    "Spotify",
    "Chrome",
    "MSEdge",
    "Firefox",
    "com.squirrel.Discord.Discord",
    "Microsoft.Windows.Explorer",
    "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
];

#[derive(Default)]
pub struct HomeState {
    pub library: Arc<Mutex<Library>>,
    scanned: Mutex<Option<Instant>>,
    icons: Mutex<HashMap<String, Vec<u8>>>,
    icon_dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
pub struct HomeData {
    games: Vec<library::Game>,
    apps: Vec<library::AppEntry>,
    pinned: Vec<String>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<HomeState>();
    *state.icon_dir.lock().unwrap() = Some(app.path().app_data_dir()?.join("icons"));
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("home.html".into()))
        .title("Inicio")
        .decorations(false)
        .fullscreen(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    rescan(app.clone(), true);
    Ok(())
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = handle.get_webview_window(LABEL) else { return };
        if visible {
            let _ = w.show();
            let _ = w.set_focus();
        } else {
            let _ = w.hide();
        }
    });
    if visible {
        rescan(app.clone(), false);
    }
}

/// Re-reads games and apps in the background (at most once a minute unless
/// forced) and tells the page when done.
fn rescan(app: AppHandle, force: bool) {
    {
        let state = app.state::<HomeState>();
        let mut at = state.scanned.lock().unwrap();
        if !force && at.is_some_and(|t| t.elapsed() < RESCAN_AFTER) {
            return;
        }
        *at = Some(Instant::now());
    }
    std::thread::spawn(move || {
        let lib = Library::scan();
        *app.state::<HomeState>().library.lock().unwrap() = lib;
        let _ = app.emit_to(LABEL, "library", ());
    });
}

fn pinned(store: &Store, lib: &Library) -> Vec<String> {
    match store.settings.lock().unwrap().pinned.clone() {
        Some(p) => p.into_iter().filter(|id| lib.has_app(id)).collect(),
        None => DEFAULT_PINNED
            .iter()
            .filter_map(|want| lib.apps.iter().find(|a| a.id.eq_ignore_ascii_case(want)).map(|a| a.id.clone()))
            .collect(),
    }
}

#[tauri::command]
pub fn home_data(state: tauri::State<HomeState>, store: tauri::State<Store>) -> HomeData {
    let lib = state.library.lock().unwrap();
    HomeData { games: lib.games.clone(), apps: lib.apps.clone(), pinned: pinned(&store, &lib) }
}

#[tauri::command]
pub fn set_pinned(state: tauri::State<HomeState>, store: tauri::State<Store>, ids: Vec<String>) -> Result<(), String> {
    let lib = state.library.lock().unwrap();
    if ids.iter().any(|id| !lib.has_app(id)) {
        return Err("app desconocida".into());
    }
    store.set_pinned(ids)
}

/// Launches a game or app; returns true for games (the caller hands the
/// controller to the game) and false for apps (back to the cursor).
#[tauri::command]
pub fn launch(app: AppHandle, state: tauri::State<HomeState>, events: tauri::State<crate::events::Events>, id: String) -> Result<bool, String> {
    // Only the visible home screen may launch anything.
    if app.state::<crate::AppState>().mode.load(std::sync::atomic::Ordering::Relaxed) != crate::mode_code(padcore::Mode::Home) {
        events.log(&format!("inicio rechaza abrir {id}: no está en modo Inicio"));
        return Err("la pantalla de Inicio no está activa".into());
    }
    events.log(&format!("inicio abre {id}"));
    state.library.lock().unwrap().launch(&id)
}

#[tauri::command]
pub async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::media::control_blocking(&action)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn media_now() -> crate::media::NowPlaying {
    MEDIA.now.lock().unwrap().clone()
}

/// Largest volume change one press may ask for.
const MAX_VOLUME_STEP: f32 = 0.2;

#[tauri::command]
pub async fn volume_get() -> Result<crate::audio::Volume, String> {
    tauri::async_runtime::spawn_blocking(crate::audio::get).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn volume_step(delta: f32) -> Result<crate::audio::Volume, String> {
    let delta = delta.clamp(-MAX_VOLUME_STEP, MAX_VOLUME_STEP);
    tauri::async_runtime::spawn_blocking(move || crate::audio::step(delta)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn volume_mute() -> Result<crate::audio::Volume, String> {
    tauri::async_runtime::spawn_blocking(crate::audio::toggle_mute).await.map_err(|e| e.to_string())?
}

// ---------- protocol ----------

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "max-age=3600")
        // Lets the page read the cover's colours (canvas) for the music stage.
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
}

fn decode(s: &str) -> String {
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

/// File name for an app id in the icon cache (FNV-1a, hex).
fn icon_key(id: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}.png")
}

fn icon(app: &AppHandle, id: &str) -> Option<Vec<u8>> {
    let state = app.state::<HomeState>();
    if !state.library.lock().unwrap().has_app(id) {
        return None;
    }
    if let Some(png) = state.icons.lock().unwrap().get(id) {
        return Some(png.clone());
    }
    let file = state.icon_dir.lock().unwrap().as_ref().map(|d| d.join(icon_key(id)));
    let png = match file.as_ref().and_then(|f| std::fs::read(f).ok()) {
        Some(png) => png,
        None => {
            let png = library::app_icon_png(id, ICON_SIZE).ok()?;
            if let Some(f) = &file {
                let _ = std::fs::create_dir_all(f.parent()?);
                let _ = std::fs::write(f, &png);
            }
            png
        }
    };
    state.icons.lock().unwrap().insert(id.to_owned(), png.clone());
    Some(png)
}

pub fn protocol(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    std::thread::spawn(move || {
        let parts: Vec<String> = path.trim_start_matches('/').split('/').map(decode).collect();
        let response = match parts.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["art", game, kind] => {
                let file = app.state::<HomeState>().library.lock().unwrap().art(game, kind).map(PathBuf::from);
                match file.and_then(|f| std::fs::read(&f).ok().map(|b| (f, b))) {
                    Some((f, body)) => {
                        let png = f.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
                        respond(StatusCode::OK, if png { "image/png" } else { "image/jpeg" }, body)
                    }
                    None => not_found(),
                }
            }
            ["icon", id] => icon(&app, id).map_or_else(not_found, |b| respond(StatusCode::OK, "image/png", b)),
            ["cover"] => match MEDIA.cover.lock().unwrap().clone() {
                Some(b) => respond(StatusCode::OK, "image/jpeg", b),
                None => not_found(),
            },
            _ => not_found(),
        };
        responder.respond(response);
    });
}
