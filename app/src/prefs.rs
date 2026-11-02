//! The settings screen's preferences: one command to read them all and one
//! to change one, checked against a fixed list of names and values. Every
//! change is saved and sent to every window ("preferences"), which applies
//! it at once (the accent colour, the text size…).

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ, RegCloseKey, RegDeleteValueW, RegGetValueW,
    RegOpenKeyExW, RegSetValueExW,
};

use crate::store::{Settings, Store};

pub const ACCENTS: [&str; 6] = ["blue", "violet", "green", "amber", "pink", "ivory"];
pub const TEXT_SIZES: [u32; 3] = [100, 110, 120];

/// What the pages need to know; the settings screen shows and changes it.
#[derive(Clone, Serialize)]
pub struct Preferences {
    pub accent: String,
    pub text_size: u32,
    pub thick_focus: bool,
    pub game_art: bool,
    pub keyboard_layout: String,
    pub suggestions: bool,
    pub learn: bool,
    pub languages: Vec<String>,
    /// Every language the keyboard has.
    pub available_languages: Vec<&'static str>,
    pub auto_game: bool,
    pub rumble: bool,
    pub start_with_windows: bool,
    pub settings_view: String,
    pub cursor_speed: String,
    pub deadzone: String,
    pub slowdown: String,
    pub scroll_speed: String,
    pub invert_scroll: bool,
    pub swap_sticks: bool,
    pub swap_ab: bool,
    pub hold_time: String,
}

impl Preferences {
    pub fn from(s: &Settings) -> Self {
        Self {
            accent: s.accent.clone(),
            text_size: s.text_size,
            thick_focus: s.thick_focus,
            game_art: s.game_art,
            keyboard_layout: s.keyboard_layout.clone(),
            suggestions: s.suggestions,
            learn: s.learn,
            languages: s.languages.clone(),
            available_languages: crate::store::LANGUAGES.to_vec(),
            auto_game: s.auto_game,
            rumble: s.rumble,
            start_with_windows: starts_with_windows(),
            settings_view: s.settings_view.clone(),
            cursor_speed: s.cursor_speed.clone(),
            deadzone: s.deadzone.clone(),
            slowdown: s.slowdown.clone(),
            scroll_speed: s.scroll_speed.clone(),
            invert_scroll: s.invert_scroll,
            swap_sticks: s.swap_sticks,
            swap_ab: s.swap_ab,
            hold_time: s.hold_time.clone(),
        }
    }
}

#[tauri::command]
pub fn preferences(store: tauri::State<Store>) -> Preferences {
    Preferences::from(&store.settings.lock().unwrap())
}

/// Changes one preference. Only the home screen's settings may call it.
#[tauri::command]
pub fn set_preference(app: AppHandle, webview: tauri::Webview, name: String, value: Value) -> Result<Preferences, String> {
    if webview.label() != crate::home::LABEL {
        return Err("no permitido".into());
    }
    let store = app.state::<Store>();
    let flag = || value.as_bool().ok_or("se esperaba sí o no");
    let pick = |allowed: &[&str]| value.as_str().filter(|v| allowed.contains(v)).map(str::to_owned).ok_or("valor no válido");
    match name.as_str() {
        "accent" => {
            let v = pick(&ACCENTS)?;
            store.update(|s| s.accent = v)?
        }
        "text_size" => {
            let v = value.as_u64().map(|v| v as u32).filter(|v| TEXT_SIZES.contains(v)).ok_or("tamaño no válido")?;
            store.update(|s| s.text_size = v)?
        }
        "thick_focus" => {
            let v = flag()?;
            store.update(|s| s.thick_focus = v)?
        }
        "game_art" => store.set_game_art(flag()?)?,
        "keyboard_layout" => {
            let v = pick(&["grid", "split"])?;
            store.update(|s| s.keyboard_layout = v.clone())?;
            let _ = app.emit_to(crate::overlay::LABEL, "layout", v);
        }
        "suggestions" => {
            let v = flag()?;
            store.update(|s| s.suggestions = v)?;
            let _ = app.emit_to(crate::overlay::LABEL, "suggest", v);
        }
        "learn" => {
            let v = flag()?;
            store.update(|s| s.learn = v)?
        }
        "languages" => {
            let langs: Vec<String> = serde_json::from_value(value).map_err(|_| "idiomas no válidos")?;
            store.set_languages(langs)?
        }
        "auto_game" => {
            let v = flag()?;
            store.update(|s| s.auto_game = v)?
        }
        "rumble" => {
            let v = flag()?;
            store.update(|s| s.rumble = v)?;
            app.state::<crate::AppState>().set_rumble(v);
        }
        "start_with_windows" => set_start_with_windows(flag()?)?,
        "settings_view" => {
            let v = pick(&["list", "tiles"])?;
            store.update(|s| s.settings_view = v)?
        }
        "cursor_speed" | "scroll_speed" => {
            let v = pick(&["slow", "normal", "fast"])?;
            store.update(|s| *if name == "cursor_speed" { &mut s.cursor_speed } else { &mut s.scroll_speed } = v)?;
            send_tuning(&app);
        }
        "deadzone" => {
            let v = pick(&["small", "normal", "large"])?;
            store.update(|s| s.deadzone = v)?;
            send_tuning(&app);
        }
        "slowdown" => {
            let v = pick(&["off", "soft", "normal", "strong"])?;
            store.update(|s| s.slowdown = v)?;
            send_tuning(&app);
        }
        "hold_time" => {
            let v = pick(&["short", "normal", "long"])?;
            store.update(|s| s.hold_time = v)?;
            send_tuning(&app);
        }
        "invert_scroll" | "swap_sticks" | "swap_ab" => {
            let v = flag()?;
            store.update(|s| {
                *match name.as_str() {
                    "invert_scroll" => &mut s.invert_scroll,
                    "swap_sticks" => &mut s.swap_sticks,
                    _ => &mut s.swap_ab,
                } = v
            })?;
            send_tuning(&app);
        }
        _ => return Err(format!("ajuste desconocido: {name}")),
    }
    let prefs = Preferences::from(&store.settings.lock().unwrap());
    let _ = app.emit("preferences", prefs.clone());
    Ok(prefs)
}

/// The engine's adjustments from the settings.
pub fn tuning(s: &Settings) -> padcore::Tuning {
    let pick = |v: &str, slow: f32, normal: f32, fast: f32| match v {
        "slow" | "small" | "short" | "soft" => slow,
        "fast" | "large" | "long" | "strong" => fast,
        _ => normal,
    };
    padcore::Tuning {
        speed: pick(&s.cursor_speed, 0.7, 1.0, 1.4),
        deadzone: pick(&s.deadzone, 0.08, 0.12, 0.18),
        hover_factor: if s.slowdown == "off" { 1.0 } else { pick(&s.slowdown, 0.65, 0.45, 0.25) },
        scroll: pick(&s.scroll_speed, 0.5, 1.0, 1.6),
        invert_scroll: s.invert_scroll,
        swap_sticks: s.swap_sticks,
        swap_ab: s.swap_ab,
        hold: std::time::Duration::from_millis(pick(&s.hold_time, 400.0, 600.0, 900.0) as u64),
    }
}

fn send_tuning(app: &AppHandle) {
    let t = tuning(&app.state::<Store>().settings.lock().unwrap());
    app.state::<crate::AppState>().set_tuning(t);
}

/// Puts every option of the settings screen back as it came. Pinned apps,
/// the media tab's picks, background folders and learned words stay.
#[tauri::command]
pub fn reset_preferences(app: AppHandle, webview: tauri::Webview) -> Result<Preferences, String> {
    if webview.label() != crate::home::LABEL {
        return Err("no permitido".into());
    }
    let store = app.state::<Store>();
    store.update(|s| {
        let fresh = Settings { pinned: s.pinned.take(), media: s.media.take(), wallpaper_folders: std::mem::take(&mut s.wallpaper_folders), ..Settings::default() };
        *s = fresh;
    })?;
    set_start_with_windows(false)?;
    let settings = store.settings.lock().unwrap().clone();
    let state = app.state::<crate::AppState>();
    state.set_rumble(settings.rumble);
    state.set_tuning(tuning(&settings));
    let _ = app.emit_to(crate::overlay::LABEL, "layout", settings.keyboard_layout.clone());
    let _ = app.emit_to(crate::overlay::LABEL, "suggest", settings.suggestions);
    // The home screen reloads its background.
    let _ = app.emit_to(crate::home::LABEL, "library", ());
    let prefs = Preferences::from(&settings);
    let _ = app.emit("preferences", prefs.clone());
    Ok(prefs)
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Console UI";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether Windows starts the app (quietly, in the tray) when the user signs in.
fn starts_with_windows() -> bool {
    let (key, value) = (wide(RUN_KEY), wide(RUN_VALUE));
    let mut size = 0u32;
    let r = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    r == ERROR_SUCCESS
}

fn set_start_with_windows(on: bool) -> Result<(), String> {
    let mut key: HKEY = std::ptr::null_mut();
    let path = wide(RUN_KEY);
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_SET_VALUE, &mut key) } != ERROR_SUCCESS {
        return Err("no se pudo abrir el registro".into());
    }
    let name = wide(RUN_VALUE);
    let result = if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = wide(&format!("\"{}\" --background", exe.display()));
        unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, command.as_ptr().cast(), (command.len() * 2) as u32) }
    } else {
        match unsafe { RegDeleteValueW(key, name.as_ptr()) } {
            2 => ERROR_SUCCESS, // already absent
            r => r,
        }
    };
    unsafe { RegCloseKey(key) };
    if result == ERROR_SUCCESS { Ok(()) } else { Err("no se pudo cambiar el inicio con Windows".into()) }
}
