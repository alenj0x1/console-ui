//! Wallpaper Engine's video wallpapers, from the Steam Workshop and the
//! user's own projects. Scene and web wallpapers need its own renderer, so
//! they are left out.

use serde::Deserialize;

use super::{IMAGE, Kind, VIDEO, Wallpaper, WallpaperSource, ext_in, steam};
use crate::store::Settings;

/// Wallpaper Engine's Steam app id (its workshop folder).
const APP_ID: &str = "431960";
/// The Workshop's video wallpapers, opened inside Steam.
const WORKSHOP: &str = "steam://openurl/https://steamcommunity.com/workshop/browse/?appid=431960&requiredtags[]=Video";

pub struct WallpaperEngine;

#[derive(Deserialize)]
struct Project {
    #[serde(default)]
    title: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    preview: String,
}

pub fn installed() -> bool {
    let Some(root) = steam::root() else { return false };
    steam::libraries(&root).iter().any(|lib| lib.join("steamapps").join("common").join("wallpaper_engine").is_dir())
}

/// Opens the Workshop's video wallpapers in Steam; subscribed ones show up
/// on the next scan.
pub fn open_workshop() -> Result<(), String> {
    if !installed() {
        return Err("Wallpaper Engine no está instalado".into());
    }
    crate::library::shell_open(WORKSHOP)
}

impl WallpaperSource for WallpaperEngine {
    fn wallpapers(&self, _: &Settings) -> Vec<Wallpaper> {
        let Some(root) = steam::root() else { return Vec::new() };
        let mut out = Vec::new();
        for lib in steam::libraries(&root) {
            let apps = lib.join("steamapps");
            let roots = [
                apps.join("workshop").join("content").join(APP_ID),
                apps.join("common").join("wallpaper_engine").join("projects").join("myprojects"),
            ];
            for dir in roots.iter().filter_map(|r| std::fs::read_dir(r).ok()).flatten().flatten() {
                let dir = dir.path();
                let Some(project) = std::fs::read(dir.join("project.json"))
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Project>(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).ok())
                else {
                    continue;
                };
                // Workshop items are anyone's: their files must stay inside
                // their folder (no "..", drive or network path).
                let Some(file) = inside(&dir, &project.file) else { continue };
                if !project.kind.eq_ignore_ascii_case("video") || !ext_in(&file, &VIDEO) || !file.is_file() {
                    continue;
                }
                let preview = inside(&dir, &project.preview).filter(|p| p.is_file() && ext_in(p, &IMAGE));
                let name = dir.file_name().unwrap_or_default().to_string_lossy();
                let title = project.title.trim();
                out.push(Wallpaper {
                    id: format!("we:{name}"),
                    title: if title.is_empty() { name.to_string() } else { title.to_owned() },
                    kind: Kind::Video,
                    origin: "Wallpaper Engine".into(),
                    file,
                    preview,
                });
            }
        }
        out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        out
    }
}

/// `rel` joined to `dir` when it is a plain relative path (only normal names).
fn inside(dir: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    let rel = std::path::Path::new(rel);
    let plain = rel.components().next().is_some() && rel.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    plain.then(|| dir.join(rel))
}

#[cfg(test)]
mod tests {
    use super::inside;
    use std::path::Path;

    #[test]
    fn keeps_files_inside_their_folder() {
        let dir = Path::new(r"C:\we\123");
        assert_eq!(inside(dir, "video.mp4"), Some(dir.join("video.mp4")));
        assert_eq!(inside(dir, r"sub\preview.jpg"), Some(dir.join(r"sub\preview.jpg")));
        for bad in ["", r"..\x.mp4", r"sub\..\..\x.mp4", r"C:\Users\x.mp4", r"\\host\share\p.jpg", r"\x.mp4", "C:x.mp4"] {
            assert_eq!(inside(dir, bad), None, "{bad}");
        }
    }
}
