//! The radial menu: holding View in the cursor shows it around the middle of
//! the monitor under the cursor; the stick aims and letting go of View picks.
//! The window never takes the focus and lets clicks through, so the app in
//! front stays the one an action works on.

use std::time::Duration;

use padcore::{Mode, Radial, inject};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_D, VK_LWIN, VK_S, VK_SHIFT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetClassNameW, GetWindowLongPtrW, HWND_TOPMOST, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

pub const LABEL: &str = "radial";
/// Logical pixels; the page draws the menu to fill it.
const SIZE: f64 = 560.0;
/// The page empties itself before the window hides, so opening it again
/// never shows the last aim for a frame.
const HIDE_AFTER: Duration = Duration::from_millis(60);

/// Its slots, clockwise from the top (the page draws them in this order).
#[derive(Clone, Copy)]
enum Slot {
    Keyboard,
    Snip,
    Desktop,
    CloseWindow,
    Home,
}
const SLOTS: [Slot; 5] = [Slot::Keyboard, Slot::Snip, Slot::Desktop, Slot::CloseWindow, Slot::Home];
pub const SLOT_COUNT: u8 = SLOTS.len() as u8;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("radial.html".into()))
        .title(crate::i18n::t("title.radial"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(SIZE, SIZE)
        .build()?;
    let _ = w.set_ignore_cursor_events(true);
    let hwnd = w.hwnd()?.0 as HWND;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_TRANSPARENT) as isize);
    }
    Ok(())
}

pub fn handle(app: &AppHandle, r: Radial) {
    match r {
        Radial::Open => {
            let _ = app.emit_to(LABEL, "radial", serde_json::json!({ "kind": "open" }));
            show(app, true);
        }
        Radial::Aim(slot) => {
            let _ = app.emit_to(LABEL, "radial", serde_json::json!({ "kind": "aim", "slot": slot }));
        }
        Radial::Pick(slot) => {
            let _ = app.emit_to(LABEL, "radial", serde_json::json!({ "kind": "close" }));
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(HIDE_AFTER);
                show(&h, false);
            });
            if let Some(s) = slot.and_then(|i| SLOTS.get(i as usize)) {
                run(app, *s);
            }
        }
    }
}

fn run(app: &AppHandle, slot: Slot) {
    let state = app.state::<crate::AppState>();
    let name = match slot {
        Slot::Keyboard => {
            state.send(Mode::Keyboard);
            "teclado"
        }
        Slot::Home => {
            state.send(Mode::Home);
            "inicio"
        }
        Slot::Snip => {
            inject::key_combo(&[VK_LWIN, VK_SHIFT, VK_S]);
            "captura"
        }
        Slot::Desktop => {
            inject::key_combo(&[VK_LWIN, VK_D]);
            "escritorio"
        }
        Slot::CloseWindow => {
            let fg = crate::switcher::foreground();
            // Never the desktop or the taskbar (Alt+F4 there would offer to
            // shut down), nor one of ours (the welcome would close half done).
            if fg.is_null() || shell_window(fg) || crate::switcher::pid_of(fg) == std::process::id() {
                return;
            }
            crate::switcher::close(fg);
            "cerrar ventana"
        }
    };
    app.state::<crate::events::Events>().log(&format!("menú radial: {name}"));
}

fn shell_window(hwnd: HWND) -> bool {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

/// Shows it centred on the monitor under the cursor, or hides it.
fn show(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = handle.get_webview_window(LABEL) else { return };
        let Ok(hwnd) = w.hwnd().map(|h| h.0 as HWND) else { return };
        unsafe {
            if !visible {
                ShowWindow(hwnd, SW_HIDE);
                return;
            }
            if let Some((area, scale)) = crate::overlay::monitor_at(inject::cursor_pos()) {
                let side = (SIZE * scale) as i32;
                let x = area.left + (area.right - area.left - side) / 2;
                let y = area.top + (area.bottom - area.top - side) / 2;
                let _ = w.set_position(PhysicalPosition::new(x, y));
                let _ = w.set_size(PhysicalSize::new(side as u32, side as u32));
                let _ = w.set_position(PhysicalPosition::new(x, y));
            }
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    });
}
