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
                let file = dir.join(&project.file);
                // The file must stay inside its project folder.
                if !project.kind.eq_ignore_ascii_case("video") || project.file.contains("..") || !ext_in(&file, &VIDEO) || !file.is_file() {
                    continue;
                }
                let preview = (!project.preview.is_empty() && !project.preview.contains(".."))
                    .then(|| dir.join(&project.preview))
                    .filter(|p| p.is_file() && ext_in(p, &IMAGE));
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
