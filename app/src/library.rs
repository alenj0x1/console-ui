//! Games and apps for the home screen.
//!
//! - Steam: installed games from every library folder, last-played times from
//!   the user's localconfig.vdf, official art from Steam's library cache.
//! - Epic Games: installed games from the launcher's manifests.
//! - Apps: everything in the Start menu (shell:AppsFolder, includes Store
//!   apps), with their real icons.
//!
//! Launching only accepts ids found by the last scan.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW, HGDIOBJ,
    ReleaseDC,
};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, IEnumShellItems, IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIGDN_NORMALDISPLAY,
    SIGDN_PARENTRELATIVEPARSING, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, ShellExecuteW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR, w};

/// Steam tools that are not games.
const STEAM_TOOLS: [&str; 6] = ["228980", "1070560", "1391110", "1628350", "1493710", "250820"];
/// Art kinds the home screen asks for, and the files Steam keeps for them.
const ART_FILES: [(&str, &[&str]); 4] = [
    ("hero", &["library_hero.jpg"]),
    ("capsule", &["library_capsule.jpg", "library_600x900.jpg"]),
    ("header", &["header.jpg", "library_header.jpg"]),
    ("logo", &["logo.png"]),
];

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
    art_files: HashMap<&'static str, PathBuf>,
    #[serde(skip)]
    launch: String,
}

#[derive(Clone, Serialize)]
pub struct AppEntry {
    /// AppUserModelID or parsing name inside shell:AppsFolder.
    pub id: String,
    pub name: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Library {
    pub games: Vec<Game>,
    pub apps: Vec<AppEntry>,
}

impl Library {
    pub fn scan() -> Self {
        let mut games = Vec::new();
        if let Some(root) = steam_root() {
            games.extend(steam_games(&root));
        }
        games.extend(epic_games());
        games.sort_by(|a, b| b.last_played.cmp(&a.last_played).then_with(|| a.name.cmp(&b.name)));
        let mut apps = with_com(start_apps).unwrap_or_default();
        apps.sort_by_key(|a| a.name.to_lowercase());
        Self { games, apps }
    }

    pub fn art(&self, game: &str, kind: &str) -> Option<&Path> {
        self.games.iter().find(|g| g.id == game)?.art_files.get(kind).map(PathBuf::as_path)
    }

    pub fn has_app(&self, id: &str) -> bool {
        self.apps.iter().any(|a| a.id == id)
    }

    /// Starts a game or app from this library. Returns true for games.
    pub fn launch(&self, id: &str) -> Result<bool, String> {
        if let Some(g) = self.games.iter().find(|g| g.id == id) {
            shell_open(&g.launch)?;
            return Ok(true);
        }
        if self.has_app(id) {
            shell_open(&format!("shell:AppsFolder\\{id}"))?;
            return Ok(false);
        }
        Err("no está en la biblioteca".into())
    }
}

fn shell_open(target: &str) -> Result<(), String> {
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute returns a value > 32 on success.
    if r.0 as usize > 32 { Ok(()) } else { Err(format!("no se pudo abrir ({})", r.0 as usize)) }
}

// ---------- Steam ----------

fn steam_root() -> Option<PathBuf> {
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

fn steam_games(root: &Path) -> Vec<Game> {
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
    let played = steam_last_played(root);
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
            let art_files = steam_art(&cache.join(appid));
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
fn steam_last_played(root: &Path) -> HashMap<String, u64> {
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
fn steam_art(dir: &Path) -> HashMap<&'static str, PathBuf> {
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

// ---------- Epic ----------

fn epic_games() -> Vec<Game> {
    let dir = Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "item"))
        .filter_map(|e| serde_json::from_slice::<serde_json::Value>(&std::fs::read(e.path()).ok()?).ok())
        .filter(|m| m["AppCategories"].as_array().is_some_and(|c| c.iter().any(|x| x == "games")))
        .filter_map(|m| {
            let (name, app, ns, item) =
                (m["DisplayName"].as_str()?, m["AppName"].as_str()?, m["CatalogNamespace"].as_str()?, m["CatalogItemId"].as_str()?);
            Some(Game {
                id: format!("epic:{app}"),
                name: name.to_owned(),
                source: "epic",
                last_played: 0,
                art: Vec::new(),
                art_files: HashMap::new(),
                launch: format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true"),
            })
        })
        .collect()
}

// ---------- Start menu apps and icons ----------

/// Runs `f` with COM initialized for this thread (shell objects need an STA).
pub fn with_com<T>(f: impl FnOnce() -> windows::core::Result<T>) -> windows::core::Result<T> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let r = f();
        if init.is_ok() {
            CoUninitialize();
        }
        r
    }
}

fn display_name(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> windows::core::Result<String> {
    unsafe {
        let p = item.GetDisplayName(kind)?;
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        Ok(s)
    }
}

fn start_apps() -> windows::core::Result<Vec<AppEntry>> {
    unsafe {
        let folder: IShellItem = SHCreateItemFromParsingName(w!("shell:AppsFolder"), None)?;
        let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
        let mut apps = Vec::new();
        loop {
            let mut got = [None];
            if items.Next(&mut got, None).is_err() {
                break;
            }
            let Some(item) = got[0].take() else { break };
            let (Ok(name), Ok(id)) = (display_name(&item, SIGDN_NORMALDISPLAY), display_name(&item, SIGDN_PARENTRELATIVEPARSING)) else {
                continue;
            };
            if !name.is_empty() && !id.is_empty() {
                apps.push(AppEntry { id, name });
            }
        }
        Ok(apps)
    }
}

/// The app's real icon as a PNG, `size` pixels square (or close to it).
pub fn app_icon_png(id: &str, size: i32) -> windows::core::Result<Vec<u8>> {
    with_com(|| unsafe {
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(format!("shell:AppsFolder\\{id}")), None)?;
        let bmp = item.GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)?;
        let result = bitmap_png(bmp);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        result
    })
}

unsafe fn bitmap_png(bmp: windows::Win32::Graphics::Gdi::HBITMAP) -> windows::core::Result<Vec<u8>> {
    unsafe {
        let mut info = BITMAP::default();
        GetObjectW(HGDIOBJ(bmp.0), size_of::<BITMAP>() as i32, Some((&mut info as *mut BITMAP).cast()));
        let (w, h) = (info.bmWidth, info.bmHeight);
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        // BGRA, premultiplied by the shell → straight RGBA.
        for p in px.chunks_exact_mut(4) {
            let a = p[3] as u32;
            let (b, g, r) = (p[0] as u32, p[1] as u32, p[2] as u32);
            let un = |c: u32| if a == 0 { 0 } else { ((c * 255 + a / 2) / a).min(255) as u8 };
            p[0] = un(r);
            p[1] = un(g);
            p[2] = un(b);
        }
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().map_err(|_| windows::core::Error::empty())?;
            wr.write_image_data(&px).map_err(|_| windows::core::Error::empty())?;
        }
        Ok(out)
    }
}

// ---------- VDF (Valve KeyValues text) ----------

mod vdf {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against this PC: prints what the home screen would show.
    #[test]
    #[ignore]
    fn scan_this_pc() {
        let lib = Library::scan();
        for g in &lib.games {
            println!("{} | {} | {} | {:?}", g.id, g.name, g.last_played, g.art);
        }
        println!("{} apps, e.g. {:?}", lib.apps.len(), lib.apps.iter().take(5).map(|a| &a.name).collect::<Vec<_>>());
        let png = app_icon_png("Microsoft.Windows.Explorer", 128).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
    }
}
