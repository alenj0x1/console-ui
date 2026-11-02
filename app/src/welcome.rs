//! The welcome: the first time the app opens (and from Ajustes), a short
//! practice with the controller itself (point and click, how the pointer
//! feels, the keyboard, Inicio and the control centre), in a normal window
//! that the cursor drives like any other.

use padcore::Mode;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::store::Store;

pub const LABEL: &str = "welcome";

/// Opens the welcome (or brings it back) with the cursor in charge.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    app.state::<crate::AppState>().send(Mode::Cursor);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("welcome.html".into()))
        .title(crate::i18n::t("title.welcome"))
        .decorations(false)
        .fullscreen(true)
        .focused(true)
        .build()?;
    Ok(())
}

pub fn needed(app: &AppHandle) -> bool {
    !app.state::<Store>().settings.lock().unwrap().welcomed
}

/// From Ajustes: practise again. (Async: building a window inside a
/// command that runs on the main thread would wait on itself.)
#[tauri::command]
pub async fn welcome_open(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != crate::home::LABEL {
        return Err(crate::i18n::t("err.not_allowed").into());
    }
    open(&app).map_err(|e| e.to_string())
}

/// The welcome ended (finished or skipped): it won't open by itself again,
/// and Inicio opens.
#[tauri::command]
pub fn welcome_done(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err(crate::i18n::t("err.not_allowed").into());
    }
    app.state::<Store>().update(|s| s.welcomed = true)?;
    app.state::<crate::events::Events>().log("bienvenida terminada");
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    app.state::<crate::AppState>().send(Mode::Home);
    Ok(())
}
