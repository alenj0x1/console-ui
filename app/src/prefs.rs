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

use windows_sys::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETHIGHCONTRAST, SystemParametersInfoW};

use crate::store::{Settings, Store};

pub const ACCENTS: [&str; 6] = ["blue", "violet", "green", "amber", "pink", "ivory"];
/// Buttons that can be reassigned (View and Menu stay: they open the home
/// screen and the guide, the way back from anything).
pub const BUTTONS: [&str; 14] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "l3", "r3", "up", "down", "left", "right"];
/// What a button can do: any of those, scroll, or nothing.
pub const ACTIONS: [&str; 17] =
    ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "l3", "r3", "up", "down", "left", "right", "scroll_up", "scroll_down", "none"];
/// The controller's themes in Personalizar botones (PAD_THEMES in home.js);
/// "random:<seed>" is a generated one.
pub const PAD_THEMES: [&str; 12] =
    ["grafito", "carbon", "puntos", "marino", "petroleo", "vino", "bosque", "oliva", "ciruela", "pizarra", "hueso", "arena"];

/// The one-hand layouts: what changes from the usual one.
fn hand_layout(hand: &str) -> &'static [(&'static str, &'static str)] {
    match hand {
        "left" => &[("lb", "a"), ("lt", "x"), ("l3", "b"), ("up", "scroll_up"), ("down", "scroll_down"), ("left", "lb"), ("right", "rb")],
        "right" => &[("rb", "a"), ("rt", "x"), ("r3", "b"), ("y", "scroll_up"), ("a", "scroll_down"), ("x", "lb"), ("b", "rb")],
        _ => &[],
    }
}

/// Every button and what it does now: the hand's layout, then the user's changes.
pub fn button_map(s: &Settings) -> std::collections::BTreeMap<String, String> {
    let mut map: std::collections::BTreeMap<String, String> = BUTTONS.iter().map(|b| (b.to_string(), b.to_string())).collect();
    for (b, a) in hand_layout(&s.hand) {
        map.insert(b.to_string(), a.to_string());
    }
    for (b, a) in &s.button_map {
        if BUTTONS.contains(&b.as_str()) && ACTIONS.contains(&a.as_str()) {
            map.insert(b.clone(), a.clone());
        }
    }
    map
}

fn source(name: &str) -> u32 {
    use padcore::engine::source;
    use padcore::pad::btn;
    match name {
        "a" => btn::A as u32,
        "b" => btn::B as u32,
        "x" => btn::X as u32,
        "y" => btn::Y as u32,
        "lb" => btn::LB as u32,
        "rb" => btn::RB as u32,
        "l3" => btn::L3 as u32,
        "r3" => btn::R3 as u32,
        "up" => btn::DPAD_UP as u32,
        "down" => btn::DPAD_DOWN as u32,
        "left" => btn::DPAD_LEFT as u32,
        "right" => btn::DPAD_RIGHT as u32,
        "lt" => source::LT,
        _ => source::RT,
    }
}

fn action(name: &str) -> padcore::Action {
    use padcore::Action;
    match name {
        "lt" => Action::LeftTrigger,
        "rt" => Action::RightTrigger,
        "scroll_up" => Action::ScrollUp,
        "scroll_down" => Action::ScrollDown,
        "none" => Action::Nothing,
        b => Action::Button(source(b) as u16),
    }
}

pub const TEXT_SIZES: [u32; 5] = [100, 110, 120, 135, 150];

/// What the pages need to know; the settings screen shows and changes it.
#[derive(Clone, Serialize)]
pub struct Preferences {
    pub accent: String,
    pub text_size: u32,
    pub thick_focus: bool,
    pub high_contrast: bool,
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
    pub library_view: String,
    pub trailer_sound: bool,
    pub cursor_speed: String,
    pub deadzone: String,
    pub slowdown: String,
    pub scroll_speed: String,
    pub invert_scroll: bool,
    pub swap_sticks: bool,
    pub swap_ab: bool,
    pub hold_time: String,
    pub pad_theme: String,
    pub hand: String,
    /// Every button and what it does now.
    pub button_map: std::collections::BTreeMap<String, String>,
}

impl Preferences {
    pub fn from(s: &Settings) -> Self {
        Self {
            accent: s.accent.clone(),
            text_size: s.text_size,
            thick_focus: s.thick_focus,
            high_contrast: s.high_contrast.unwrap_or_else(windows_high_contrast),
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
            library_view: s.library_view.clone(),
            trailer_sound: s.trailer_sound,
            cursor_speed: s.cursor_speed.clone(),
            deadzone: s.deadzone.clone(),
            slowdown: s.slowdown.clone(),
            scroll_speed: s.scroll_speed.clone(),
            invert_scroll: s.invert_scroll,
            swap_sticks: s.swap_sticks,
            swap_ab: s.swap_ab,
            hold_time: s.hold_time.clone(),
            pad_theme: s.pad_theme.clone(),
            hand: s.hand.clone(),
            button_map: button_map(s),
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
    // The welcome tunes the pointer while you try it.
    let welcome = webview.label() == crate::welcome::LABEL && matches!(name.as_str(), "cursor_speed" | "deadzone");
    if webview.label() != crate::home::LABEL && !welcome {
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
        "high_contrast" => {
            let v = flag()?;
            store.update(|s| s.high_contrast = Some(v))?
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
        "trailer_sound" => {
            let v = flag()?;
            store.update(|s| s.trailer_sound = v)?
        }
        "library_view" => {
            let v = pick(&["banners", "covers", "grid", "list"])?;
            store.update(|s| s.library_view = v)?
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
        "pad_theme" => {
            let random = |v: &str| v.strip_prefix("random:").is_some_and(|n| n.parse::<u32>().is_ok());
            let v = value.as_str().filter(|v| PAD_THEMES.contains(v) || random(v)).map(str::to_owned).ok_or("tema no válido")?;
            store.update(|s| s.pad_theme = v)?
        }
        "hand" => {
            let v = pick(&["both", "left", "right"])?;
            // A new layout starts clean.
            store.update(|s| {
                s.hand = v;
                s.button_map.clear();
            })?;
            send_tuning(&app);
        }
        "button_map" => {
            let button = value.get("button").and_then(Value::as_str).filter(|b| BUTTONS.contains(b)).ok_or("botón no válido")?.to_owned();
            let act = value.get("action").and_then(Value::as_str).filter(|a| ACTIONS.contains(a)).ok_or("acción no válida")?.to_owned();
            store.update(|s| {
                let layout = hand_layout(&s.hand).iter().find(|(b, _)| *b == button).map_or(button.as_str(), |(_, a)| a);
                if layout == act {
                    s.button_map.remove(&button);
                } else {
                    s.button_map.insert(button.clone(), act.clone());
                }
            })?;
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
        swap_sticks: s.swap_sticks || s.hand == "right",
        swap_ab: s.swap_ab,
        hold: std::time::Duration::from_millis(pick(&s.hold_time, 400.0, 600.0, 900.0) as u64),
        remap: button_map(s).iter().filter(|(b, a)| b != a).map(|(b, a)| (source(b), action(a))).collect(),
        guide_hold: match s.hand.as_str() {
            "left" => Some(padcore::pad::btn::BACK),
            "right" => Some(padcore::pad::btn::START),
            _ => None,
        },
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

/// Whether Windows' own high contrast theme is on.
fn windows_high_contrast() -> bool {
    let mut hc = HIGHCONTRASTW { cbSize: size_of::<HIGHCONTRASTW>() as u32, dwFlags: 0, lpszDefaultScheme: std::ptr::null_mut() };
    let ok = unsafe { SystemParametersInfoW(SPI_GETHIGHCONTRAST, hc.cbSize, (&mut hc as *mut HIGHCONTRASTW).cast(), 0) };
    ok != 0 && hc.dwFlags & HCF_HIGHCONTRASTON != 0
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
