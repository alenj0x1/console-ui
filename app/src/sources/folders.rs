//! Videos and pictures from folders: the user's Videos and Pictures, plus any
//! folder added from the home screen. Also lists sub-folders so a folder can
//! be picked with the controller.

use std::path::{Path, PathBuf};

use serde::Serialize;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_Pictures, FOLDERID_Videos, KF_FLAG_DEFAULT, SHGetKnownFolderPath};

use super::{IMAGE, Kind, VIDEO, Wallpaper, WallpaperSource, ext_in, key};
use crate::store::Settings;

/// How deep to look inside a folder, and how many files to take from it.
const MAX_DEPTH: usize = 2;
const MAX_FILES: usize = 150;
/// Smaller pictures would look blurry across the screen.
const MIN_IMAGE_BYTES: u64 = 100 * 1024;
const MAX_LISTED: usize = 300;

pub struct Folders;

impl WallpaperSource for Folders {
    fn wallpapers(&self, settings: &Settings) -> Vec<Wallpaper> {
        let mut dirs: Vec<(PathBuf, String)> = Vec::new();
        for (id, label) in [(&FOLDERID_Videos, crate::i18n::t("folder.videos")), (&FOLDERID_Pictures, crate::i18n::t("folder.pictures"))] {
            if let Some(d) = known_folder(id) {
                dirs.push((d, label.into()));
            }
        }
        // Saved before network folders were refused: skipped, never opened.
        for d in settings.wallpaper_folders.iter().filter(|d| local_dir(d)) {
            dirs.push((d.clone(), folder_name(d)));
        }
        let mut out = Vec::new();
        for (dir, label) in dirs {
            let mut files = Vec::new();
            walk(&dir, 0, &label, &mut files);
            files.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            out.extend(files);
        }
        out
    }
}

fn folder_name(d: &Path) -> String {
    d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| d.to_string_lossy().into_owned())
}

fn walk(dir: &Path, depth: usize, origin: &str, out: &mut Vec<Wallpaper>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth < MAX_DEPTH && !hidden(&path) {
                walk(&path, depth + 1, origin, out);
            }
            continue;
        }
        let kind = if ext_in(&path, &VIDEO) {
            Kind::Video
        } else if ext_in(&path, &IMAGE) && meta.len() >= MIN_IMAGE_BYTES {
            Kind::Image
        } else {
            continue;
        };
        out.push(Wallpaper {
            id: format!("file:{}", key(&path)),
            title: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            kind,
            origin: origin.to_owned(),
            file: path,
            preview: None,
        });
    }
}

fn hidden(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
        || std::fs::metadata(path).is_ok_and(|m| m.file_attributes() & HIDDEN_OR_SYSTEM != 0)
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = p.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(p.0 as *const _));
        path.filter(|d| d.is_dir())
    }
}

// ---------- choosing a folder with the controller ----------

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// Videos and pictures directly inside.
    pub media: usize,
}

#[derive(Serialize)]
pub struct Listing {
    /// None = the list of drives.
    pub path: Option<String>,
    pub parent: Option<String>,
    pub folders: Vec<Entry>,
    pub media: usize,
}

fn media_in(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().take(2000).filter(|e| ext_in(&e.path(), &VIDEO) || ext_in(&e.path(), &IMAGE)).count())
        .unwrap_or(0)
}

/// A folder on a drive of this PC: never a network share or a network
/// drive (opening one sends the Windows sign-in hash to that server).
pub fn local_dir(dir: &Path) -> bool {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(p)) = dir.components().next() else { return false };
    let letter = match p.kind() {
        Prefix::Disk(l) | Prefix::VerbatimDisk(l) => l,
        _ => return false,
    };
    let root: Vec<u16> = format!("{}:\\", letter as char).encode_utf16().chain([0]).collect();
    let kind = unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) };
    kind != windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE && dir.is_absolute() && dir.is_dir()
}

/// Sub-folders of `path` (or the drives), skipping hidden and system ones.
pub fn browse(path: Option<&str>) -> Result<Listing, String> {
    let Some(path) = path else {
        let drives = ('A'..='Z')
            .map(|c| PathBuf::from(format!("{c}:\\")))
            .filter(|d| local_dir(d))
            .map(|d| Entry { name: d.to_string_lossy().trim_end_matches('\\').to_owned(), path: d.to_string_lossy().into_owned(), media: 0 })
            .collect();
        return Ok(Listing { path: None, parent: None, folders: drives, media: 0 });
    };
    let dir = PathBuf::from(path);
    if !local_dir(&dir) {
        return Err(crate::i18n::t("err.folder_not_found").into());
    }
    let mut folders: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !hidden(&e.path()))
        .take(MAX_LISTED)
        .map(|e| Entry { name: e.file_name().to_string_lossy().into_owned(), path: e.path().to_string_lossy().into_owned(), media: media_in(&e.path()) })
        .collect();
    folders.sort_by_key(|f| f.name.to_lowercase());
    Ok(Listing {
        path: Some(dir.to_string_lossy().into_owned()),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        folders,
        media: media_in(&dir),
    })
}
