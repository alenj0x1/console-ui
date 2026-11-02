//! The guide: open windows and the music, over whatever is in front (a game
//! too). Its window never takes the focus, so a game in front stays in front
//! until the user picks another window.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use padcore::Mode;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_TOPMOST, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

use crate::switcher::{self, OpenWindow, Switcher};

pub const LABEL: &str = "guide";

#[derive(Default)]
pub struct GuideState {
    pub switcher: Switcher,
    windows: Mutex<Vec<OpenWindow>>,
    /// Folders games are installed in (from the game sources).
    pub game_dirs: Mutex<Vec<PathBuf>>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    *app.state::<GuideState>().game_dirs.lock().unwrap() = crate::sources::game_dirs();
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("guide.html".into()))
        .title("Centro de control")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    let hwnd = w.hwnd()?.0 as HWND;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize);
        // Appear and disappear at once, without Windows' fade.
        let off: i32 = 1;
        DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED as u32, (&off as *const i32).cast(), 4);
    }
    Ok(())
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    if !visible {
        // The page blanks itself first (on the mode change): a hidden page
        // stops drawing, and its last frame is what shows on the next open.
        // Off the engine thread, which must not wait.
        std::thread::spawn(move || {
            std::thread::sleep(BLANK_WAIT);
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if h.state::<crate::AppState>().mode.load(Ordering::Relaxed) == crate::mode_code(Mode::Guide) {
                    return; // opened again meanwhile
                }
                if let Some(hwnd) = h.get_webview_window(LABEL).and_then(|w| w.hwnd().ok()) {
                    unsafe { ShowWindow(hwnd.0 as HWND, SW_HIDE) };
                }
                h.state::<GuideState>().switcher.clear();
            });
        });
        return;
    }
    // Pictures first (off the UI thread), then the page draws the new list
    // and asks to be shown (guide_ready), so the last list never shows.
    std::thread::spawn(move || {
        let front = switcher::foreground() as isize;
        let state = handle.state::<GuideState>();
        let dirs = state.game_dirs.lock().unwrap().clone();
        let list = state.switcher.refresh(&dirs);
        let games = list.iter().filter(|w| w.game).count();
        handle.state::<crate::events::Events>().log(&format!("centro de control: {} ventanas, {games} juegos", list.len()));
        *state.windows.lock().unwrap() = list;
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if h.state::<crate::AppState>().mode.load(Ordering::Relaxed) != crate::mode_code(Mode::Guide) {
                return;
            }
            let Some(w) = h.get_webview_window(LABEL) else { return };
            let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..unsafe { std::mem::zeroed() } };
            unsafe { GetMonitorInfoW(MonitorFromWindow(front as HWND, MONITOR_DEFAULTTONEAREST), &mut info) };
            let m = info.rcMonitor;
            let _ = w.set_position(PhysicalPosition::new(m.left, m.top));
            let _ = w.set_size(PhysicalSize::new((m.right - m.left) as u32, (m.bottom - m.top) as u32));
            let _ = w.emit_to(LABEL, "windows", ());
        });
        // If the page never answers, show it anyway.
        std::thread::sleep(READY_WAIT);
        show(&handle);
    });
}

/// Time for the page to draw itself blank before the guide hides.
const BLANK_WAIT: std::time::Duration = std::time::Duration::from_millis(60);

/// Longest the guide waits for its page to draw before showing.
const READY_WAIT: std::time::Duration = std::time::Duration::from_millis(600);

fn show(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.state::<crate::AppState>().mode.load(Ordering::Relaxed) != crate::mode_code(Mode::Guide) {
            return;
        }
        let Some(hwnd) = handle.get_webview_window(LABEL).and_then(|w| w.hwnd().ok()) else { return };
        unsafe {
            ShowWindow(hwnd.0 as HWND, SW_SHOWNOACTIVATE);
            SetWindowPos(hwnd.0 as HWND, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    });
}

/// The page drew the new list: show it.
#[tauri::command]
pub fn guide_ready(app: AppHandle) -> Result<(), String> {
    in_guide(&app)?;
    show(&app);
    Ok(())
}

fn in_guide(app: &AppHandle) -> Result<(), String> {
    if app.state::<crate::AppState>().mode.load(Ordering::Relaxed) == crate::mode_code(Mode::Guide) {
        Ok(())
    } else {
        Err("el centro de control no está abierto".into())
    }
}

#[tauri::command]
pub fn guide_windows(state: tauri::State<GuideState>) -> Vec<OpenWindow> {
    state.windows.lock().unwrap().clone()
}

/// Brings the window to the front; a game gets the controller, anything else
/// the cursor.
#[tauri::command]
pub fn guide_switch(app: AppHandle, id: String) -> Result<(), String> {
    in_guide(&app)?;
    let state = app.state::<GuideState>();
    let hwnd = state.switcher.get(&id).ok_or("esa ventana ya no está abierta")?;
    let game = state.windows.lock().unwrap().iter().any(|w| w.id == id && w.game);
    switcher::activate(hwnd);
    app.state::<crate::events::Events>().log(&format!("centro de control: cambiar de ventana (juego: {game})"));
    app.state::<crate::AppState>().send(if game { Mode::Off } else { Mode::Cursor });
    Ok(())
}

/// Closes the guide and goes back to where it was opened from.
#[tauri::command]
pub fn guide_back(app: AppHandle) -> Result<(), String> {
    in_guide(&app)?;
    let state = app.state::<crate::AppState>();
    let from = match state.guide_from.load(Ordering::Relaxed) {
        0 => Mode::Off,
        2 => Mode::Keyboard,
        3 => Mode::Home,
        _ => Mode::Cursor,
    };
    state.send(from);
    Ok(())
}

#[tauri::command]
pub fn guide_close_window(app: AppHandle, id: String) -> Result<(), String> {
    in_guide(&app)?;
    let hwnd = app.state::<GuideState>().switcher.get(&id).ok_or("esa ventana ya no está abierta")?;
    switcher::close(hwnd);
    Ok(())
}
