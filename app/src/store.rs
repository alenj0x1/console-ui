//! Persistent app state in the user's app-data folder:
//! - `settings.json`: plain preferences (suggestion languages, home screen).
//! - `learned.bin`: words the keyboard learned from the user, encrypted with
//!   DPAPI (current Windows user only), since it can contain private text.
//!
//! Writes are atomic (temp file + rename).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

pub const LANGUAGES: [&str; 2] = ["es", "en"];
pub const START: &str = "^";
const MAX_WORD: usize = 32;
const MAX_WORDS: usize = 20_000;
const MAX_PAIRS: usize = 60_000;

pub const MAX_PINNED: usize = 24;
const MAX_FOLDERS: usize = 16;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "spanish")]
    pub languages: Vec<String>,
    /// Apps pinned to the home screen; None until the user changes them.
    #[serde(default)]
    pub pinned: Option<Vec<String>>,
    /// Home screen background (a wallpaper id, or "none" for the plain
    /// colour); None = the app's default animation.
    #[serde(default)]
    pub wallpaper: Option<String>,
    /// Extra folders whose videos and pictures can be backgrounds.
    #[serde(default)]
    pub wallpaper_folders: Vec<std::path::PathBuf>,
    /// Show the focused game's art over the background.
    #[serde(default = "yes")]
    pub game_art: bool,
    /// The media tab's apps ("app id") and sites ("web:<id>"); None until
    /// the user changes them (then the installed media apps show).
    #[serde(default)]
    pub media: Option<Vec<String>>,
    /// One of prefs::ACCENTS.
    #[serde(default = "blue")]
    pub accent: String,
    /// Home screen and guide text size, in percent (prefs::TEXT_SIZES).
    #[serde(default = "hundred")]
    pub text_size: u32,
    #[serde(default)]
    pub thick_focus: bool,
    /// "both", "left" or "right": which hand holds the controller.
    #[serde(default = "both")]
    pub hand: String,
    /// Buttons the user reassigned on top of the hand's layout: button →
    /// action (prefs::BUTTONS / prefs::ACTIONS).
    #[serde(default)]
    pub button_map: std::collections::BTreeMap<String, String>,
    /// Black and white with a yellow focus; None follows Windows' own
    /// high contrast setting.
    #[serde(default)]
    pub high_contrast: Option<bool>,
    /// "grid" or "split".
    #[serde(default = "grid")]
    pub keyboard_layout: String,
    #[serde(default = "yes")]
    pub suggestions: bool,
    /// The keyboard learns the user's words.
    #[serde(default = "yes")]
    pub learn: bool,
    /// A game coming to the front gets the controller.
    #[serde(default = "yes")]
    pub auto_game: bool,
    #[serde(default = "yes")]
    pub rumble: bool,
    /// Game trailers play with their sound.
    #[serde(default)]
    pub trailer_sound: bool,
    /// The settings screen: "list" or "tiles".
    #[serde(default = "list")]
    pub settings_view: String,
    /// How the home tabs show their items: "banners" (a row of wide art),
    /// "covers" (a row of box art), "grid" (box art) or "list" (names).
    #[serde(default = "banners")]
    pub library_view: String,
    /// Cursor and controls (see prefs::tuning): "slow" / "normal" / "fast"…
    #[serde(default = "normal")]
    pub cursor_speed: String,
    #[serde(default = "normal")]
    pub deadzone: String,
    /// Slowdown over clickable elements: "off" / "soft" / "normal" / "strong".
    #[serde(default = "normal")]
    pub slowdown: String,
    #[serde(default = "normal")]
    pub scroll_speed: String,
    #[serde(default)]
    pub invert_scroll: bool,
    #[serde(default)]
    pub swap_sticks: bool,
    #[serde(default)]
    pub swap_ab: bool,
    /// "short" / "normal" / "long".
    #[serde(default = "normal")]
    pub hold_time: String,
    /// The colours of the controller drawn in Personalizar botones: a theme
    /// id (prefs::PAD_THEMES) or "random:<seed>".
    #[serde(default = "graphite")]
    pub pad_theme: String,
    /// TV mode: the screen (monitor device path) and sound output (endpoint
    /// id) to use; no sound output = the sound stays where it is.
    #[serde(default)]
    pub tv_display: Option<String>,
    #[serde(default)]
    pub tv_audio: Option<String>,
    /// TV mode was on when the app last stopped (it may have died): the next
    /// start puts the screens back, and the sound output saved here.
    #[serde(default)]
    pub tv_left_on: bool,
    #[serde(default)]
    pub tv_audio_before: Option<String>,
    /// The welcome was finished or skipped (it opens by itself until then).
    #[serde(default)]
    pub welcomed: bool,
    /// Look up high-resolution covers and lyrics on the internet (songinfo).
    #[serde(default = "yes")]
    pub music_online: bool,
    /// The music tab shows the lyrics in place of the cover.
    #[serde(default)]
    pub music_lyrics: bool,
    /// The game played last (a library id), first on the games tab.
    #[serde(default)]
    pub last_game: Option<String>,
}

fn yes() -> bool {
    true
}

fn spanish() -> Vec<String> {
    vec!["es".into()]
}

fn blue() -> String {
    "blue".into()
}

fn grid() -> String {
    "grid".into()
}

fn normal() -> String {
    "normal".into()
}

fn list() -> String {
    "list".into()
}

fn banners() -> String {
    "banners".into()
}

fn both() -> String {
    "both".into()
}

fn graphite() -> String {
    "grafito".into()
}

fn hundred() -> u32 {
    100
}

impl Default for Settings {
    fn default() -> Self {
        // An empty object takes every field's default.
        serde_json::from_str("{}").expect("settings defaults")
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Learned {
    pub words: HashMap<String, u32>,
    /// "previous next" → count.
    pub pairs: HashMap<String, u32>,
}

pub struct Store {
    dir: PathBuf,
    pub settings: Mutex<Settings>,
    pub learned: Mutex<Learned>,
    dirty: AtomicBool,
}

pub fn valid_word(w: &str) -> bool {
    let n = w.chars().count();
    n > 0 && n <= MAX_WORD && w.chars().all(|c| c.is_alphabetic() && !c.is_uppercase())
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let settings = std::fs::read(dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
            .map(|mut s| {
                s.languages.retain(|l| LANGUAGES.contains(&l.as_str()));
                if s.languages.is_empty() {
                    s = Settings::default();
                }
                s
            })
            .unwrap_or_default();
        let learned = std::fs::read(dir.join("learned.bin"))
            .ok()
            .and_then(|b| dpapi(&b, false).ok())
            .and_then(|b| serde_json::from_slice::<Learned>(&b).ok())
            .unwrap_or_default();
        Self { dir, settings: Mutex::new(settings), learned: Mutex::new(learned), dirty: AtomicBool::new(false) }
    }

    pub fn set_languages(&self, langs: Vec<String>) -> Result<(), String> {
        if langs.is_empty() || langs.iter().any(|l| !LANGUAGES.contains(&l.as_str())) {
            return Err("idiomas no válidos".into());
        }
        self.update_settings(|s| s.languages = langs)
    }

    /// `ids` must already be validated against the library.
    pub fn set_pinned(&self, ids: Vec<String>) -> Result<(), String> {
        if ids.len() > MAX_PINNED {
            return Err("demasiadas apps fijadas".into());
        }
        self.update_settings(|s| s.pinned = Some(ids))
    }

    /// `id` must already be validated against the wallpaper scan.
    pub fn set_wallpaper(&self, id: String) -> Result<(), String> {
        self.update_settings(|s| s.wallpaper = Some(id))
    }

    pub fn set_wallpaper_folders(&self, folders: Vec<std::path::PathBuf>) -> Result<(), String> {
        if folders.len() > MAX_FOLDERS {
            return Err("demasiadas carpetas".into());
        }
        self.update_settings(|s| s.wallpaper_folders = folders)
    }

    /// `ids` must already be validated against the library and the sites.
    pub fn set_media(&self, ids: Vec<String>) -> Result<(), String> {
        if ids.len() > MAX_PINNED {
            return Err("demasiadas apps en Multimedia".into());
        }
        self.update_settings(|s| s.media = Some(ids))
    }

    pub fn set_game_art(&self, on: bool) -> Result<(), String> {
        self.update_settings(|s| s.game_art = on)
    }

    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> Result<(), String> {
        self.update_settings(f)
    }

    fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        f(&mut s);
        write_atomic(&self.dir.join("settings.json"), &serde_json::to_vec_pretty(&*s).map_err(|e| e.to_string())?)
    }

    pub fn learn(&self, prev: &str, word: &str) -> Result<(), String> {
        if !valid_word(word) || !(prev == START || valid_word(prev)) {
            return Err("palabra no válida".into());
        }
        let mut l = self.learned.lock().map_err(|e| e.to_string())?;
        if l.words.len() < MAX_WORDS || l.words.contains_key(word) {
            *l.words.entry(word.to_owned()).or_default() += 1;
        }
        let pair = format!("{prev} {word}");
        if l.pairs.len() < MAX_PAIRS || l.pairs.contains_key(&pair) {
            *l.pairs.entry(pair).or_default() += 1;
        }
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn forget(&self) -> Result<(), String> {
        *self.learned.lock().map_err(|e| e.to_string())? = Learned::default();
        self.dirty.store(false, Ordering::Relaxed);
        match std::fs::remove_file(self.dir.join("learned.bin")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// Saves learned words if they changed since the last save.
    pub fn flush(&self) -> Result<(), String> {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let json = serde_json::to_vec(&*self.learned.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let sealed = dpapi(&json, true)?;
        write_atomic(&self.dir.join("learned.bin"), &sealed).inspect_err(|_| self.dirty.store(true, Ordering::Relaxed))
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Encrypts (`seal`) or decrypts with DPAPI, bound to the current Windows user.
fn dpapi(data: &[u8], seal: bool) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if seal {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
    };
    if ok == 0 {
        return Err("DPAPI falló".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData as HLOCAL) };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trip() {
        let sealed = dpapi(b"hola mundo", true).unwrap();
        assert_ne!(sealed, b"hola mundo");
        assert_eq!(dpapi(&sealed, false).unwrap(), b"hola mundo");
    }

    #[test]
    fn learns_and_persists_encrypted() {
        let dir = std::env::temp_dir().join(format!("console-ui-store-{}", std::process::id()));
        let s = Store::load(dir.clone());
        s.learn(START, "hola").unwrap();
        s.learn("hola", "mundo").unwrap();
        assert!(s.learn("hola", "Mundo").is_err());
        assert!(s.learn("hola", "a b").is_err());
        s.flush().unwrap();
        let raw = std::fs::read(dir.join("learned.bin")).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"mundo"), "stored encrypted");
        let again = Store::load(dir.clone());
        assert_eq!(again.learned.lock().unwrap().pairs.get("hola mundo"), Some(&1));
        again.forget().unwrap();
        assert!(!dir.join("learned.bin").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
