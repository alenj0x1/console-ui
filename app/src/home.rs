//! The full-screen home screen: window, data commands and the `cui` protocol
//! that serves game art, app icons and the music cover to the page.
//!
//! Protocol paths (http://cui.localhost/… on Windows):
//!   /art/<game id>/<hero|capsule|header|logo>   Steam's own files
//!   /icon/<app id>                              PNG, cached in app data
//!   /cover                                      current track's cover
//!   /wallpaper/<id>                             background file (byte ranges)
//!   /wallpaper-preview/<id>                     its preview picture
//!   /trailer/<game id>                          the game's saved trailer (video)
//!   /trailer-sound/<game id>                    its sound (M4A)

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, UriSchemeContext, UriSchemeResponder, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::library::{self, Library};
use crate::media::MEDIA;
use crate::store::Store;
use crate::sources::trailers::{self, Trailers};
use crate::sources::{self, Wallpaper, builtin, folders, wallpaper_engine};

pub const LABEL: &str = "home";
const RESCAN_AFTER: Duration = Duration::from_secs(60);
const ICON_SIZE: i32 = 128;
const PREVIEW_SIZE: i32 = 400;
/// Largest piece of a video sent per request; the player asks for the rest.
const CHUNK: u64 = 4 * 1024 * 1024;
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
    wallpapers: Mutex<Vec<Wallpaper>>,
    trailers: Mutex<Option<Arc<Trailers>>>,
    /// Games whose trailer is being downloaded.
    fetching: Mutex<std::collections::HashSet<String>>,
    scanned: Mutex<Option<Instant>>,
    icons: Mutex<HashMap<String, Vec<u8>>>,
    icon_dir: Mutex<Option<PathBuf>>,
    /// The game being played and its window, while it stays open.
    running: Mutex<Option<(String, isize)>>,
}

#[derive(Serialize)]
pub struct HomeData {
    games: Vec<sources::Game>,
    apps: Vec<library::AppEntry>,
    pinned: Vec<String>,
    wallpaper: Option<Wallpaper>,
    game_art: bool,
    /// The media tab's picks; None = not chosen yet.
    media: Option<Vec<String>>,
    /// The game played last, and whether its window is still open.
    last_game: Option<String>,
    running: bool,
}

#[derive(Serialize)]
pub struct Wallpapers {
    items: Vec<Wallpaper>,
    /// A wallpaper id, or "none".
    current: String,
    /// Wallpaper Engine is installed (its Workshop can be opened).
    engine: bool,
    /// Folders added by the user.
    folders: Vec<String>,
}

/// The id "none" is the plain colour.
const NO_WALLPAPER: &str = "none";

fn rescan_wallpapers(app: &AppHandle) {
    let settings = app.state::<Store>().settings.lock().unwrap().clone();
    let walls = sources::wallpapers(&settings);
    *app.state::<HomeState>().wallpapers.lock().unwrap() = walls;
}

fn current_wallpaper(store: &Store) -> String {
    store.settings.lock().unwrap().wallpaper.clone().unwrap_or_else(|| builtin::DEFAULT.into())
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<HomeState>();
    *state.icon_dir.lock().unwrap() = Some(app.path().app_data_dir()?.join("icons"));
    *state.trailers.lock().unwrap() = Some(Arc::new(Trailers::new(trailers::dir(&app.path().app_data_dir()?))));
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
        rescan_wallpapers(&app);
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
    let wallpaper = state.wallpaper(&current_wallpaper(&store));
    let settings = store.settings.lock().unwrap().clone();
    let media = settings.media.map(|m| m.into_iter().filter(|id| valid_media(&lib, id)).collect());
    let last_game = settings.last_game.filter(|id| lib.has_game(id));
    let (games, apps, pinned) = (lib.games.clone(), lib.apps.clone(), pinned(&store, &lib));
    // window_of reads the library too.
    drop(lib);
    let running = last_game.as_ref().is_some_and(|id| state.window_of(id).is_some());
    HomeData { games, apps, pinned, wallpaper, game_art: settings.game_art, media, last_game, running }
}

impl HomeState {
    /// An open window of a game: the one game mode handed the controller to,
    /// or any window of a program from the game's folder (however it was
    /// started).
    fn window_of(&self, id: &str) -> Option<isize> {
        {
            let mut running = self.running.lock().unwrap();
            match running.as_ref() {
                Some((game, hwnd)) if game == id && crate::switcher::alive(*hwnd as _) => return Some(*hwnd),
                Some((_, hwnd)) if !crate::switcher::alive(*hwnd as _) => *running = None,
                _ => {}
            }
        }
        let lib = self.library.lock().unwrap();
        let dir = lib.games.iter().find(|g| g.id == id)?.dir.clone()?;
        drop(lib);
        crate::switcher::find_window(|p| sources::inside(p, &dir)).map(|h| h as isize)
    }
}

/// A game came to the front (game mode found it): if it is one of the
/// library's, it becomes the last game played and its window is kept for
/// "Reanudar".
pub fn game_started(app: &AppHandle, hwnd: isize, program: &Path) {
    let state = app.state::<HomeState>();
    let Some(id) = state.library.lock().unwrap().game_of(program).map(|g| g.id.clone()) else { return };
    *state.running.lock().unwrap() = Some((id.clone(), hwnd));
    let store = app.state::<Store>();
    if store.settings.lock().unwrap().last_game.as_deref() != Some(&id) {
        let _ = store.update(|s| s.last_game = Some(id));
    }
}

impl HomeState {
    fn wallpaper(&self, id: &str) -> Option<Wallpaper> {
        self.wallpapers.lock().unwrap().iter().find(|w| w.id == id).cloned()
    }
}

/// Every background, scanned again (a Workshop subscription or a new file
/// shows up right away).
#[tauri::command]
pub async fn wallpapers(app: AppHandle) -> Wallpapers {
    let scan = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || rescan_wallpapers(&scan)).await;
    let store = app.state::<Store>();
    let folders = store.settings.lock().unwrap().wallpaper_folders.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let items = app.state::<HomeState>().wallpapers.lock().unwrap().clone();
    Wallpapers { items, current: current_wallpaper(&store), engine: wallpaper_engine::installed(), folders }
}

#[tauri::command]
pub fn set_wallpaper(webview: tauri::Webview, state: tauri::State<HomeState>, store: tauri::State<Store>, id: String) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    if id != NO_WALLPAPER && state.wallpaper(&id).is_none() {
        return Err("fondo desconocido".into());
    }
    store.set_wallpaper(id)
}

/// Whether the game's trailer is ready to play. If it was never looked for,
/// it is downloaded in the background and "trailer" (with the game id) is
/// sent to the page when ready. A trailer saved before sound was kept gets
/// its sound the same way, with "trailer-sound".
#[tauri::command]
pub fn game_trailer(webview: tauri::Webview, app: AppHandle, state: tauri::State<HomeState>, id: String) -> bool {
    if crate::only_from(&webview, &[LABEL]).is_err() {
        return false;
    }
    let Some(t) = state.trailers.lock().unwrap().clone() else { return false };
    if t.cached(&id).is_some() {
        // Not while the trailer itself is still downloading: its sound comes with it.
        let key = format!("{id}#sound");
        let busy = state.fetching.lock().unwrap().contains(&id);
        if !busy && !t.sound_known(&id) && state.fetching.lock().unwrap().insert(key.clone()) {
            std::thread::spawn(move || {
                let ready = matches!(t.fetch_sound(&id), Ok(Some(_)));
                app.state::<HomeState>().fetching.lock().unwrap().remove(&key);
                if ready {
                    let _ = app.emit_to(LABEL, "trailer-sound", id);
                }
            });
        }
        return true;
    }
    let in_library = state.library.lock().unwrap().games.iter().any(|g| g.id == id);
    if !in_library || t.known(&id) || !state.fetching.lock().unwrap().insert(id.clone()) {
        return false;
    }
    std::thread::spawn(move || {
        let ready = matches!(t.fetch(&id), Ok(Some(_)));
        app.state::<HomeState>().fetching.lock().unwrap().remove(&id);
        if ready {
            let _ = app.emit_to(LABEL, "trailer", id);
        }
    });
    false
}

/// Streaming sites of the media tab; the page asks by id, never by address.
const SERVICES: [(&str, &str); 6] = [
    ("youtube", "https://www.youtube.com/"),
    ("youtube-music", "https://music.youtube.com/"),
    ("netflix", "https://www.netflix.com/"),
    ("twitch", "https://www.twitch.tv/"),
    ("prime-video", "https://www.primevideo.com/"),
    ("disney-plus", "https://www.disneyplus.com/"),
];

/// Opens a streaming site in the default browser (where the user is signed in).
#[tauri::command]
pub fn open_service(webview: tauri::Webview, app: AppHandle, id: String) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    if app.state::<crate::AppState>().mode.load(std::sync::atomic::Ordering::Relaxed) != crate::mode_code(padcore::Mode::Home) {
        return Err("la pantalla de Inicio no está activa".into());
    }
    let url = SERVICES.iter().find(|(s, _)| *s == id).map(|(_, u)| *u).ok_or("servicio desconocido")?;
    library::shell_open(url)
}

#[tauri::command]
pub fn open_workshop(webview: tauri::Webview, ) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    wallpaper_engine::open_workshop()
}

#[tauri::command]
pub async fn browse_folders(webview: tauri::Webview, path: Option<String>) -> Result<folders::Listing, String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    tauri::async_runtime::spawn_blocking(move || folders::browse(path.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn add_wallpaper_folder(webview: tauri::Webview, store: tauri::State<Store>, path: String) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    let dir = PathBuf::from(&path);
    if !folders::local_dir(&dir) {
        return Err("carpeta no encontrada".into());
    }
    let mut list = store.settings.lock().unwrap().wallpaper_folders.clone();
    if !list.iter().any(|d| sources::key(d) == sources::key(&dir)) {
        list.push(dir);
        store.set_wallpaper_folders(list)?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_wallpaper_folder(webview: tauri::Webview, store: tauri::State<Store>, path: String) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    let gone = sources::key(Path::new(&path));
    let list = store.settings.lock().unwrap().wallpaper_folders.clone();
    store.set_wallpaper_folders(list.into_iter().filter(|d| sources::key(d) != gone).collect())
}

#[tauri::command]
pub fn set_game_art(webview: tauri::Webview, store: tauri::State<Store>, on: bool) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    store.set_game_art(on)
}

#[tauri::command]
pub fn set_pinned(webview: tauri::Webview, state: tauri::State<HomeState>, store: tauri::State<Store>, ids: Vec<String>) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    let lib = state.library.lock().unwrap();
    if ids.iter().any(|id| !lib.has_app(id)) {
        return Err("app desconocida".into());
    }
    store.set_pinned(ids)
}

fn valid_media(lib: &Library, id: &str) -> bool {
    match id.strip_prefix("web:") {
        Some(site) => SERVICES.iter().any(|(s, _)| *s == site),
        None => lib.has_app(id),
    }
}

#[tauri::command]
pub fn set_media(webview: tauri::Webview, state: tauri::State<HomeState>, store: tauri::State<Store>, ids: Vec<String>) -> Result<(), String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    let lib = state.library.lock().unwrap();
    if ids.iter().any(|id| !valid_media(&lib, id)) {
        return Err("app o sitio desconocido".into());
    }
    store.set_media(ids)
}

/// Launches a game or app; returns true for games (the caller hands the
/// controller to the game) and false for apps (back to the cursor).
#[tauri::command]
pub fn launch(webview: tauri::Webview, app: AppHandle, state: tauri::State<HomeState>, events: tauri::State<crate::events::Events>, id: String) -> Result<bool, String> {
    crate::only_from(&webview, &[crate::home::LABEL])?;
    // Only the visible home screen may launch anything.
    if app.state::<crate::AppState>().mode.load(std::sync::atomic::Ordering::Relaxed) != crate::mode_code(padcore::Mode::Home) {
        events.log(&format!("inicio rechaza abrir {id}: no está en modo Inicio"));
        return Err("la pantalla de Inicio no está activa".into());
    }
    // A game still open comes back to the front instead of starting again.
    if let Some(hwnd) = state.window_of(&id) {
        events.log(&format!("inicio reanuda {id}"));
        crate::switcher::activate(hwnd as _);
        return Ok(true);
    }
    events.log(&format!("inicio abre {id}"));
    let is_game = state.library.lock().unwrap().launch(&id)?;
    if is_game {
        let _ = app.state::<Store>().update(|s| s.last_game = Some(id));
    }
    Ok(is_game)
}

#[tauri::command]
pub async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::media::control_blocking(&action)).await.map_err(|e| e.to_string())?
}

/// The lyrics of what is playing, from the internet (see songinfo). Ok(None)
/// = none found, or looking them up is turned off.
#[tauri::command]
pub async fn lyrics(webview: tauri::Webview, store: tauri::State<'_, Store>) -> Result<Option<crate::songinfo::Lyrics>, String> {
    crate::only_from(&webview, &[LABEL])?;
    if !store.settings.lock().unwrap().music_online {
        return Ok(None);
    }
    let now = MEDIA.now.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || crate::songinfo::lyrics(&now.title, &now.artist, now.duration_ms)).await.map_err(|e| e.to_string())?
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
        // Lets the home page read colours (canvas): the cover's for the music
        // stage and each app icon's for its card.
        .header("Access-Control-Allow-Origin", "http://tauri.localhost")
        .body(body)
        .unwrap()
}

/// Never kept by the page: the file may exist a moment later (a trailer's
/// sound, a cover).
fn not_found() -> Response<Vec<u8>> {
    let mut r = respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    r.headers_mut().insert("Cache-Control", "no-store".parse().unwrap());
    r
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // Bytes, not the str: a '%' before a multi-byte letter can't split it.
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
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

/// A file, or the byte range the video player asked for (206).
fn file_response(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let Ok(mut f) = std::fs::File::open(path) else { return not_found() };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return not_found() };
    let mime = sources::mime(path);
    // "bytes=start-" or "bytes=start-end"; anything else gets the whole file.
    let wanted = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
        let (a, b) = r.split_once('-')?;
        let start: u64 = a.trim().parse().ok()?;
        let end: u64 = if b.trim().is_empty() { len.saturating_sub(1) } else { b.trim().parse().ok()? };
        Some((start, end.min(len.saturating_sub(1))))
    });
    let Some((start, end)) = wanted else {
        if len > CHUNK * 64 {
            // Too big to send at once; players always ask by range anyway.
            return file_response(path, Some("bytes=0-"));
        }
        let mut body = Vec::with_capacity(len as usize);
        return match f.read_to_end(&mut body) {
            Ok(_) => Response::builder().header("Accept-Ranges", "bytes").header("Content-Type", mime).body(body).unwrap(),
            Err(_) => not_found(),
        };
    };
    if start > end || start >= len {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap();
    }
    let end = end.min(start + CHUNK - 1);
    let mut body = vec![0u8; (end - start + 1) as usize];
    if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut body)).is_err() {
        return not_found();
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{len}"))
        .body(body)
        .unwrap()
}

fn wallpaper_preview(w: &Wallpaper) -> Option<Response<Vec<u8>>> {
    if let Some(p) = &w.preview {
        let body = std::fs::read(p).ok()?;
        return Some(respond(StatusCode::OK, sources::mime(p), body));
    }
    let png = crate::library::thumbnail_png(&w.file, PREVIEW_SIZE).ok()?;
    Some(respond(StatusCode::OK, "image/png", png))
}

pub fn protocol(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    // Every webview of the app gets the scheme: only the home
    // screen may read the user's games, apps and backgrounds, and the guide
    // its windows and the music.
    let guide = ctx.webview_label() == crate::guide::LABEL;
    if ctx.webview_label() != LABEL && !guide {
        return responder.respond(respond(StatusCode::FORBIDDEN, "text/plain", Vec::new()));
    }
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    std::thread::spawn(move || {
        let parts: Vec<String> = path.trim_start_matches('/').split('/').map(decode).collect();
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        let switcher = &app.state::<crate::guide::GuideState>().switcher;
        let response = match parts.as_slice() {
            ["window-shot", id] if guide => switcher.shot(id).map_or_else(not_found, |b| respond(StatusCode::OK, "image/png", b)),
            ["window-icon", id] if guide => switcher.icon(id).map_or_else(not_found, |b| respond(StatusCode::OK, "image/png", b)),
            ["cover"] => match MEDIA.cover.lock().unwrap().clone() {
                Some(b) => respond(StatusCode::OK, "image/jpeg", b),
                None => not_found(),
            },
            _ if guide => not_found(),
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
            ["wallpaper", id] => match app.state::<HomeState>().wallpaper(id) {
                Some(w) => file_response(&w.file, range.as_deref()),
                None => not_found(),
            },
            ["trailer", id] => {
                let t = app.state::<HomeState>().trailers.lock().unwrap().clone();
                match t.and_then(|t| t.cached(id)) {
                    Some(f) => file_response(&f, range.as_deref()),
                    None => not_found(),
                }
            }
            ["trailer-sound", id] => {
                let t = app.state::<HomeState>().trailers.lock().unwrap().clone();
                match t.and_then(|t| t.cached_sound(id)) {
                    Some(f) => file_response(&f, range.as_deref()),
                    None => not_found(),
                }
            }
            ["wallpaper-preview", id] => app.state::<HomeState>().wallpaper(id).and_then(|w| wallpaper_preview(&w)).unwrap_or_else(not_found),
            _ => not_found(),
        };
        responder.respond(response);
    });
}
