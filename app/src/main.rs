//! Console UI desktop app: hosts the input engine and the on-screen keyboard.
//! `--lab` opens the typing lab instead of running quietly in the tray.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod overlay;
mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use padcore::{Engine, EngineConfig, Event, Hover, Mode, hover, inject};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
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

enum EngineCmd {
    SetMode(Mode),
    Stop,
}

struct AppState {
    cmd: Mutex<Sender<EngineCmd>>,
    engine: Mutex<Option<JoinHandle<()>>>,
    /// Labs start from a neutral keyboard: no learned words, nothing learned.
    lab: bool,
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
    }
}

fn apply_mode(app: &AppHandle, m: Mode) {
    overlay::set_visible(app, m == Mode::Keyboard);
    let _ = app.emit("mode", mode_name(m));
}

fn engine_loop(app: AppHandle, rx: Receiver<EngineCmd>, lab: bool) {
    let profile = padcore::profile("asistido").expect("built-in profile");
    let mut cfg = EngineConfig::with_profile(profile);
    cfg.keyboard_enabled = true;
    cfg.keyboard_locked = lab;
    let stop = Arc::new(AtomicBool::new(false));
    let hover_state = Hover::new();
    let probe = hover::spawn_probe(hover_state.clone(), stop.clone());
    let mut engine = Engine::new(cfg).with_hover(hover_state);
    let mut events = Vec::new();
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
        engine.step(&mut events);
        for e in events.drain(..) {
            match e {
                Event::ModeChanged(m) => apply_mode(&app, m),
                Event::Ui(u) => {
                    let _ = app.emit_to(overlay::LABEL, "pad", u);
                }
                Event::Connected(_) => {
                    let _ = app.emit("pad-connected", true);
                }
                Event::Disconnected => {
                    let _ = app.emit("pad-connected", false);
                }
            }
        }
        let tick = if !engine.connected() {
            NO_PAD_TICK
        } else if engine.mode() == Mode::Keyboard || engine.idle_for() <= IDLE_AFTER {
            ACTIVE_TICK
        } else {
            IDLE_TICK
        };
        std::thread::sleep(tick);
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
fn press_key(key: String) -> Result<(), String> {
    if inject::key_named(&key) { Ok(()) } else { Err(format!("tecla desconocida: {key}")) }
}

#[tauri::command]
fn set_mode(state: State<AppState>, mode: String) -> Result<(), String> {
    let m = match mode.as_str() {
        "off" => Mode::Off,
        "cursor" => Mode::Cursor,
        "keyboard" => Mode::Keyboard,
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
    let lab = std::env::args().any(|a| a == "--lab");
    // Which comparison the lab runs: "layouts" (default) or "suggest".
    let experiment = std::env::args()
        .find_map(|a| a.strip_prefix("--exp=").map(str::to_owned))
        .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "layouts".into());
    let (tx, rx) = mpsc::channel();
    let rx = Mutex::new(Some(rx));

    let app = tauri::Builder::default()
        .manage(AppState { cmd: Mutex::new(tx), engine: Mutex::new(None), lab })
        .invoke_handler(tauri::generate_handler![
            type_text,
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
            lab_save
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(Store::load(app.path().app_data_dir()?));
            {
                let h = handle.clone();
                std::thread::Builder::new().name("store".into()).spawn(move || loop {
                    std::thread::sleep(SAVE_EVERY);
                    let _ = h.state::<Store>().flush();
                })?;
            }
            overlay::create(&handle)?;

            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Console UI")
                .menu(&Menu::with_items(app, &[&quit])?)
                .on_menu_event(|app, e| {
                    if e.id() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            if lab {
                WebviewWindowBuilder::new(app, "lab", WebviewUrl::App(format!("lab.html?exp={experiment}").into()))
                    .title("Laboratorio del teclado")
                    .maximized(true)
                    .build()?;
            }

            let rx = rx.lock().ok().and_then(|mut r| r.take()).expect("engine channel");
            let h = handle.clone();
            let join = std::thread::Builder::new()
                .name("engine".into())
                .spawn(move || engine_loop(h, rx, lab))?;
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
        }
        _ => {}
    });
}
