//! Admin windows: Windows blocks a normal app from sending input to a window
//! that runs as administrator (UIPI), so the cursor stops over it. We do not
//! raise our own rights to get around that; instead we tell the user and let
//! B hand the focus back to a normal window.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows_sys::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GW_HWNDNEXT, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, WS_EX_TOOLWINDOW,
};

pub struct Foreground {
    pub hwnd: HWND,
    pub title: String,
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid
}

/// True when the process runs elevated, or when we may not even look at its
/// token (which only happens for higher-integrity processes).
fn is_elevated(pid: u32) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false; // system or protected process: not an app window we could drive anyway
        }
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0;
        CloseHandle(process);
        if !opened {
            return true;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

fn title(hwnd: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(hwnd);
        if n <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

/// The foreground window, if it belongs to an elevated process.
pub fn elevated_foreground() -> Option<Foreground> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() || !is_elevated(pid_of(hwnd)) {
        return None;
    }
    Some(Foreground { hwnd, title: title(hwnd) })
}

/// Gives the focus to the next normal window below `from` (or the taskbar),
/// so the controller works again. Call while our process may set the
/// foreground (right after one of our windows took the focus).
pub fn hand_focus_back(from: HWND) {
    unsafe {
        let mut w = GetWindow(from, GW_HWNDNEXT);
        while !w.is_null() {
            let tool = GetWindowLongPtrW(w, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0;
            if IsWindowVisible(w) != 0 && !tool && !title(w).is_empty() && pid_of(w) != std::process::id() && !is_elevated(pid_of(w)) {
                SetForegroundWindow(w);
                return;
            }
            w = GetWindow(w, GW_HWNDNEXT);
        }
        let tray: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
        let taskbar = FindWindowW(tray.as_ptr(), std::ptr::null());
        if !taskbar.is_null() {
            SetForegroundWindow(taskbar);
        }
    }
}

#[cfg(test)]
mod tests {
    /// Run against this PC: an elevated process (GpuVM) is detected and this
    /// one is not. `cargo test -p console-ui-app admin -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn detects_elevated_process() {
        assert!(!super::is_elevated(std::process::id()));
        let out = std::process::Command::new("tasklist").args(["/FI", "IMAGENAME eq gpuvm.exe", "/FO", "CSV", "/NH"]).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let pid: u32 = text.split(',').nth(1).map(|p| p.trim_matches('"').parse().unwrap()).expect("GpuVM running");
        println!("gpuvm {pid} elevated = {}", super::is_elevated(pid));
        let explorer = std::process::Command::new("tasklist").args(["/FI", "IMAGENAME eq explorer.exe", "/FO", "CSV", "/NH"]).output().unwrap();
        let epid: u32 = String::from_utf8_lossy(&explorer.stdout).split(',').nth(1).map(|p| p.trim_matches('"').parse().unwrap()).unwrap();
        println!("explorer {epid} elevated = {}", super::is_elevated(epid));
        assert!(super::is_elevated(pid));
        assert!(!super::is_elevated(epid));
    }
}
