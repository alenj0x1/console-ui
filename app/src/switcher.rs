//! Open windows for the guide: the same windows Alt+Tab lists, a still
//! picture of each (taken when the guide opens, kept in memory only), and
//! whether one is a game. Switching to a window only accepts one from the
//! last list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
    DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, HALFTONE, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    ReleaseDC, SRCCOPY, SelectObject, SetStretchBltMode, StretchBlt,
};
use windows_sys::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::Shell::{QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GA_ROOTOWNER, GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GetAncestor, GetForegroundWindow,
    GetLastActivePopup, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, PostMessageW, SW_RESTORE, SetForegroundWindow,
    ShowWindow, WM_CLOSE, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// Width of a window's picture in the guide.
const SHOT_WIDTH: i32 = 480;
/// PW_RENDERFULLCONTENT: also captures windows drawn by the GPU.
const RENDER_FULL: PRINT_WINDOW_FLAGS = 2;

/// Programs that fill the screen without being games (videos, slides, and
/// another copy of this app's home screen).
const NOT_GAMES: [&str; 13] = [
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe",
    "vlc.exe", "mpc-hc64.exe", "mpc-be64.exe", "potplayermini64.exe", "explorer.exe", "powerpnt.exe",
    "console-ui.exe",
];

#[derive(Clone, Serialize)]
pub struct OpenWindow {
    /// The window handle, as text (ids go back to us to switch or close).
    pub id: String,
    pub title: String,
    pub game: bool,
    pub minimized: bool,
}

#[derive(Default)]
pub struct Switcher {
    /// Last list: handle → program path.
    windows: Mutex<HashMap<isize, PathBuf>>,
    shots: Mutex<HashMap<isize, Vec<u8>>>,
    /// Program icons by path, kept while the app runs.
    icons: Mutex<HashMap<PathBuf, Vec<u8>>>,
}

impl Switcher {
    /// Lists the open windows (front first) and takes their pictures.
    pub fn refresh(&self, game_dirs: &[PathBuf]) -> Vec<OpenWindow> {
        let mut found = Vec::new();
        let mut list = HashMap::new();
        let mut shots = HashMap::new();
        for hwnd in top_windows() {
            let Some(program) = program_path(hwnd) else { continue };
            let minimized = unsafe { IsIconic(hwnd) != 0 };
            if !minimized {
                if let Some(png) = shot(hwnd) {
                    shots.insert(hwnd as isize, png);
                }
            }
            found.push(OpenWindow {
                id: (hwnd as isize).to_string(),
                title: title(hwnd),
                game: is_game(hwnd, &program, game_dirs).is_some(),
                minimized,
            });
            list.insert(hwnd as isize, program);
        }
        *self.windows.lock().unwrap() = list;
        *self.shots.lock().unwrap() = shots;
        found
    }

    /// A window from the last list.
    pub fn get(&self, id: &str) -> Option<HWND> {
        let key: isize = id.parse().ok()?;
        let known = self.windows.lock().unwrap().contains_key(&key);
        (known && unsafe { IsWindow(key as HWND) != 0 }).then_some(key as HWND)
    }

    pub fn shot(&self, id: &str) -> Option<Vec<u8>> {
        self.shots.lock().unwrap().get(&id.parse().ok()?).cloned()
    }

    pub fn icon(&self, id: &str) -> Option<Vec<u8>> {
        let path = self.windows.lock().unwrap().get(&id.parse().ok()?)?.clone();
        if let Some(png) = self.icons.lock().unwrap().get(&path) {
            return Some(png.clone());
        }
        let png = crate::library::file_icon_png(&path, 96).ok()?;
        self.icons.lock().unwrap().insert(path, png.clone());
        Some(png)
    }

    /// Forgets the pictures (the guide closed).
    pub fn clear(&self) {
        self.shots.lock().unwrap().clear();
    }
}

/// Visible top-level windows as Alt+Tab shows them, front first, without ours.
fn top_windows() -> Vec<HWND> {
    unsafe extern "system" fn each(hwnd: HWND, out: LPARAM) -> i32 {
        let out = unsafe { &mut *(out as *mut Vec<HWND>) };
        if alt_tab_window(hwnd) {
            out.push(hwnd);
        }
        1
    }
    let mut out: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(each), &mut out as *mut Vec<HWND> as LPARAM) };
    out.retain(|&w| pid_of(w) != std::process::id());
    out
}

fn alt_tab_window(hwnd: HWND) -> bool {
    unsafe {
        if IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) == 0 {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW != 0 || (ex & WS_EX_NOACTIVATE != 0 && ex & WS_EX_APPWINDOW == 0) {
            return false;
        }
        if !GetWindow(hwnd, GW_OWNER).is_null() && ex & WS_EX_APPWINDOW == 0 {
            return false;
        }
        // The window Alt+Tab would show for its owner chain.
        let root = GetAncestor(hwnd, GA_ROOTOWNER);
        if GetLastActivePopup(root) != hwnd && root != hwnd {
            return false;
        }
        // Store apps that are suspended or on another desktop stay "visible" but cloaked.
        let mut cloaked = 0u32;
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), 4);
        cloaked == 0
    }
}

pub(crate) fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid
}

fn title(hwnd: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(hwnd);
        let mut buf = vec![0u16; n.max(0) as usize + 1];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

fn program_path(hwnd: HWND) -> Option<PathBuf> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid_of(hwnd));
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

fn rect(hwnd: HWND) -> RECT {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetWindowRect(hwnd, &mut r) };
    r
}

/// Why the window counts as a game, or None.
pub fn is_game(hwnd: HWND, program: &Path, game_dirs: &[PathBuf]) -> Option<&'static str> {
    let lower = program.to_string_lossy().to_lowercase();
    if game_dirs.iter().any(|d| crate::sources::inside(program, d)) || lower.contains(r"\steamapps\common\") || lower.contains(r"\xboxgames\") {
        return Some("biblioteca");
    }
    let name = program.file_name()?.to_string_lossy().to_lowercase();
    if NOT_GAMES.contains(&name.as_str()) {
        return None;
    }
    if unsafe { GetForegroundWindow() } == hwnd {
        let mut state = 0;
        if unsafe { SHQueryUserNotificationState(&mut state) } == 0 && state == QUNS_RUNNING_D3D_FULL_SCREEN {
            return Some("pantalla completa exclusiva");
        }
    }
    // Borderless full screen: no title bar and the whole monitor.
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
    if style & WS_CAPTION == WS_CAPTION {
        return None;
    }
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..unsafe { std::mem::zeroed() } };
    unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) };
    let (r, m) = (rect(hwnd), info.rcMonitor);
    (r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom).then_some("pantalla completa")
}

/// The foreground window when it is a game: (window, program, reason).
pub fn foreground_game(game_dirs: &[PathBuf]) -> Option<(HWND, String, &'static str)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() || pid_of(hwnd) == std::process::id() {
        return None;
    }
    let program = program_path(hwnd)?;
    let why = is_game(hwnd, &program, game_dirs)?;
    Some((hwnd, program.file_name()?.to_string_lossy().into_owned(), why))
}

/// The first window (front first, as Alt+Tab lists them) whose program
/// passes `wanted`.
pub fn find_window(wanted: impl Fn(&Path) -> bool) -> Option<HWND> {
    top_windows().into_iter().find(|&w| program_path(w).is_some_and(|p| wanted(&p)))
}

/// The program a window belongs to.
pub fn program_of(hwnd: HWND) -> Option<PathBuf> {
    program_path(hwnd)
}

pub fn foreground() -> HWND {
    unsafe { GetForegroundWindow() }
}

pub fn alive(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

/// Brings `hwnd` to the front. Windows only lets the app with the focus do
/// that, so we join the input of the window in front for a moment.
pub fn activate(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        let front = GetForegroundWindow();
        let theirs = GetWindowThreadProcessId(front, std::ptr::null_mut());
        let ours = GetCurrentThreadId();
        let joined = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if joined {
            AttachThreadInput(ours, theirs, 0);
        }
    }
}

/// Asks the window to close, as its close button would (it may ask to save).
pub fn close(hwnd: HWND) {
    unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
}

/// A still picture of the window, `SHOT_WIDTH` wide, as PNG.
fn shot(hwnd: HWND) -> Option<Vec<u8>> {
    let r = rect(hwnd);
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    if w < 64 || h < 64 {
        return None;
    }
    let (tw, th) = (SHOT_WIDTH, (SHOT_WIDTH as i64 * h as i64 / w as i64).max(1) as i32);
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let full_dc = CreateCompatibleDC(screen);
        let full = CreateCompatibleBitmap(screen, w, h);
        let small_dc = CreateCompatibleDC(screen);
        let small = CreateCompatibleBitmap(screen, tw, th);
        let old_full = SelectObject(full_dc, full);
        let old_small = SelectObject(small_dc, small);
        let ok = PrintWindow(hwnd, full_dc, RENDER_FULL) != 0;
        let mut px = vec![0u8; (tw * th * 4) as usize];
        if ok {
            SetStretchBltMode(small_dc, HALFTONE);
            StretchBlt(small_dc, 0, 0, tw, th, full_dc, 0, 0, w, h, SRCCOPY);
            SelectObject(small_dc, old_small);
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: tw,
                    biHeight: -th,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            GetDIBits(small_dc, small, 0, th as u32, px.as_mut_ptr().cast(), &mut bi, DIB_RGB_COLORS);
        } else {
            SelectObject(small_dc, old_small);
        }
        SelectObject(full_dc, old_full);
        DeleteObject(full);
        DeleteObject(small);
        DeleteDC(full_dc);
        DeleteDC(small_dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        if !ok {
            return None;
        }
        // BGRx → RGBA. A nearly black picture (a window that draws with the
        // GPU in a way PrintWindow can't see) is no picture: the icon shows instead.
        let mut lit = 0usize;
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
            lit += usize::from(p[0] > 24 || p[1] > 24 || p[2] > 24);
        }
        if lit * 50 < px.len() / 4 {
            return None;
        }
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, tw as u32, th as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&px).ok()?;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    /// Runs against this PC: lists what the guide would show.
    /// `cargo test -p console-ui-app switcher -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn lists_open_windows() {
        let s = super::Switcher::default();
        for w in s.refresh(&[]) {
            println!("{} | {} | juego {} | minimizada {} | foto {}", w.id, w.title, w.game, w.minimized, s.shot(&w.id).map_or(0, |p| p.len()));
        }
    }
}
