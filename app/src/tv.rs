//! TV mode: only the chosen screen stays on (it becomes the main one) and
//! the sound goes to the chosen output; turning it off puts both back as
//! they were. Windows' own saved layout is never changed, so if the app
//! dies meanwhile, Windows + P (or a restart) brings the usual one back,
//! and the app itself restores it on its next start.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, IMMDeviceEnumerator, MMDeviceEnumerator, eCommunications, eConsole, eMultimedia, eRender,
};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, STGM_READ};
use windows::core::{GUID, PCWSTR};
use windows_sys::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_TARGET_DEVICE_NAME,
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ALL_PATHS, QDC_ONLY_ACTIVE_PATHS, QUERY_DISPLAY_CONFIG_FLAGS,
    QueryDisplayConfig, SDC_ALLOW_CHANGES, SDC_APPLY, SDC_TOPOLOGY_EXTEND, SDC_USE_DATABASE_CURRENT, SDC_USE_SUPPLIED_DISPLAY_CONFIG,
    SetDisplayConfig,
};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LUID};
use windows_sys::Win32::Graphics::Gdi::DISPLAYCONFIG_PATH_ACTIVE;

use crate::store::Store;

#[derive(Clone, Serialize)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct TvState {
    pub on: bool,
    /// On, waiting for the user to say the TV shows it.
    pub pending: bool,
    /// The chosen screen and sound output (ids), if any.
    pub display: Option<String>,
    pub audio: Option<String>,
    pub displays: Vec<Choice>,
    pub outputs: Vec<Choice>,
}

/// What TV mode changed, to put it back, and whether the user said the TV
/// shows it (until then it turns itself off after CONFIRM_WITHIN).
#[derive(Default)]
pub struct Tv {
    before: Mutex<Option<Before>>,
    /// Held while the screens change: one change at a time (a double A must
    /// not save the TV-only layout as the one to go back to).
    busy: Mutex<()>,
    /// Counts changes, so a timer only acts on the change that started it.
    turn: AtomicU64,
    confirmed: AtomicBool,
}

/// Like the confirmation Windows asks after changing screens: no answer,
/// back as it was.
pub const CONFIRM_WITHIN: Duration = Duration::from_secs(15);

struct Before {
    paths: Vec<DISPLAYCONFIG_PATH_INFO>,
    modes: Vec<DISPLAYCONFIG_MODE_INFO>,
    /// The default sound output before (None: left as it was).
    audio: Option<String>,
}

// The before-state is plain data.
unsafe impl Send for Before {}

// ---------- screens ----------

fn query(flags: QUERY_DISPLAY_CONFIG_FLAGS) -> Option<(Vec<DISPLAYCONFIG_PATH_INFO>, Vec<DISPLAYCONFIG_MODE_INFO>)> {
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(flags, &mut np, &mut nm) != ERROR_SUCCESS {
            return None;
        }
        let mut paths = vec![std::mem::zeroed::<DISPLAYCONFIG_PATH_INFO>(); np as usize];
        let mut modes = vec![std::mem::zeroed::<DISPLAYCONFIG_MODE_INFO>(); nm as usize];
        if QueryDisplayConfig(flags, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), std::ptr::null_mut()) != ERROR_SUCCESS {
            return None;
        }
        paths.truncate(np as usize);
        modes.truncate(nm as usize);
        Some((paths, modes))
    }
}

/// A monitor's name and its device path (stable across restarts: the id).
fn target(adapter: LUID, id: u32) -> Option<(String, String)> {
    unsafe {
        let mut t: DISPLAYCONFIG_TARGET_DEVICE_NAME = std::mem::zeroed();
        t.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        t.header.size = size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
        t.header.adapterId = adapter;
        t.header.id = id;
        if DisplayConfigGetDeviceInfo(&mut t.header) != 0 {
            return None;
        }
        let text = |w: &[u16]| String::from_utf16_lossy(&w[..w.iter().position(|&c| c == 0).unwrap_or(w.len())]);
        let path = text(&t.monitorDevicePath);
        let name = text(&t.monitorFriendlyDeviceName);
        (!path.is_empty()).then(|| (if name.is_empty() { "Pantalla".into() } else { name }, path))
    }
}

/// Every monitor connected now, on or off.
fn displays() -> Vec<Choice> {
    let Some((paths, _)) = query(QDC_ALL_PATHS) else { return Vec::new() };
    let mut out: Vec<Choice> = Vec::new();
    for p in paths.iter().filter(|p| p.targetInfo.targetAvailable != 0) {
        if let Some((name, id)) = target(p.targetInfo.adapterId, p.targetInfo.id) {
            if !out.iter().any(|c| c.id == id) {
                out.push(Choice { id, name });
            }
        }
    }
    out
}

fn active_path(id: &str) -> Option<(Vec<DISPLAYCONFIG_PATH_INFO>, Vec<DISPLAYCONFIG_MODE_INFO>, usize)> {
    let (paths, modes) = query(QDC_ONLY_ACTIVE_PATHS)?;
    let at = paths.iter().position(|p| {
        p.flags & DISPLAYCONFIG_PATH_ACTIVE != 0 && target(p.targetInfo.adapterId, p.targetInfo.id).is_some_and(|(_, t)| t == id)
    })?;
    Some((paths, modes, at))
}

/// Leaves only the screen `id` on, as the main one.
fn only(id: &str) -> Result<(), String> {
    // A screen that is off is turned on first (extended), then kept alone.
    let (paths, mut modes, at) = match active_path(id) {
        Some(found) => found,
        None => {
            unsafe { SetDisplayConfig(0, std::ptr::null(), 0, std::ptr::null(), SDC_APPLY | SDC_TOPOLOGY_EXTEND) };
            active_path(id).ok_or("esa pantalla no está conectada")?
        }
    };
    let path = paths[at];
    // Alone, it must start at 0, 0 to be the main screen.
    let source = unsafe { path.sourceInfo.Anonymous.modeInfoIdx } as usize;
    if let Some(m) = modes.get_mut(source) {
        m.Anonymous.sourceMode.position = windows_sys::Win32::Foundation::POINTL { x: 0, y: 0 };
    }
    let flags = SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES;
    let r = unsafe { SetDisplayConfig(1, &path, modes.len() as u32, modes.as_ptr(), flags) };
    if r != 0 { Err(format!("Windows no cambió las pantallas ({r})")) } else { Ok(()) }
}

/// The screens as they were; failing that, as Windows has them saved.
fn restore_displays(before: Option<(&[DISPLAYCONFIG_PATH_INFO], &[DISPLAYCONFIG_MODE_INFO])>) {
    unsafe {
        if let Some((p, m)) = before {
            let flags = SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES;
            if SetDisplayConfig(p.len() as u32, p.as_ptr(), m.len() as u32, m.as_ptr(), flags) == 0 {
                return;
            }
        }
        SetDisplayConfig(0, std::ptr::null(), 0, std::ptr::null(), SDC_APPLY | SDC_USE_DATABASE_CURRENT);
    }
}

// ---------- sound ----------

#[allow(non_snake_case)]
mod policy {
    use windows::Win32::Media::Audio::ERole;
    use windows::core::{HRESULT, IUnknown, IUnknown_Vtbl, PCWSTR, interface};

    /// Windows' way to change the default output (the one its own sound
    /// settings use; not in the public SDK, stable since Windows 7).
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    pub unsafe trait IPolicyConfig: IUnknown {
        fn GetMixFormat(&self, id: PCWSTR, format: *mut *mut core::ffi::c_void) -> HRESULT;
        fn GetDeviceFormat(&self, id: PCWSTR, default: i32, format: *mut *mut core::ffi::c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, id: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, id: PCWSTR, endpoint: *mut core::ffi::c_void, mix: *mut core::ffi::c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, id: PCWSTR, default: i32, a: *mut i64, b: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, id: PCWSTR, a: *mut i64) -> HRESULT;
        fn GetShareMode(&self, id: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        fn SetShareMode(&self, id: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        fn GetPropertyValue(&self, id: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
        fn SetPropertyValue(&self, id: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    }

    /// Makes `id` (NUL-terminated) the default output for `role`.
    pub fn set_default(p: &IPolicyConfig, id: PCWSTR, role: ERole) -> windows::core::Result<()> {
        unsafe { p.SetDefaultEndpoint(id, role).ok() }
    }
}
use policy::IPolicyConfig;

const POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

fn with_com<T>(f: impl FnOnce() -> windows::core::Result<T>) -> Result<T, String> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r = f();
        if init.is_ok() {
            CoUninitialize();
        }
        r.map_err(|e| e.message())
    }
}

fn outputs() -> Vec<Choice> {
    with_com(|| unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let list = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut out = Vec::new();
        for i in 0..list.GetCount()? {
            // One output that can not be read is left out, not the whole list.
            let Ok(d) = list.Item(i) else { continue };
            let Ok(raw) = d.GetId() else { continue };
            let id = raw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(raw.0 as _));
            let Ok(name) = d.OpenPropertyStore(STGM_READ).and_then(|p| p.GetValue(&PKEY_Device_FriendlyName)) else { continue };
            out.push(Choice { id, name: name.to_string() });
        }
        Ok(out)
    })
    .unwrap_or_default()
}

fn default_output() -> Option<String> {
    with_com(|| unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let raw = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.GetId()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as _));
        Ok(id)
    })
    .ok()
}

fn set_output(id: &str) -> Result<(), String> {
    let wide: Vec<u16> = id.encode_utf16().chain([0]).collect();
    with_com(|| unsafe {
        let config: IPolicyConfig = CoCreateInstance(&POLICY_CONFIG, None, CLSCTX_ALL)?;
        for role in [eConsole, eMultimedia, eCommunications] {
            policy::set_default(&config, PCWSTR(wide.as_ptr()), role)?;
        }
        Ok(())
    })
}

// ---------- on / off ----------

pub fn state(app: &AppHandle) -> TvState {
    let s = app.state::<Store>().settings.lock().unwrap().clone();
    // Read once: two guards in one expression would wait on each other.
    let on = app.state::<Tv>().before.lock().unwrap().is_some();
    TvState {
        on,
        pending: on && !app.state::<Tv>().confirmed.load(Ordering::Relaxed),
        display: s.tv_display,
        audio: s.tv_audio,
        displays: displays(),
        outputs: outputs(),
    }
}

pub fn turn_on(app: &AppHandle) -> Result<(), String> {
    let tv = app.state::<Tv>();
    let _busy = tv.busy.lock().unwrap();
    if tv.before.lock().unwrap().is_some() {
        return Ok(());
    }
    let s = app.state::<Store>().settings.lock().unwrap().clone();
    let display = s.tv_display.ok_or("elige primero la pantalla de la TV")?;
    let (paths, modes) = query(QDC_ONLY_ACTIVE_PATHS).ok_or("no se pudieron leer las pantallas")?;
    // Saved before anything changes: if the app dies halfway, the next start
    // puts the screens back.
    app.state::<Store>().update(|s| {
        s.tv_left_on = true;
        s.tv_audio_before = None;
    })?;
    if let Err(e) = only(&display) {
        restore_displays(Some((&paths, &modes)));
        let _ = app.state::<Store>().update(|s| s.tv_left_on = false);
        return Err(e);
    }
    let mut before = Before { paths, modes, audio: None };
    if let Some(out) = s.tv_audio.filter(|o| outputs().iter().any(|c| &c.id == o)) {
        before.audio = default_output();
        let moved = set_output(&out).and_then(|_| if default_output().as_ref() == Some(&out) { Ok(()) } else { Err("sigue en la anterior".into()) });
        if let Err(e) = moved {
            app.state::<crate::events::Events>().log(&format!("modo TV: el sonido no cambió ({e})"));
            before.audio = None;
        }
    }
    let audio_before = before.audio.clone();
    *tv.before.lock().unwrap() = Some(before);
    let _ = app.state::<Store>().update(|s| s.tv_audio_before = audio_before);
    tv.confirmed.store(false, Ordering::Relaxed);
    let turn = tv.turn.fetch_add(1, Ordering::Relaxed) + 1;
    app.state::<crate::events::Events>().log("modo TV encendido");
    let _ = app.emit("tv", true);
    // Nobody said the TV shows it: back as it was.
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CONFIRM_WITHIN);
        let tv = h.state::<Tv>();
        if tv.turn.load(Ordering::Relaxed) == turn && !tv.confirmed.load(Ordering::Relaxed) {
            h.state::<crate::events::Events>().log("modo TV sin confirmar: vuelve como estaba");
            turn_off(&h);
        }
    });
    Ok(())
}

pub fn turn_off(app: &AppHandle) {
    let tv = app.state::<Tv>();
    let _busy = tv.busy.lock().unwrap();
    tv.turn.fetch_add(1, Ordering::Relaxed);
    let Some(before) = tv.before.lock().unwrap().take() else { return };
    restore_displays(Some((&before.paths, &before.modes)));
    if let Some(out) = before.audio {
        let _ = set_output(&out);
    }
    let _ = app.state::<Store>().update(|s| {
        s.tv_left_on = false;
        s.tv_audio_before = None;
    });
    app.state::<crate::events::Events>().log("modo TV apagado");
    let _ = app.emit("tv", false);
}

/// On start: TV mode was left on (the app stopped without turning it off),
/// so the screens and the sound go back to how they were.
pub fn recover(app: &AppHandle) {
    let s = app.state::<Store>().settings.lock().unwrap().clone();
    if !s.tv_left_on {
        return;
    }
    restore_displays(None);
    if let Some(out) = &s.tv_audio_before {
        let _ = set_output(out);
    }
    let _ = app.state::<Store>().update(|s| {
        s.tv_left_on = false;
        s.tv_audio_before = None;
    });
    app.state::<crate::events::Events>().log("modo TV: pantallas y sonido devueltos al iniciar");
}

/// The screens and sound to choose from, what is chosen and whether TV mode is on.
#[tauri::command]
pub async fn tv_state(app: AppHandle) -> Result<TvState, String> {
    tauri::async_runtime::spawn_blocking(move || state(&app)).await.map_err(|e| e.to_string())
}

/// Chooses the TV's screen or sound output ("display" / "audio"; an empty
/// audio id leaves the sound as it is). Only from the home screen.
#[tauri::command]
pub async fn tv_choose(app: AppHandle, webview: tauri::Webview, what: String, id: String) -> Result<(), String> {
    if webview.label() != crate::home::LABEL {
        return Err("no permitido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        match what.as_str() {
            "display" if displays().iter().any(|c| c.id == id) => store.update(|s| s.tv_display = Some(id)),
            "audio" if id.is_empty() => store.update(|s| s.tv_audio = None),
            "audio" if outputs().iter().any(|c| c.id == id) => store.update(|s| s.tv_audio = Some(id)),
            _ => Err("opción no válida".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turns TV mode on or off, from the home screen or the guide.
#[tauri::command]
pub async fn tv_set(app: AppHandle, webview: tauri::Webview, on: bool) -> Result<(), String> {
    if webview.label() != crate::home::LABEL && webview.label() != crate::guide::LABEL {
        return Err("no permitido".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if on {
            turn_on(&app)
        } else {
            turn_off(&app);
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The TV shows it: TV mode stays on.
#[tauri::command]
pub fn tv_confirm(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != crate::home::LABEL {
        return Err("no permitido".into());
    }
    app.state::<Tv>().confirmed.store(true, Ordering::Relaxed);
    Ok(())
}
