//! Where the home screen's content comes from. Each source detects whether
//! its program or folder is there and lists what it has; a source that finds
//! nothing just adds nothing. Adding a launcher or a kind of background is
//! adding one module and listing it here.
//!
//! Only what the last scan found is ever launched or served: the page asks by
//! id, never by path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::store::Settings;

pub mod builtin;
pub mod epic;
pub mod folders;
pub mod steam;
pub mod trailers;
pub mod wallpaper_engine;

pub trait GameSource: Sync {
    fn games(&self) -> Vec<Game>;
    /// Folders its games are installed in (a program there is a game).
    fn install_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

pub fn game_dirs() -> Vec<PathBuf> {
    GAMES.iter().flat_map(|s| s.install_dirs()).collect()
}

pub trait WallpaperSource: Sync {
    fn wallpapers(&self, settings: &Settings) -> Vec<Wallpaper>;
}

pub const GAMES: [&dyn GameSource; 2] = [&steam::Steam, &epic::Epic];
pub const WALLPAPERS: [&dyn WallpaperSource; 3] = [&builtin::Builtin, &wallpaper_engine::WallpaperEngine, &folders::Folders];

#[derive(Clone, Serialize)]
pub struct Game {
    /// "steam:<appid>" or "epic:<AppName>".
    pub id: String,
    pub name: String,
    pub source: &'static str,
    /// Unix seconds; 0 when unknown.
    pub last_played: u64,
    /// Art kinds available ("hero", "capsule", "header", "logo").
    pub art: Vec<&'static str>,
    #[serde(skip)]
    pub art_files: HashMap<&'static str, PathBuf>,
    #[serde(skip)]
    pub launch: String,
    /// Where it is installed: a program running from there is this game.
    #[serde(skip)]
    pub dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Drawn by the page itself (`id` names the animation).
    Animated,
    Video,
    Image,
}

#[derive(Clone, Serialize)]
pub struct Wallpaper {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    /// Where it comes from, as shown to the user ("Wallpaper Engine", a folder name…).
    pub origin: String,
    #[serde(skip)]
    pub file: PathBuf,
    /// A preview picture of its own; files without one use Windows' thumbnail.
    #[serde(skip)]
    pub preview: Option<PathBuf>,
}

pub fn wallpapers(settings: &Settings) -> Vec<Wallpaper> {
    let mut all: Vec<Wallpaper> = WALLPAPERS.iter().flat_map(|s| s.wallpapers(settings)).collect();
    // The same file can be reached from two folders.
    let mut seen = std::collections::HashSet::new();
    all.retain(|w| seen.insert(w.id.clone()));
    all
}

pub const VIDEO: [&str; 3] = ["mp4", "webm", "m4v"];
pub const IMAGE: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];

pub fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Stable id for a file (FNV-1a of its path, hex).
pub fn key(path: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_string_lossy().to_lowercase().bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Whether `path` is inside `dir`, as Windows compares paths: any case,
/// either slash (launchers write their folders in their own way).
pub fn inside(path: &Path, dir: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    let (path, mut dir) = (norm(path), norm(dir));
    if !dir.ends_with('\\') {
        dir.push('\\');
    }
    path.starts_with(&dir)
}

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("webm") => "video/webm",
        Some("mp4" | "m4v") => "video/mp4",
        Some("m4a") => "audio/mp4",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_any_case_or_slash() {
        let game = Path::new(r"C:\Program Files (x86)\Steam\steamapps\common\Hollow Knight\hollow_knight.exe");
        assert!(inside(game, Path::new(r"c:/program files (x86)/steam\steamapps\common\Hollow Knight")));
        assert!(!inside(game, Path::new(r"C:\Program Files (x86)\Steam\steamapps\common\Hollow")));
    }

    #[test]
    fn keys_ignore_case() {
        assert_eq!(key(Path::new("C:\\A\\b.mp4")), key(Path::new("c:\\a\\B.MP4")));
        assert_ne!(key(Path::new("C:\\a.mp4")), key(Path::new("C:\\b.mp4")));
    }

    /// Runs against this PC: prints what the home screen would offer.
    #[test]
    #[ignore = "reads this PC"]
    fn scan_this_pc() {
        for g in GAMES.iter().flat_map(|s| s.games()) {
            println!("game {} | {} | {:?}", g.id, g.name, g.art);
        }
        let all = wallpapers(&Settings::default());
        for w in &all {
            println!("wallpaper {:?} {} | {} | {}", w.kind, w.origin, w.id, w.title);
        }
        assert!(all.iter().filter(|w| w.kind != Kind::Animated).all(|w| w.file.is_file()));
    }
}
