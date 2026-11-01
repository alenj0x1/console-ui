//! The app's own animated backgrounds, drawn by the page (see home.js).

use super::{Kind, Wallpaper, WallpaperSource};
use crate::store::Settings;

/// Used until the user picks another one.
pub const DEFAULT: &str = "builtin:diagonal";

const ANIMATIONS: [(&str, &str); 5] = [
    ("diagonal", "Ola diagonal"),
    ("ripples", "Ondas"),
    ("rain", "Lluvia"),
    ("breath", "Respiración"),
    ("lines", "Ondas lineales"),
];

pub struct Builtin;

impl WallpaperSource for Builtin {
    fn wallpapers(&self, _: &Settings) -> Vec<Wallpaper> {
        ANIMATIONS
            .iter()
            .map(|(id, title)| Wallpaper {
                id: format!("builtin:{id}"),
                title: (*title).into(),
                kind: Kind::Animated,
                origin: "Console UI".into(),
                file: Default::default(),
                preview: None,
            })
            .collect()
    }
}
