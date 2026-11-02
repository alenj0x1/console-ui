//! The keyboard overlay window: always on top and never activated, so the
//! window you are typing into keeps focus while keys are injected. It opens
//! on the monitor under the cursor and keeps clear of the text being typed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use padcore::hover::{self, ScreenRect};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_TOPMOST, SPI_GETWORKAREA, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    SystemParametersInfoW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

pub const LABEL: &str = "keyboard";
const WIDTH: f64 = 800.0;
const HEIGHT: f64 = 390.0;
/// Gap between the keyboard and the taskbar, in logical pixels.
const MARGIN: f64 = 16.0;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("keyboard.html".into()))
        .title("Teclado")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(WIDTH, HEIGHT)
        .build()?;
    let hwnd = hwnd(&w)?;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize);
    }
    Ok(())
}

pub const NOTICE: &str = "notice";
const NOTICE_WIDTH: f64 = 900.0;
const NOTICE_HEIGHT: f64 = 96.0;

/// A small banner at the top of the screen (admin window notice). Never takes
/// the focus when shown; it only does on purpose, to hand the focus back.
pub fn create_notice(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, NOTICE, WebviewUrl::App("notice.html".into()))
        .title("Aviso")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(NOTICE_WIDTH, NOTICE_HEIGHT)
        .build()?;
    let hwnd = hwnd(&w)?;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize);
    }
    Ok(())
}

pub fn set_notice_visible(app: &AppHandle, visible: bool) {
    NOTICE_TURN.fetch_add(1, Ordering::Relaxed);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = handle.get_webview_window(NOTICE) else { return };
        let Ok(hwnd) = hwnd(&w) else { return };
        unsafe {
            if visible {
                let mut area = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut area as *mut RECT).cast(), 0);
                let scale = w.scale_factor().unwrap_or(1.0);
                let pw = (NOTICE_WIDTH * scale) as i32;
                let _ = w.set_position(PhysicalPosition::new(area.left + (area.right - area.left - pw) / 2, area.top + (24.0 * scale) as i32));
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            } else {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    });
}

/// Counts notice changes, so a timed notice only hides itself.
static NOTICE_TURN: AtomicU64 = AtomicU64::new(0);

/// Shows a notice of `kind` for a while, then hides it (unless another
/// notice took its place meanwhile).
pub fn flash_notice(app: &AppHandle, kind: &'static str, name: &str, how_long: Duration) {
    let _ = app.emit_to(NOTICE, "notice", serde_json::json!({ "kind": kind, "name": name }));
    set_notice_visible(app, true);
    let turn = NOTICE_TURN.load(Ordering::Relaxed);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(how_long);
        if NOTICE_TURN.load(Ordering::Relaxed) == turn {
            set_notice_visible(&handle, false);
        }
    });
}

/// Takes the focus with the notice for a moment, then hands it to the next
/// normal window below `from`, and hides the notice.
pub fn rescue(app: &AppHandle, from: isize) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = handle.get_webview_window(NOTICE) else { return };
        let _ = w.set_focus();
        crate::admin::hand_focus_back(from as HWND);
        if let Ok(hwnd) = hwnd(&w) {
            unsafe { ShowWindow(hwnd, SW_HIDE) };
        }
    });
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    if !visible {
        let _ = app.run_on_main_thread(move || {
            let Some(w) = handle.get_webview_window(LABEL) else { return };
            if let Ok(hwnd) = hwnd(&w) {
                unsafe { ShowWindow(hwnd, SW_HIDE) };
            }
        });
        return;
    }
    // UI Automation may wait on a busy app: ask off the engine and UI threads.
    std::thread::spawn(move || {
        let avoid = typing_spot();
        let at = padcore::inject::cursor_pos();
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            // Closed again while we were asking.
            if h.state::<crate::AppState>().mode.load(Ordering::Relaxed) != crate::mode_code(padcore::Mode::Keyboard) {
                return;
            }
            let Some(w) = h.get_webview_window(LABEL) else { return };
            let Ok(hwnd) = hwnd(&w) else { return };
            place(&w, at, avoid);
            unsafe {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        });
    });
}

/// Where the text goes: the caret when the app shows one inside the focused
/// field, else the whole field. None when no text field has the focus.
fn typing_spot() -> Option<ScreenRect> {
    let field = hover::focused_text_field()?;
    let caret = hover::caret_rect().filter(|c| field.overlaps(c));
    Some(caret.unwrap_or(field))
}

/// A check is already waiting (fast typing queues only one).
static FOLLOW_PENDING: AtomicBool = AtomicBool::new(false);

/// After typing: if the caret went under the keyboard (a new line, a long
/// text), the keyboard moves to the other side of the same monitor.
pub fn follow_caret(app: &AppHandle) {
    if FOLLOW_PENDING.swap(true, Ordering::Relaxed) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        // Let the app draw the text and move its caret first.
        std::thread::sleep(Duration::from_millis(80));
        FOLLOW_PENDING.store(false, Ordering::Relaxed);
        let Some(caret) = hover::caret_rect() else { return };
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let Some(w) = h.get_webview_window(LABEL) else { return };
            if !w.is_visible().unwrap_or(false) {
                return;
            }
            let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
            let now = ScreenRect { left: pos.x, top: pos.y, right: pos.x + size.width as i32, bottom: pos.y + size.height as i32 };
            if now.overlaps(&caret) {
                let centre = ((now.left + now.right) / 2, (now.top + now.bottom) / 2);
                place(&w, centre, Some(caret));
            }
        });
    });
}

/// Windows' Start menu and search live in a layer above every "always on
/// top" window (only signed apps with uiAccess can go there), and they open
/// on the left. When one of them has the focus the keyboard moves right.
const SHELL_PANELS: [&str; 4] = ["SearchApp.exe", "SearchHost.exe", "StartMenuExperienceHost.exe", "ShellExperienceHost.exe"];

/// Work area (without the taskbar) and scale of the monitor showing `at`.
pub(crate) fn monitor_at((x, y): (i32, i32)) -> Option<(RECT, f64)> {
    unsafe {
        let mon = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTOPRIMARY);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if mon.is_null() || GetMonitorInfoW(mon, &mut info) == 0 {
            return None;
        }
        let (mut dx, mut dy) = (96u32, 96u32);
        let scale = if GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) >= 0 { dx as f64 / 96.0 } else { 1.0 };
        Some((info.rcWork, scale))
    }
}

/// Bottom of the work area of the monitor showing `at`: centred, or on the
/// right while the Start menu or search has the focus. When that would cover
/// `avoid` (the text being typed), it goes to the top instead.
fn place(w: &WebviewWindow, at: (i32, i32), avoid: Option<ScreenRect>) {
    let Some((area, scale)) = monitor_at(at) else { return };
    let (pw, ph) = ((WIDTH * scale) as i32, (HEIGHT * scale) as i32);
    let margin = (MARGIN * scale) as i32;
    let fg = crate::events::foreground_program();
    let x = if SHELL_PANELS.iter().any(|p| fg.eq_ignore_ascii_case(p)) {
        area.right - pw - margin
    } else {
        area.left + (area.right - area.left - pw) / 2
    };
    let (top, bottom) = (area.top + margin, area.bottom - ph - margin);
    let covers = |y: i32| avoid.is_some_and(|r| r.overlaps(&ScreenRect { left: x, top: y, right: x + pw, bottom: y + ph }));
    let y = match avoid {
        // A tall field: stay on the side away from most of it.
        Some(r) if covers(bottom) && covers(top) => {
            if (r.top + r.bottom) / 2 > (area.top + area.bottom) / 2 { top } else { bottom }
        }
        _ if covers(bottom) => top,
        _ => bottom,
    };
    // Moving to a monitor with another scale resizes the window on the way:
    // size it for the new one and place it again.
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

fn hwnd(w: &WebviewWindow) -> tauri::Result<HWND> {
    Ok(w.hwnd()?.0 as HWND)
}
