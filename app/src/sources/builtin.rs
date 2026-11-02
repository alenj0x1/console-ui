//! The app's own animated backgrounds, drawn by the page (see home.js).

use super::{Kind, Wallpaper, WallpaperSource};
use crate::store::Settings;

/// Used until the user picks another one.
pub const DEFAULT: &str = "builtin:diagonal";

/// Their names are in the language catalogue (bg.<id>).
const ANIMATIONS: [&str; 5] = ["diagonal", "ripples", "rain", "breath", "lines"];

pub struct Builtin;

impl WallpaperSource for Builtin {
    fn wallpapers(&self, _: &Settings) -> Vec<Wallpaper> {
        ANIMATIONS
            .iter()
            .map(|id| Wallpaper {
                id: format!("builtin:{id}"),
                title: crate::i18n::t(&format!("bg.{id}")).into(),
                kind: Kind::Animated,
                origin: "Console UI".into(),
                file: Default::default(),
                preview: None,
            })
            .collect()
    }
}
