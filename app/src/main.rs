//! Console UI desktop app: hosts the input engine, the on-screen keyboard and
//! the home screen.
//! Opening the app shows the home screen; `--background` starts it quietly
//! in the tray (e.g. with Windows). `--lab` opens the typing lab instead.
//! The tray icon opens the home screen on click and has a small menu.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod admin;
mod audio;
mod events;
mod guard;
mod home;
mod library;
mod media;
mod overlay;
mod sources;
mod store;
mod web_player;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use padcore::{Engine, EngineConfig, Event, Hover, Mode, hover, inject};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use serde::Serialize;
use store::Store;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const ACTIVE_TICK: Duration = Duration::from_millis(4);
const IDLE_TICK: Duration = Duration::from_millis(16);
const IDLE_AFTER: Duration = Duration::from_secs(3);
const NO_PAD_TICK: Duration = Duration::from_millis(500);
/// Longest text one keyboard action may type (a key or a suggestion).
const MAX_TYPED: usize = 32;
/// Learned words are written to disk at most this often (and on exit).
const SAVE_EVERY: Duration = Duration::from_secs(15);
/// How often cursor mode checks whether an admin window has the focus.
const ADMIN_CHECK_EVERY: Duration = Duration::from_millis(400);

enum EngineCmd {
    SetMode(Mode),
    Stop,
}

struct AppState {
    cmd: Mutex<Sender<EngineCmd>>,
    engine: Mutex<Option<JoinHandle<()>>>,
    /// Labs start from a neutral keyboard: no learned words, nothing learned.
    lab: bool,
    /// Current mode, mirrored for the tray menu.
    mode: AtomicU8,
}

impl AppState {
    fn send(&self, m: Mode) {
        if let Ok(tx) = self.cmd.lock() {
            let _ = tx.send(EngineCmd::SetMode(m));
        }
    }
}

fn mode_code(m: Mode) -> u8 {
    match m {
        Mode::Off => 0,
        Mode::Cursor => 1,
        Mode::Keyboard => 2,
        Mode::Home => 3,
    }
}

#[derive(Serialize)]
struct KeyboardConfig {
    languages: Vec<String>,
    available: Vec<&'static str>,
    learn: bool,
    learned: store::Learned,
}

fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Off => "off",
        Mode::Cursor => "cursor",
        Mode::Keyboard => "keyboard",
        Mode::Home => "home",
    }
}

fn apply_mode(app: &AppHandle, m: Mode) {
    app.state::<AppState>().mode.store(mode_code(m), Ordering::Relaxed);
    app.state::<events::Events>().log(&format!("modo {}", mode_name(m)));
    if !app.state::<AppState>().lab {
        // Games get the controller only in game mode; otherwise only we see it.
        let handle = app.clone();
        std::thread::spawn(move || handle.state::<guard::Guard>().set_hidden(m != Mode::Off));
    }
    overlay::set_visible(app, m == Mode::Keyboard);
    home::set_visible(app, m == Mode::Home);
    let _ = app.emit("mode", mode_name(m));
}

fn engine_loop(app: AppHandle, rx: Receiver<EngineCmd>, lab: bool, open_home: bool) {
    let profile = padcore::profile("asistido").expect("built-in profile");
    let mut cfg = EngineConfig::with_profile(profile);
    cfg.keyboard_enabled = true;
    cfg.keyboard_locked = lab;
    let stop = Arc::new(AtomicBool::new(false));
    let hover_state = Hover::new();
    let probe = hover::spawn_probe(hover_state.clone(), stop.clone());
    let mut engine = Engine::new(cfg).with_hover(hover_state);
    let mut events = Vec::new();
    // Admin window in front: its handle (as a number), shown in the notice.
    let mut blocked_by: Option<isize> = None;
    let mut last_admin_check = std::time::Instant::now();
    if open_home {
        engine.set_mode(Mode::Home);
        apply_mode(&app, Mode::Home);
    }
    loop {
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                EngineCmd::SetMode(m) => {
                    engine.set_mode(m);
                    apply_mode(&app, m);
                }
                EngineCmd::Stop => {
                    stop.store(true, Ordering::Relaxed);
                    let _ = probe.join();
                    return; // dropping the engine releases held buttons
                }
            }
        }
        if last_admin_check.elapsed() >= ADMIN_CHECK_EVERY {
            last_admin_check = std::time::Instant::now();
            let now = if engine.mode() == Mode::Cursor && !lab { admin::elevated_foreground() } else { None };
            let key = now.as_ref().map(|f| f.hwnd as isize);
            if key != blocked_by {
                blocked_by = key;
                engine.set_blocked(now.is_some());
                if let Some(f) = &now {
                    let left = padcore::inject::button_is_down(padcore::inject::MouseButton::Left);
                    app.state::<events::Events>().log(&format!("ventana de administrador al frente (izquierdo presionado: {left})"));
                    let _ = app.emit_to(overlay::NOTICE, "notice", f.title.clone());
                }
                overlay::set_notice_visible(&app, now.is_some());
            }
        }
        engine.step(&mut events);
        for e in events.drain(..) {
            match e {
                Event::ModeChanged(m) => apply_mode(&app, m),
                Event::Rescue => {
                    if let Some(from) = blocked_by.take() {
                        app.state::<events::Events>().log("B: devolver el foco");
                        engine.set_blocked(false);
                        overlay::rescue(&app, from);
                        let h = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(500));
                            let left = padcore::inject::button_is_down(padcore::inject::MouseButton::Left);
                            h.state::<events::Events>().log(&format!("tras B (izquierdo presionado: {left})"));
                        });
                    }
                }
                Event::Ui(u) => {
                    let target = if engine.mode() == Mode::Home { home::LABEL } else { overlay::LABEL };
                    let _ = app.emit_to(target, "pad", u);
                }
                Event::Connected(_) => {
                    let _ = app.emit("pad-connected", true);
                    if !lab {
                        let (handle, mode) = (app.clone(), engine.mode());
                        std::thread::spawn(move || {
                            let g = handle.state::<guard::Guard>();
                            g.register();
                            g.set_hidden(mode != Mode::Off);
                        });
                    }
                }
                Event::Disconnected => {
                    let _ = app.emit("pad-connected", false);
                }
            }
        }
        let tick = if !engine.connected() {
            NO_PAD_TICK
        } else if matches!(engine.mode(), Mode::Keyboard | Mode::Home) || engine.idle_for() <= IDLE_AFTER {
            ACTIVE_TICK
        } else {
            IDLE_TICK
        };
        std::thread::sleep(tick);
    }
}

#[tauri::command]
fn current_mode(state: State<AppState>) -> &'static str {
    match state.mode.load(Ordering::Relaxed) {
        0 => "off",
        2 => "keyboard",
        3 => "home",
        _ => "cursor",
    }
}

/// Logs where the keyboard is typing (the program, never the text), at most
/// once per foreground program change.
#[tauri::command]
fn note_typing(events: State<events::Events>, last: State<Mutex<String>>) {
    let now = events::foreground_program();
    if let Ok(mut l) = last.lock() {
        if *l != now {
            *l = now;
            events.log("teclado: escribiendo");
        }
    }
}

#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    if !valid_typed(&text) {
        return Err("texto no permitido".into());
    }
    inject::type_text(&text);
    Ok(())
}

fn valid_typed(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= MAX_TYPED && !text.chars().any(char::is_control)
}

/// Swaps the word being typed for a suggestion.
#[tauri::command]
fn replace_word(delete: usize, text: String) -> Result<(), String> {
    if delete > MAX_TYPED || !valid_typed(&text) {
        return Err("reemplazo no permitido".into());
    }
    inject::replace_text(delete, &text);
    Ok(())
}

#[tauri::command]
fn press_key(events: State<events::Events>, key: String) -> Result<(), String> {
    if key == "enter" {
        events.log("teclado: intro");
    }
    if inject::key_named(&key) { Ok(()) } else { Err(format!("tecla desconocida: {key}")) }
}

#[tauri::command]
fn set_mode(state: State<AppState>, mode: String) -> Result<(), String> {
    let m = match mode.as_str() {
        "off" => Mode::Off,
        "cursor" => Mode::Cursor,
        "keyboard" => Mode::Keyboard,
        "home" => Mode::Home,
        _ => return Err(format!("modo desconocido: {mode}")),
    };
    state.cmd.lock().map_err(|e| e.to_string())?.send(EngineCmd::SetMode(m)).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_layout(app: AppHandle, layout: String) -> Result<(), String> {
    if !matches!(layout.as_str(), "grid" | "split") {
        return Err(format!("diseño desconocido: {layout}"));
    }
    app.emit_to(overlay::LABEL, "layout", layout).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_suggest(app: AppHandle, on: bool) -> Result<(), String> {
    app.emit_to(overlay::LABEL, "suggest", on).map_err(|e| e.to_string())
}

#[tauri::command]
fn keyboard_config(state: State<AppState>, store: State<Store>) -> Result<KeyboardConfig, String> {
    Ok(KeyboardConfig {
        languages: store.settings.lock().map_err(|e| e.to_string())?.languages.clone(),
        available: store::LANGUAGES.to_vec(),
        learn: !state.lab,
        learned: if state.lab { store::Learned::default() } else { store.learned.lock().map_err(|e| e.to_string())?.clone() },
    })
}

#[tauri::command]
fn set_languages(store: State<Store>, languages: Vec<String>) -> Result<(), String> {
    store.set_languages(languages)
}

#[tauri::command]
fn learn_word(state: State<AppState>, store: State<Store>, prev: String, word: String) -> Result<(), String> {
    if state.lab {
        return Ok(());
    }
    store.learn(&prev, &word)
}

#[tauri::command]
fn forget_learned(store: State<Store>) -> Result<(), String> {
    store.forget()
}

/// Suggestions and learning stay off in password fields.
#[tauri::command]
async fn focus_is_password() -> bool {
    tauri::async_runtime::spawn_blocking(padcore::hover::focused_is_password).await.unwrap_or(true)
}

/// Saves a lab result next to the lab's notes. Returns the file path.
#[tauri::command]
fn lab_save(json: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../labs/keyboard-lab/results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let path = dir.join(format!("{stamp}.json"));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.canonicalize().unwrap_or(path).display().to_string())
}

fn main() {
    // `--guard <pid>`: the watchdog started by `guard::spawn_watchdog`.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pid) = args.iter().position(|a| a == "--guard").and_then(|i| args.get(i + 1)?.parse().ok()) {
        guard::watchdog(pid);
        return;
    }
    let lab = std::env::args().any(|a| a == "--lab");
    let open_home = !lab && !std::env::args().any(|a| a == "--background");
    // Which comparison the lab runs: "layouts" (default) or "suggest".
    let experiment = std::env::args()
        .find_map(|a| a.strip_prefix("--exp=").map(str::to_owned))
        .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "layouts".into());
    let (tx, rx) = mpsc::channel();
    let rx = Mutex::new(Some(rx));

    let app = tauri::Builder::default()
        .manage(AppState { cmd: Mutex::new(tx), engine: Mutex::new(None), lab, mode: AtomicU8::new(1) })
        .manage(home::HomeState::default())
        .manage(guard::Guard::default())
        .manage(events::Events::default())
        .manage(Mutex::new(String::new()))
        .register_asynchronous_uri_scheme_protocol("cui", home::protocol)
        .invoke_handler(tauri::generate_handler![
            type_text,
            note_typing,
            current_mode,
            replace_word,
            press_key,
            set_mode,
            set_layout,
            set_suggest,
            keyboard_config,
            set_languages,
            learn_word,
            forget_learned,
            focus_is_password,
            home::home_data,
            home::set_pinned,
            home::launch,
            home::media_control,
            home::media_now,
            home::volume_get,
            home::volume_step,
            home::volume_mute,
            home::wallpapers,
            home::set_wallpaper,
            home::set_game_art,
            home::open_workshop,
            home::open_spotify,
            home::game_trailer,
            home::browse_folders,
            home::add_wallpaper_folder,
            home::remove_wallpaper_folder,
            lab_save
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(Store::load(app.path().app_data_dir()?));
            app.state::<events::Events>().open(app.path().app_data_dir()?);
            app.state::<events::Events>().log(&format!("inicio {}", env!("CARGO_PKG_VERSION")));
            {
                let h = handle.clone();
                std::thread::Builder::new().name("store".into()).spawn(move || loop {
                    std::thread::sleep(SAVE_EVERY);
                    let _ = h.state::<Store>().flush();
                })?;
            }
            overlay::create(&handle)?;
            overlay::create_notice(&handle)?;
            if !lab {
                home::create(&handle)?;
                media::Media::start(handle.clone());
            }

            let items = [
                MenuItem::with_id(app, "home", "Abrir Inicio", !lab, None::<&str>)?,
                MenuItem::with_id(app, "keyboard", "Abrir teclado", true, None::<&str>)?,
                MenuItem::with_id(app, "games", "Dejar el control a los juegos", true, None::<&str>)?,
                MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?,
            ];
            let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as _).collect();
            let games_item = items[2].clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Console UI")
                .menu(&Menu::with_items(app, &refs)?)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, e| {
                    let state = app.state::<AppState>();
                    match e.id().as_ref() {
                        "home" => state.send(Mode::Home),
                        "keyboard" => state.send(Mode::Keyboard),
                        "games" => {
                            // Toggles: games get the controller, or it comes back as the cursor.
                            let off = state.mode.load(Ordering::Relaxed) == mode_code(Mode::Off);
                            state.send(if off { Mode::Cursor } else { Mode::Off });
                            let _ = games_item.set_text(if off { "Dejar el control a los juegos" } else { "Volver a usar el control en Windows" });
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        if !lab {
                            tray.app_handle().state::<AppState>().send(Mode::Home);
                        }
                    }
                })
                .build(app)?;

            if lab {
                WebviewWindowBuilder::new(app, "lab", WebviewUrl::App(format!("lab.html?exp={experiment}").into()))
                    .title("Laboratorio del teclado")
                    .maximized(true)
                    .build()?;
            }

            if !lab {
                guard::spawn_watchdog();
            }
            let rx = rx.lock().ok().and_then(|mut r| r.take()).expect("engine channel");
            let h = handle.clone();
            let join = std::thread::Builder::new()
                .name("engine".into())
                .spawn(move || engine_loop(h, rx, lab, open_home))?;
            *app.state::<AppState>().engine.lock().expect("state") = Some(join);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build app");

    app.run(|app, event| match event {
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "lab" => app.exit(0),
        RunEvent::Exit => {
            let state = app.state::<AppState>();
            if let Ok(tx) = state.cmd.lock() {
                let _ = tx.send(EngineCmd::Stop);
            }
            if let Some(join) = state.engine.lock().ok().and_then(|mut j| j.take()) {
                let _ = join.join();
            }
            if let Some(store) = app.try_state::<Store>() {
                let _ = store.flush();
            }
            // Never leave the controller hidden from games after we are gone.
            if let Some(g) = app.try_state::<guard::Guard>() {
                g.set_hidden(false);
            }
        }
        _ => {}
    });
}
