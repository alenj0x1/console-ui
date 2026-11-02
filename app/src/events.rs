//! A small diagnostic log of what the app did: mode changes, launches and
//! which program had the focus when the keyboard typed or pressed Enter.
//! Never what was typed. `events.log` in the app-data folder, trimmed to the
//! last lines so it never grows.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const KEEP_LINES: usize = 2000;

#[derive(Default)]
pub struct Events {
    path: Mutex<Option<PathBuf>>,
}

/// Executable name of the program that owns the foreground window.
pub fn foreground_program() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return "-".into();
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return format!("pid {pid}");
        }
        let mut buf = [0u16; MAX_PATH as usize];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return format!("pid {pid}");
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit('\\').next().unwrap_or(&full).to_owned()
    }
}

impl Events {
    pub fn open(&self, dir: PathBuf) {
        let path = dir.join("events.log");
        // Keep only the tail of earlier sessions.
        if let Ok(text) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = text.lines().collect();
            if lines.len() > KEEP_LINES {
                let _ = std::fs::write(&path, lines[lines.len() - KEEP_LINES / 2..].join("\n") + "\n");
            }
        }
        *self.path.lock().unwrap() = Some(path);
    }

    pub fn log(&self, what: &str) {
        let Some(path) = self.path.lock().unwrap().clone() else { return };
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            // One event per line, whatever a name or id contains.
            let what: String = what.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
            let _ = writeln!(f, "{ms} {what} [foco: {}]", foreground_program());
        }
    }
}
