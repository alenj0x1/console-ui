//! Keeps other apps from reading the controller while it drives Windows.
//!
//! UWP/XAML apps (Start menu, Settings, Store…) read the controller themselves
//! and move their own focus, fighting the cursor. When HidHide (Nefarius,
//! MIT) is installed, Console UI registers itself as the only app allowed to
//! see the controller and hides it from everyone else in cursor, keyboard and
//! home modes; game mode shows it again. Without HidHide this does nothing.
//!
//! Uses HidHide's CLI, which needs no elevation (~20 ms per call). A tiny
//! watchdog process (`--guard <pid>`) shows the controller again if the app
//! dies without cleaning up, so games are never left without it.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde::Deserialize;

const CLI: &str = r"C:\Program Files\Nefarius Software Solutions\HidHide\x64\HidHideCLI.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    present: bool,
    device_instance_path: String,
    base_container_device_instance_path: String,
}

#[derive(Deserialize)]
struct Group {
    devices: Vec<Device>,
}

#[derive(Default)]
pub struct Guard {
    /// Last state sent, to skip redundant calls.
    hidden: Mutex<Option<bool>>,
}

fn cli() -> Option<PathBuf> {
    let p = PathBuf::from(CLI);
    p.is_file().then_some(p)
}

fn run(args: &[&str]) -> Option<String> {
    let out = Command::new(cli()?).args(args).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

impl Guard {
    pub fn available() -> bool {
        cli().is_some()
    }

    /// Allows this exe and hides every connected game controller (each HID
    /// child and its USB container, which is what XInput opens). Safe to
    /// repeat, e.g. when a new controller connects.
    pub fn register(&self) {
        if !Self::available() {
            return;
        }
        let Ok(exe) = std::env::current_exe() else { return };
        let Some(json) = run(&["--dev-gaming"]) else { return };
        let groups: Vec<Group> = serde_json::from_str(&json).unwrap_or_default();
        let mut args: Vec<String> = vec!["--app-reg".into(), exe.display().to_string()];
        let mut seen = Vec::new();
        for d in groups.iter().flat_map(|g| &g.devices).filter(|d| d.present) {
            for path in [&d.device_instance_path, &d.base_container_device_instance_path] {
                if !path.is_empty() && !seen.contains(path) {
                    seen.push(path.clone());
                    args.push("--dev-hide".into());
                    args.push(path.clone());
                }
            }
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&refs);
        // A new device list must be re-applied with the current cloak state.
        *self.hidden.lock().unwrap() = None;
    }

    pub fn set_hidden(&self, hidden: bool) {
        if !Self::available() {
            return;
        }
        let mut last = self.hidden.lock().unwrap();
        if *last == Some(hidden) {
            return;
        }
        if run(&[if hidden { "--cloak-on" } else { "--cloak-off" }]).is_some() {
            *last = Some(hidden);
        }
    }
}

/// Starts the watchdog for this process (only when HidHide is installed).
pub fn spawn_watchdog() {
    if !Guard::available() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe)
            .args(["--guard", &std::process::id().to_string()])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn();
    }
}

/// Watchdog entry: waits for `pid` to end, then shows the controller.
pub fn watchdog(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return;
        }
        WaitForSingleObject(h, INFINITE);
        CloseHandle(h);
    }
    run(&["--cloak-off"]);
}
