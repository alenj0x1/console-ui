//! Persistent app state in the user's app-data folder:
//! - `settings.json`: plain preferences (suggestion languages).
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

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub languages: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { languages: vec!["es".into()] }
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
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        s.languages = langs;
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
