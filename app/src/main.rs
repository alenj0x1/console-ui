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
mod guide;
mod prefs;
mod switcher;

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
/// After a click, the app needs a moment to move the focus to what was clicked.
const CLICK_SETTLE: Duration = Duration::from_millis(150);

enum EngineCmd {
    SetMode(Mode),
    SetRumble(bool),
    Stop,
}

struct AppState {
    cmd: Mutex<Sender<EngineCmd>>,
    engine: Mutex<Option<JoinHandle<()>>>,
    /// Labs start from a neutral keyboard: no learned words, nothing learned.
    lab: bool,
    /// Current mode, mirrored for the tray menu.
    mode: AtomicU8,
    /// Mode the guide was opened from (a mode code).
    guide_from: AtomicU8,
    /// A game the user took the controller back from (tray): not handed to
    /// it again automatically while it stays in front.
    declined: std::sync::atomic::AtomicIsize,
}

impl AppState {
    fn send(&self, m: Mode) {
        if let Ok(tx) = self.cmd.lock() {
            let _ = tx.send(EngineCmd::SetMode(m));
        }
    }

    fn set_rumble(&self, on: bool) {
        if let Ok(tx) = self.cmd.lock() {
            let _ = tx.send(EngineCmd::SetRumble(on));
        }
    }
}

fn mode_code(m: Mode) -> u8 {
    match m {
        Mode::Off => 0,
        Mode::Cursor => 1,
        Mode::Keyboard => 2,
        Mode::Home => 3,
        Mode::Guide => 4,
    }
}

#[derive(Serialize)]
struct KeyboardConfig {
    languages: Vec<String>,
    available: Vec<&'static str>,
    /// None in the lab, which picks its own.
    layout: Option<String>,
    suggest: bool,
    learn: bool,
    learned: store::Learned,
}

fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Off => "off",
        Mode::Cursor => "cursor",
        Mode::Keyboard => "keyboard",
        Mode::Home => "home",
        Mode::Guide => "guide",
    }
}

/// HidHide changes, applied in order by one thread and always for the mode
/// the app is in when they run (a burst of mode changes can't leave the
/// controller hidden from a game).
struct Cloak(Mutex<Sender<bool>>);

impl Cloak {
    /// `register`: add the app to HidHide's allowed list first (on connect).
    fn sync(&self, register: bool) {
        let _ = self.0.lock().unwrap().send(register);
    }
}

fn cloak_worker(app: AppHandle, rx: Receiver<bool>) {
    while let Ok(mut register) = rx.recv() {
        while let Ok(r) = rx.try_recv() {
            register |= r;
        }
        let g = app.state::<guard::Guard>();
        if register {
            g.register();
        }
        g.set_hidden(app.state::<AppState>().mode.load(Ordering::Relaxed) != mode_code(Mode::Off));
    }
}

fn apply_mode(app: &AppHandle, m: Mode) {
    let before = app.state::<AppState>().mode.swap(mode_code(m), Ordering::Relaxed);
    if m == Mode::Guide && before != mode_code(Mode::Guide) {
        app.state::<AppState>().guide_from.store(before, Ordering::Relaxed);
    }
    app.state::<events::Events>().log(&format!("modo {}", mode_name(m)));
    if !app.state::<AppState>().lab {
        // Games get the controller only in game mode; otherwise only we see it.
        app.state::<Cloak>().sync(false);
    }
    overlay::set_visible(app, m == Mode::Keyboard);
    home::set_visible(app, m == Mode::Home);
    guide::set_visible(app, m == Mode::Guide);
    let _ = app.emit("mode", mode_name(m));
}

/// Game mode follows the games: a game coming to the front (from anywhere,
/// not only the home screen) gets the controller, and when the game it was
/// handed to closes, the cursor comes back.
fn follow_games(app: &AppHandle, engine: &mut Engine, playing: &mut Option<isize>) {
    let state = app.state::<AppState>();
    let dirs = app.state::<guide::GuideState>().game_dirs.lock().unwrap().clone();
    let auto = app.state::<Store>().settings.lock().unwrap().auto_game;
    match engine.mode() {
        Mode::Cursor if auto => {
            let Some((hwnd, program, why)) = switcher::foreground_game(&dirs) else {
                state.declined.store(0, Ordering::Relaxed);
                return;
            };
            if state.declined.load(Ordering::Relaxed) == hwnd as isize {
                return;
            }
            app.state::<events::Events>().log(&format!("juego al frente: {program} ({why}); el control pasa al juego"));
            *playing = Some(hwnd as isize);
            engine.set_mode(Mode::Off);
            apply_mode(app, Mode::Off);
            overlay::flash_notice(app, "game", "", Duration::from_secs(4));
        }
        Mode::Off => match *playing {
            Some(g) if !switcher::alive(g as _) => {
                app.state::<events::Events>().log("el juego se cerró; vuelve el cursor");
                *playing = None;
                engine.set_mode(Mode::Cursor);
                apply_mode(app, Mode::Cursor);
            }
            Some(_) => {}
            // Game mode from the home screen or the tray: follow the game once it shows up.
            None => *playing = switcher::foreground_game(&dirs).map(|(h, _, _)| h as isize),
        },
        _ => {}
    }
}

fn engine_loop(app: AppHandle, rx: Receiver<EngineCmd>, lab: bool, open_home: bool) {
    let profile = padcore::profile("asistido").expect("built-in profile");
    let mut cfg = EngineConfig::with_profile(profile);
    cfg.keyboard_enabled = true;
    cfg.keyboard_locked = lab;
    cfg.guide_enabled = !lab;
    let stop = Arc::new(AtomicBool::new(false));
    let hover_state = Hover::new();
    let probe = hover::spawn_probe(hover_state.clone(), stop.clone());
    let mut engine = Engine::new(cfg).with_hover(hover_state);
    engine.set_rumble(app.state::<Store>().settings.lock().unwrap().rumble);
    let mut events = Vec::new();
    // Admin window in front: its handle (as a number), shown in the notice.
    let mut blocked_by: Option<isize> = None;
    let mut last_admin_check = std::time::Instant::now();
    // The game that has the controller (game mode): when it closes, the
    // cursor comes back.
    let mut playing: Option<isize> = None;
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
                EngineCmd::SetRumble(on) => engine.set_rumble(on),
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
                    let _ = app.emit_to(overlay::NOTICE, "notice", serde_json::json!({ "kind": "admin", "name": f.title }));
                }
                overlay::set_notice_visible(&app, now.is_some());
            }
            if !lab {
                follow_games(&app, &mut engine, &mut playing);
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
                Event::Click if !lab => {
                    // A click into a text field opens the keyboard there.
                    let h = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(CLICK_SETTLE);
                        let state = h.state::<AppState>();
                        if state.mode.load(Ordering::Relaxed) != mode_code(Mode::Cursor) {
                            return;
                        }
                        let at = inject::cursor_pos();
                        if hover::focused_text_field().is_some_and(|f| f.contains(at)) {
                            h.state::<events::Events>().log("clic en un campo de texto: teclado");
                            state.send(Mode::Keyboard);
                        }
                    });
                }
                Event::Click => {}
                Event::Ui(u) => {
                    let target = match engine.mode() {
                        Mode::Home => home::LABEL,
                        Mode::Guide => guide::LABEL,
                        _ => overlay::LABEL,
                    };
                    let _ = app.emit_to(target, "pad", u);
                }
                Event::Connected(_) => {
                    let _ = app.emit("pad-connected", true);
                    if !lab {
                        app.state::<Cloak>().sync(true);
                    }
                }
                Event::Disconnected => {
                    let _ = app.emit("pad-connected", false);
                }
            }
        }
        let tick = if !engine.connected() {
            NO_PAD_TICK
        } else if matches!(engine.mode(), Mode::Keyboard | Mode::Home | Mode::Guide) || engine.idle_for() <= IDLE_AFTER {
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
        4 => "guide",
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
fn type_text(app: AppHandle, text: String) -> Result<(), String> {
    if !valid_typed(&text) {
        return Err("texto no permitido".into());
    }
    inject::type_text(&text);
    overlay::follow_caret(&app);
    Ok(())
}

fn valid_typed(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= MAX_TYPED && !text.chars().any(char::is_control)
}

/// Swaps the word being typed for a suggestion.
#[tauri::command]
fn replace_word(app: AppHandle, delete: usize, text: String) -> Result<(), String> {
    if delete > MAX_TYPED || !valid_typed(&text) {
        return Err("reemplazo no permitido".into());
    }
    inject::replace_text(delete, &text);
    overlay::follow_caret(&app);
    Ok(())
}

#[tauri::command]
fn press_key(app: AppHandle, events: State<events::Events>, key: String) -> Result<(), String> {
    if key == "enter" {
        events.log("teclado: intro");
    }
    if !inject::key_named(&key) {
        return Err(format!("tecla desconocida: {key}"));
    }
    overlay::follow_caret(&app);
    Ok(())
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
    let settings = store.settings.lock().map_err(|e| e.to_string())?.clone();
    Ok(KeyboardConfig {
        languages: settings.languages,
        available: store::LANGUAGES.to_vec(),
        layout: if state.lab { None } else { Some(settings.keyboard_layout) },
        suggest: settings.suggestions || state.lab,
        learn: !state.lab && settings.learn,
        learned: if state.lab { store::Learned::default() } else { store.learned.lock().map_err(|e| e.to_string())?.clone() },
    })
}

#[tauri::command]
fn set_languages(store: State<Store>, languages: Vec<String>) -> Result<(), String> {
    store.set_languages(languages)
}

#[tauri::command]
async fn learn_word(app: AppHandle, prev: String, word: String) -> Result<(), String> {
    // Checked again here, as the page may not know yet that the focus moved
    // to a password (sign-ins that ask for it on a second page).
    let password = tauri::async_runtime::spawn_blocking(padcore::hover::focused_is_password).await.unwrap_or(true);
    if app.state::<AppState>().lab || password {
        return Ok(());
    }
    app.state::<Store>().learn(&prev, &word)
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
        .manage(AppState {
            cmd: Mutex::new(tx),
            engine: Mutex::new(None),
            lab,
            mode: AtomicU8::new(1),
            guide_from: AtomicU8::new(1),
            declined: Default::default(),
        })
        .manage(guide::GuideState::default())
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
            home::open_service,
            home::set_media,
            prefs::preferences,
            prefs::set_preference,
            guide::guide_windows,
            guide::guide_ready,
            guide::guide_switch,
            guide::guide_back,
            guide::guide_close_window,
            home::game_trailer,
            home::browse_folders,
            home::add_wallpaper_folder,
            home::remove_wallpaper_folder,
            lab_save
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(Store::load(app.path().app_data_dir()?));
            let (cloak_tx, cloak_rx) = mpsc::channel();
            app.manage(Cloak(Mutex::new(cloak_tx)));
            let worker = app.handle().clone();
            std::thread::spawn(move || cloak_worker(worker, cloak_rx));
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
                guide::create(&handle)?;
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
                            if off {
                                // Taken back from the game in front: don't hand it over again.
                                state.declined.store(switcher::foreground() as isize, Ordering::Relaxed);
                            }
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
