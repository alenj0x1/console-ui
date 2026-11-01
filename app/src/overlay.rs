//! The keyboard overlay window: always on top and never activated, so the
//! window you are typing into keeps focus while keys are injected.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::{HWND, RECT};
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
    let _ = app.run_on_main_thread(move || {
        let Some(w) = handle.get_webview_window(LABEL) else { return };
        let Ok(hwnd) = hwnd(&w) else { return };
        unsafe {
            if visible {
                place(&w);
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            } else {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    });
}

/// Windows' Start menu and search live in a layer above every "always on
/// top" window (only signed apps with uiAccess can go there), and they open
/// on the left. When one of them has the focus the keyboard moves right.
const SHELL_PANELS: [&str; 4] = ["SearchApp.exe", "SearchHost.exe", "StartMenuExperienceHost.exe", "ShellExperienceHost.exe"];

/// Bottom of the primary monitor's work area (above the taskbar): centred, or
/// on the right while the Start menu or search has the focus.
fn place(w: &WebviewWindow) {
    let mut area = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut area as *mut RECT).cast(), 0) };
    if ok == 0 {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let (pw, ph) = ((WIDTH * scale) as i32, (HEIGHT * scale) as i32);
    let fg = crate::events::foreground_program();
    let x = if SHELL_PANELS.iter().any(|p| fg.eq_ignore_ascii_case(p)) {
        area.right - pw - (MARGIN * scale) as i32
    } else {
        area.left + (area.right - area.left - pw) / 2
    };
    let y = area.bottom - ph - (MARGIN * scale) as i32;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

fn hwnd(w: &WebviewWindow) -> tauri::Result<HWND> {
    Ok(w.hwnd()?.0 as HWND)
}
