//! Steam: installed games from every library folder, last-played times from
//! the user's localconfig.vdf and official art from Steam's library cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{Game, GameSource};

pub struct Steam;

impl GameSource for Steam {
    fn games(&self) -> Vec<Game> {
        root().map(|r| games_in(&r)).unwrap_or_default()
    }

    fn install_dirs(&self) -> Vec<PathBuf> {
        root().map(|r| libraries(&r).into_iter().map(|l| l.join("steamapps").join("common")).collect()).unwrap_or_default()
    }
}

/// Steam tools that are not games.
const STEAM_TOOLS: [&str; 6] = ["228980", "1070560", "1391110", "1628350", "1493710", "250820"];
/// Art kinds the home screen asks for, and the files Steam keeps for them.
const ART_FILES: [(&str, &[&str]); 4] = [
    ("hero", &["library_hero.jpg"]),
    ("capsule", &["library_capsule.jpg", "library_600x900.jpg"]),
    ("header", &["header.jpg", "library_header.jpg"]),
    ("logo", &["logo.png"]),
];

pub fn root() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    let key: Vec<u16> = "Software\\Valve\\Steam\0".encode_utf16().collect();
    let name: Vec<u16> = "SteamPath\0".encode_utf16().collect();
    let r = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len)
    };
    if r != 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]);
    let p = PathBuf::from(path);
    p.is_dir().then_some(p)
}

/// Every Steam library folder, the main one first.
pub fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for (_, folder) in vdf::parse(&text).get(&["libraryfolders"]).map(vdf::entries).unwrap_or_default() {
            if let Some(path) = folder.get(&["path"]).and_then(vdf::Node::as_str) {
                // The same folder can be written with other case or slashes.
                let p = PathBuf::from(path);
                let same = |q: &PathBuf| q.canonicalize().ok() == p.canonicalize().ok();
                if p.is_dir() && !libraries.iter().any(same) {
                    libraries.push(p);
                }
            }
        }
    }
    libraries
}

fn games_in(root: &Path) -> Vec<Game> {
    let libraries = libraries(root);
    let played = last_played(root);
    let cache = root.join("appcache").join("librarycache");
    let mut games = Vec::new();
    for lib in libraries {
        let Ok(dir) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let doc = vdf::parse(&text);
            let (Some(appid), Some(title)) = (
                doc.get(&["AppState", "appid"]).and_then(vdf::Node::as_str),
                doc.get(&["AppState", "name"]).and_then(vdf::Node::as_str),
            ) else {
                continue;
            };
            if STEAM_TOOLS.contains(&appid) || !appid.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let art_files = art_files(&cache.join(appid));
            games.push(Game {
                id: format!("steam:{appid}"),
                name: title.trim().to_owned(),
                source: "steam",
                last_played: played.get(appid).copied().unwrap_or(0),
                art: ART_FILES.iter().map(|(k, _)| *k).filter(|k| art_files.contains_key(k)).collect(),
                art_files,
                launch: format!("steam://rungameid/{appid}"),
            });
        }
    }
    games
}

/// Newest LastPlayed per appid across the Steam accounts on this PC.
fn last_played(root: &Path) -> HashMap<String, u64> {
    let mut out: HashMap<String, u64> = HashMap::new();
    let Ok(users) = std::fs::read_dir(root.join("userdata")) else { return out };
    for user in users.flatten() {
        let Ok(text) = std::fs::read_to_string(user.path().join("config").join("localconfig.vdf")) else { continue };
        let doc = vdf::parse(&text);
        let apps = doc.get(&["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"]);
        for (appid, app) in apps.map(vdf::entries).unwrap_or_default() {
            if let Some(t) = app.get(&["LastPlayed"]).and_then(vdf::Node::as_str).and_then(|s| s.parse().ok()) {
                let e = out.entry(appid.to_owned()).or_default();
                *e = (*e).max(t);
            }
        }
    }
    out
}

/// Steam keeps art either flat or in hashed sub-folders: look in both.
fn art_files(dir: &Path) -> HashMap<&'static str, PathBuf> {
    let mut found: HashMap<String, PathBuf> = HashMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                found.entry(n.to_ascii_lowercase()).or_insert(p);
            }
        }
    }
    ART_FILES
        .iter()
        .filter_map(|(kind, files)| files.iter().find_map(|f| found.get(*f)).map(|p| (*kind, p.clone())))
        .collect()
}

// Valve KeyValues text.
pub mod vdf {
    pub enum Node {
        Str(String),
        Map(Vec<(String, Node)>),
    }

    impl Node {
        /// Case-insensitive path lookup (Steam is not consistent about case).
        pub fn get(&self, path: &[&str]) -> Option<&Node> {
            let mut n = self;
            for key in path {
                let Node::Map(items) = n else { return None };
                n = &items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key))?.1;
            }
            Some(n)
        }

        pub fn as_str(&self) -> Option<&str> {
            if let Node::Str(s) = self { Some(s) } else { None }
        }
    }

    pub fn entries(n: &Node) -> Vec<(&str, &Node)> {
        match n {
            Node::Map(items) => items.iter().map(|(k, v)| (k.as_str(), v)).collect(),
            Node::Str(_) => Vec::new(),
        }
    }

    enum Tok {
        Str(String),
        Open,
        Close,
    }

    fn tokens(s: &str) -> Vec<Tok> {
        let mut out = Vec::new();
        let mut it = s.chars().peekable();
        while let Some(c) = it.next() {
            match c {
                '{' => out.push(Tok::Open),
                '}' => out.push(Tok::Close),
                '/' if it.peek() == Some(&'/') => {
                    for c in it.by_ref() {
                        if c == '\n' {
                            break;
                        }
                    }
                }
                '"' => {
                    let mut v = String::new();
                    while let Some(c) = it.next() {
                        match c {
                            '\\' => match it.next() {
                                Some('n') => v.push('\n'),
                                Some('t') => v.push('\t'),
                                Some(o) => v.push(o),
                                None => break,
                            },
                            '"' => break,
                            o => v.push(o),
                        }
                    }
                    out.push(Tok::Str(v));
                }
                _ => {}
            }
        }
        out
    }

    pub fn parse(s: &str) -> Node {
        let toks = tokens(s);
        let mut i = 0;
        map(&toks, &mut i)
    }

    fn map(toks: &[Tok], i: &mut usize) -> Node {
        let mut items = Vec::new();
        while *i < toks.len() {
            match &toks[*i] {
                Tok::Close => {
                    *i += 1;
                    break;
                }
                Tok::Open => *i += 1,
                Tok::Str(key) => {
                    *i += 1;
                    match toks.get(*i) {
                        Some(Tok::Open) => {
                            *i += 1;
                            items.push((key.clone(), map(toks, i)));
                        }
                        Some(Tok::Str(v)) => {
                            items.push((key.clone(), Node::Str(v.clone())));
                            *i += 1;
                        }
                        _ => {}
                    }
                }
            }
        }
        Node::Map(items)
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn nested_and_escaped() {
            let doc = super::parse("\"a\" { \"b\" { \"c\" \"1\" } // note\n \"path\" \"C:\\\\Games\" }");
            assert_eq!(doc.get(&["A", "b", "c"]).and_then(super::Node::as_str), Some("1"));
            assert_eq!(doc.get(&["a", "path"]).and_then(super::Node::as_str), Some("C:\\Games"));
        }
    }
}
