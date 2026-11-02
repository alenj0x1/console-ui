//! The interface language on the Rust side: the tray menu, the window
//! titles, the battery and background names and the errors the pages show.
//! The pages have their own catalogues (ui/i18n/<code>.js); Spanish is the
//! reference and a missing text shows in Spanish.
//!
//! To add a language: add its table here and its line in CATALOGUES (plus
//! ui/i18n/<code>.js and its code in ui/i18n.js).

use std::sync::atomic::{AtomicUsize, Ordering};

use windows_sys::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName};

use crate::store::Settings;

type Catalogue = &'static [(&'static str, &'static str)];

/// Every interface language, the reference first.
pub static CATALOGUES: [(&str, Catalogue); 2] = [("es", ES), ("en", EN)];

const ES: Catalogue = &[
    ("tray.home", "Abrir Inicio"),
    ("tray.keyboard", "Abrir teclado"),
    ("tray.games", "Dejar el control a los juegos"),
    ("tray.windows", "Volver a usar el control en Windows"),
    ("tray.quit", "Salir"),
    ("title.home", "Inicio"),
    ("title.guide", "Centro de control"),
    ("title.keyboard", "Teclado"),
    ("title.notice", "Aviso"),
    ("title.radial", "Menú radial"),
    ("title.welcome", "Bienvenida"),
    ("battery.wired", "Con cable"),
    ("battery.0", "Batería vacía"),
    ("battery.1", "Batería baja"),
    ("battery.2", "Batería media"),
    ("battery.3", "Batería llena"),
    ("bg.diagonal", "Ola diagonal"),
    ("bg.ripples", "Ondas"),
    ("bg.rain", "Lluvia"),
    ("bg.breath", "Respiración"),
    ("bg.lines", "Ondas lineales"),
    ("folder.videos", "Videos"),
    ("folder.pictures", "Imágenes"),
    ("tv.screen", "Pantalla"),
    ("err.not_allowed", "no permitido"),
    ("err.home_inactive", "la pantalla de Inicio no está activa"),
    ("err.unknown_service", "servicio desconocido"),
    ("err.unknown_app", "app desconocida"),
    ("err.unknown_app_or_site", "app o sitio desconocido"),
    ("err.unknown_wallpaper", "fondo desconocido"),
    ("err.folder_not_found", "carpeta no encontrada"),
    ("err.not_in_library", "no está en la biblioteca"),
    ("err.open_failed", "no se pudo abrir ({code})"),
    ("err.too_many_pinned", "demasiadas apps fijadas"),
    ("err.too_many_folders", "demasiadas carpetas"),
    ("err.too_many_media", "demasiadas apps en Multimedia"),
    ("err.no_wallpaper_engine", "Wallpaper Engine no está instalado"),
    ("err.tv_choose_first", "elige primero la pantalla de la TV"),
    ("err.tv_read", "no se pudieron leer las pantallas"),
    ("err.tv_not_connected", "esa pantalla no está conectada"),
    ("err.tv_not_changed", "Windows no cambió las pantallas ({code})"),
    ("err.invalid_option", "opción no válida"),
];

const EN: Catalogue = &[
    ("tray.home", "Open Home"),
    ("tray.keyboard", "Open keyboard"),
    ("tray.games", "Give the controller to games"),
    ("tray.windows", "Use the controller in Windows again"),
    ("tray.quit", "Quit"),
    ("title.home", "Home"),
    ("title.guide", "Control center"),
    ("title.keyboard", "Keyboard"),
    ("title.notice", "Notice"),
    ("title.radial", "Radial menu"),
    ("title.welcome", "Welcome"),
    ("battery.wired", "Wired"),
    ("battery.0", "Battery empty"),
    ("battery.1", "Battery low"),
    ("battery.2", "Battery half full"),
    ("battery.3", "Battery full"),
    ("bg.diagonal", "Diagonal wave"),
    ("bg.ripples", "Ripples"),
    ("bg.rain", "Rain"),
    ("bg.breath", "Breathing"),
    ("bg.lines", "Line waves"),
    ("folder.videos", "Videos"),
    ("folder.pictures", "Pictures"),
    ("tv.screen", "Screen"),
    ("err.not_allowed", "not allowed"),
    ("err.home_inactive", "the Home screen is not active"),
    ("err.unknown_service", "unknown service"),
    ("err.unknown_app", "unknown app"),
    ("err.unknown_app_or_site", "unknown app or site"),
    ("err.unknown_wallpaper", "unknown background"),
    ("err.folder_not_found", "folder not found"),
    ("err.not_in_library", "it is not in the library"),
    ("err.open_failed", "Windows couldn't open it ({code})"),
    ("err.too_many_pinned", "too many pinned apps"),
    ("err.too_many_folders", "too many folders"),
    ("err.too_many_media", "too many apps in Media"),
    ("err.no_wallpaper_engine", "Wallpaper Engine is not installed"),
    ("err.tv_choose_first", "choose the TV screen first"),
    ("err.tv_read", "the screens couldn't be read"),
    ("err.tv_not_connected", "that screen is not connected"),
    ("err.tv_not_changed", "Windows didn't change the screens ({code})"),
    ("err.invalid_option", "not a valid option"),
];

/// The language in use (an index in CATALOGUES).
static CURRENT: AtomicUsize = AtomicUsize::new(0);

/// `code` as one of ours.
fn ours(code: &str) -> Option<&'static str> {
    CATALOGUES.iter().map(|&(c, _)| c).find(|c| *c == code)
}

pub fn codes() -> Vec<&'static str> {
    CATALOGUES.iter().map(|(c, _)| *c).collect()
}

/// The language chosen in the settings, or Windows' own (the reference when
/// the app has no catalogue for it).
pub fn chosen(s: &Settings) -> &'static str {
    s.language.as_deref().and_then(ours).unwrap_or_else(windows_language)
}

pub fn set(code: &str) {
    CURRENT.store(CATALOGUES.iter().position(|(c, _)| *c == code).unwrap_or(0), Ordering::Relaxed);
}

/// The text for `key` in the language in use.
pub fn t(key: &str) -> &'static str {
    let find = |cat: Catalogue| cat.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
    find(CATALOGUES[CURRENT.load(Ordering::Relaxed)].1).or_else(|| find(CATALOGUES[0].1)).unwrap_or("")
}

/// Windows' display language, as one of ours ("en" for English, "es" for
/// Spanish or any language the app has no catalogue for).
fn windows_language() -> &'static str {
    let mut name = [0u16; 85];
    let n = unsafe { LCIDToLocaleName(GetUserDefaultUILanguage() as u32, name.as_mut_ptr(), name.len() as i32, 0) };
    let tag = String::from_utf16_lossy(&name[..(n.max(1) - 1) as usize]);
    ours(tag.split('-').next().unwrap_or("")).unwrap_or(CATALOGUES[0].0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn keys(cat: Catalogue) -> BTreeSet<&'static str> {
        cat.iter().map(|(k, _)| *k).collect()
    }

    #[test]
    fn rust_catalogues_match() {
        for (code, cat) in CATALOGUES {
            assert_eq!(keys(cat), keys(ES), "{code}: other keys than es");
            assert_eq!(cat.len(), keys(cat).len(), "{code}: a key twice");
            assert!(cat.iter().all(|(_, v)| !v.trim().is_empty()), "{code}: an empty text");
        }
    }

    /// The pages' catalogues (ui/i18n/<code>.js, one `"key": "text",` per
    /// line): the same languages as here, the same keys as es.js, no empty
    /// text, and every t("key") the pages use is in es.js.
    #[test]
    fn page_catalogues_match() {
        let ui = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
        let read = |p: std::path::PathBuf| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let entries = |code: &str| -> Vec<(String, String)> {
            read(ui.join("i18n").join(format!("{code}.js")))
                .lines()
                .filter_map(|l| l.trim().strip_suffix(',').and_then(|l| l.strip_prefix('"')).map(str::to_owned))
                .filter_map(|l| l.split_once("\": ").map(|(k, v)| (k.to_owned(), serde_json::from_str::<String>(v).expect("a JSON string"))))
                .collect()
        };
        let list = read(ui.join("i18n.js"));
        let reference: BTreeSet<String> = entries("es").into_iter().map(|(k, _)| k).collect();
        assert!(reference.len() > 100, "es.js not read");
        for code in codes() {
            assert!(list.contains(&format!("\"{code}\"")), "{code} missing from LANGUAGES in ui/i18n.js");
            let e = entries(code);
            let set: BTreeSet<String> = e.iter().map(|(k, _)| k.clone()).collect();
            assert_eq!(set.len(), e.len(), "{code}.js: a key twice");
            let missing: Vec<_> = reference.difference(&set).collect();
            let extra: Vec<_> = set.difference(&reference).collect();
            assert!(missing.is_empty() && extra.is_empty(), "{code}.js: missing {missing:?}, extra {extra:?}");
            let empty: Vec<_> = e.iter().filter(|(_, v)| v.trim().is_empty()).map(|(k, _)| k).collect();
            assert!(empty.is_empty(), "{code}.js: empty {empty:?}");
        }
        // Literal keys in the pages: t("key"), say("key") and data-i18n="key".
        let mut used = BTreeSet::new();
        for f in std::fs::read_dir(&ui).unwrap().flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            if !(name.ends_with(".js") || name.ends_with(".html")) {
                continue;
            }
            let text = read(f.path());
            for open in ["t(\"", "say(\"", "data-i18n=\""] {
                for (at, _) in text.match_indices(open) {
                    let before = text[..at].chars().last().unwrap_or(' ');
                    if open != "data-i18n=\"" && (before.is_alphanumeric() || before == '_' || before == '.') {
                        continue;
                    }
                    let rest = &text[at + open.len()..];
                    let key = &rest[..rest.find('"').unwrap()];
                    if !key.contains('$') {
                        used.insert(key.to_owned());
                    }
                }
            }
        }
        let unknown: Vec<_> = used.iter().filter(|k| !reference.contains(*k)).collect();
        assert!(unknown.is_empty(), "keys used but not in es.js: {unknown:?}");
    }
}
