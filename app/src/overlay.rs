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

/// Bottom centre of the primary monitor's work area (above the taskbar).
fn place(w: &WebviewWindow) {
    let mut area = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut area as *mut RECT).cast(), 0) };
    if ok == 0 {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let (pw, ph) = ((WIDTH * scale) as i32, (HEIGHT * scale) as i32);
    let x = area.left + (area.right - area.left - pw) / 2;
    let y = area.bottom - ph - (MARGIN * scale) as i32;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

fn hwnd(w: &WebviewWindow) -> tauri::Result<HWND> {
    Ok(w.hwnd()?.0 as HWND)
}
