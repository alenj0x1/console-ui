//! Games and apps for the home screen.
//!
//! - Games: from every game source (see `sources`).
//! - Apps: everything in the Start menu (shell:AppsFolder, includes Store
//!   apps), with their real icons.
//!
//! Launching only accepts ids found by the last scan.

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
    SIGDN_PARENTRELATIVEPARSING, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, SIIGBF_THUMBNAILONLY, ShellExecuteW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR, w};

use crate::sources::{self, Game};

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
        let mut games: Vec<Game> = sources::GAMES.iter().flat_map(|s| s.games()).collect();
        games.sort_by(|a, b| b.last_played.cmp(&a.last_played).then_with(|| a.name.cmp(&b.name)));
        let mut apps = with_com(start_apps).unwrap_or_default();
        apps.sort_by_key(|a| a.name.to_lowercase());
        Self { games, apps }
    }

    pub fn art(&self, game: &str, kind: &str) -> Option<&Path> {
        self.games.iter().find(|g| g.id == game)?.art_files.get(kind).map(PathBuf::as_path)
    }

    /// The game a running program belongs to (it runs from its folder).
    pub fn game_of(&self, program: &Path) -> Option<&Game> {
        self.games.iter().find(|g| g.dir.as_ref().is_some_and(|d| sources::inside(program, d)))
    }

    pub fn has_game(&self, id: &str) -> bool {
        self.games.iter().any(|g| g.id == id)
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
        Err(crate::i18n::t("err.not_in_library").into())
    }
}

pub fn shell_open(target: &str) -> Result<(), String> {
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute returns a value > 32 on success.
    if r.0 as usize > 32 { Ok(()) } else { Err(crate::i18n::t("err.open_failed").replace("{code}", &(r.0 as usize).to_string())) }
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

/// Windows' own thumbnail of a file (photo or video frame) as a PNG.
pub fn thumbnail_png(path: &Path, size: i32) -> windows::core::Result<Vec<u8>> {
    with_com(|| unsafe {
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)?;
        let bmp = item.GetImage(SIZE { cx: size, cy: size }, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK)?;
        let result = bitmap_png(bmp);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        result
    })
}

/// A program's own icon (from its .exe), as PNG.
pub fn file_icon_png(path: &Path, size: i32) -> windows::core::Result<Vec<u8>> {
    with_com(|| unsafe {
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)?;
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
        // BGRA, premultiplied by the shell → straight RGBA. Photo thumbnails
        // can come with no alpha at all: those are opaque.
        let opaque = px.chunks_exact(4).all(|p| p[3] == 0);
        for p in px.chunks_exact_mut(4) {
            if opaque {
                p.swap(0, 2);
                p[3] = 255;
                continue;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against this PC: prints what the home screen would show.
    #[test]
    #[ignore]
    fn scan_this_pc() {
        let lib = Library::scan();
        for g in &lib.games {
            println!("{} | {} | {} | {:?} | {:?}", g.id, g.name, g.last_played, g.art, g.dir);
        }
        println!("{} apps, e.g. {:?}", lib.apps.len(), lib.apps.iter().take(5).map(|a| &a.name).collect::<Vec<_>>());
        let png = app_icon_png("Microsoft.Windows.Explorer", 128).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
    }
}
