//! Epic Games: installed games from the launcher's manifests.

use std::collections::HashMap;
use std::path::Path;

use super::{Game, GameSource};

pub struct Epic;

impl GameSource for Epic {
    fn games(&self) -> Vec<Game> {
        installed()
    }

    fn install_dirs(&self) -> Vec<std::path::PathBuf> {
        manifests().iter().filter_map(|m| m["InstallLocation"].as_str()).filter(|d| !d.is_empty()).map(Into::into).collect()
    }
}

fn manifests() -> Vec<serde_json::Value> {
    let dir = Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "item"))
        .filter_map(|e| serde_json::from_slice::<serde_json::Value>(&std::fs::read(e.path()).ok()?).ok())
        .collect()
}

fn installed() -> Vec<Game> {
    manifests()
        .into_iter()
        .filter(|m| m["AppCategories"].as_array().is_some_and(|c| c.iter().any(|x| x == "games")))
        .filter_map(|m| {
            let (name, app, ns, item) =
                (m["DisplayName"].as_str()?, m["AppName"].as_str()?, m["CatalogNamespace"].as_str()?, m["CatalogItemId"].as_str()?);
            // They go into the launch link: plain ids only.
            if ![app, ns, item].iter().all(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))) {
                return None;
            }
            Some(Game {
                id: format!("epic:{app}"),
                name: name.to_owned(),
                source: "epic",
                last_played: 0,
                art: Vec::new(),
                art_files: HashMap::new(),
                launch: format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true"),
                dir: m["InstallLocation"].as_str().filter(|d| !d.is_empty()).map(std::path::PathBuf::from),
            })
        })
        .collect()
}
