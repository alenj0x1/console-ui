//! Synthetic mouse and keyboard input via SendInput.
//!
//! The cursor moves with absolute coordinates on the virtual desktop so the
//! user's "Enhance pointer precision" setting does not distort the curves.
//! Sub-pixel motion is accumulated in floating point.

use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

const WHEEL_DELTA: f32 = 120.0;
/// Smallest wheel step sent; smaller amounts keep accumulating.
const WHEEL_MIN_UNITS: f32 = 8.0;
const RECT_REFRESH: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DeskRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

impl DeskRect {
    pub fn current() -> Self {
        unsafe {
            Self {
                left: GetSystemMetrics(SM_XVIRTUALSCREEN),
                top: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
            }
        }
    }

    /// Normalized 0..65535 coordinate that Windows maps back to exactly `x`.
    fn norm_x(&self, x: i32) -> i32 {
        norm(x - self.left, self.width)
    }

    fn norm_y(&self, y: i32) -> i32 {
        norm(y - self.top, self.height)
    }
}

fn norm(p: i32, size: i32) -> i32 {
    // Windows converts back with floor(n * size / 65536); aim at the middle of the pixel.
    ((2 * p as i64 + 1) * 65536 / (2 * size as i64)) as i32
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

/// Height of the primary monitor in pixels; cursor speeds scale with it.
pub fn primary_height() -> f32 {
    primary_size().1 as f32
}

pub fn primary_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN).max(1), GetSystemMetrics(SM_CYSCREEN).max(1)) }
}

#[derive(Default, Debug, Clone, Copy)]
pub struct InjectStats {
    pub moves: u64,
    /// Times the real cursor was not where we left it (user moved the mouse,
    /// or Windows clamped us at a monitor edge) and we re-synced.
    pub resyncs: u64,
}

pub struct Injector {
    acc: (f64, f64),
    /// Last few positions we sent; SendInput is processed asynchronously so
    /// the real cursor may still report one of these.
    recent: [(i32, i32); 3],
    rect: DeskRect,
    rect_at: Instant,
    wheel: (f32, f32),
    pub stats: InjectStats,
}

impl Default for Injector {
    fn default() -> Self {
        let cur = cursor_pos();
        Self {
            acc: (cur.0 as f64 + 0.5, cur.1 as f64 + 0.5),
            recent: [cur; 3],
            rect: DeskRect::current(),
            rect_at: Instant::now(),
            wheel: (0.0, 0.0),
            stats: InjectStats::default(),
        }
    }
}

impl Injector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Moves the cursor by a (possibly fractional) number of pixels.
    pub fn move_by(&mut self, dx: f64, dy: f64) {
        if self.rect_at.elapsed() >= RECT_REFRESH {
            self.rect = DeskRect::current();
            self.rect_at = Instant::now();
        }
        let cur = cursor_pos();
        if !self.recent.contains(&cur) {
            self.acc = (cur.0 as f64 + 0.5, cur.1 as f64 + 0.5);
            self.recent = [cur; 3];
            self.stats.resyncs += 1;
        }
        let r = self.rect;
        self.acc.0 = (self.acc.0 + dx).clamp(r.left as f64, (r.left + r.width) as f64 - 0.001);
        self.acc.1 = (self.acc.1 + dy).clamp(r.top as f64, (r.top + r.height) as f64 - 0.001);
        let target = (self.acc.0.floor() as i32, self.acc.1.floor() as i32);
        if target == self.recent[0] {
            return;
        }
        self.recent = [target, self.recent[0], self.recent[1]];
        send_mouse(r.norm_x(target.0), r.norm_y(target.1), 0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        self.stats.moves += 1;
    }

    /// Scroll in wheel notches (fractions allowed); +y up, +x right.
    pub fn scroll(&mut self, notches_x: f32, notches_y: f32) {
        self.wheel.0 += notches_x * WHEEL_DELTA;
        self.wheel.1 += notches_y * WHEEL_DELTA;
        if self.wheel.1.abs() >= WHEEL_MIN_UNITS {
            let units = self.wheel.1.trunc();
            self.wheel.1 -= units;
            send_mouse(0, 0, units as i32, MOUSEEVENTF_WHEEL);
        }
        if self.wheel.0.abs() >= WHEEL_MIN_UNITS {
            let units = self.wheel.0.trunc();
            self.wheel.0 -= units;
            send_mouse(0, 0, units as i32, MOUSEEVENTF_HWHEEL);
        }
    }

    pub fn reset_scroll(&mut self) {
        self.wheel = (0.0, 0.0);
    }
}

/// Whether Windows considers the button pressed right now (any source).
pub fn button_is_down(b: MouseButton) -> bool {
    let vk = match b {
        MouseButton::Left => VK_LBUTTON,
        MouseButton::Right => VK_RBUTTON,
        MouseButton::Middle => VK_MBUTTON,
    };
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

pub fn mouse_button(b: MouseButton, down: bool) {
    let flags = match (b, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send_mouse(0, 0, 0, flags);
}

/// Presses the keys in order and releases them in reverse, as one atomic batch.
pub fn key_combo(vks: &[VIRTUAL_KEY]) {
    let mut inputs: Vec<INPUT> = vks.iter().map(|&vk| key_input(vk, true)).collect();
    inputs.extend(vks.iter().rev().map(|&vk| key_input(vk, false)));
    send(&inputs);
}

pub fn key_tap(vk: VIRTUAL_KEY) {
    key_combo(&[vk]);
}

/// Taps a navigation/editing key by name. Returns false for unknown names.
pub fn key_named(name: &str) -> bool {
    let vk = match name {
        "backspace" => VK_BACK,
        "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "volume_up" => VK_VOLUME_UP,
        "volume_down" => VK_VOLUME_DOWN,
        "mute" => VK_VOLUME_MUTE,
        _ => return false,
    };
    key_tap(vk);
    true
}

/// Types text as Unicode key events (ñ, á, ¿… independent of the keyboard layout).
pub fn type_text(text: &str) {
    let inputs: Vec<INPUT> = text
        .encode_utf16()
        .flat_map(|u| [unicode_input(u, true), unicode_input(u, false)])
        .collect();
    send(&inputs);
}

/// Deletes `backspaces` characters before the caret and types `text`, as one
/// batch so nothing can interleave (used to swap a word for a suggestion).
pub fn replace_text(backspaces: usize, text: &str) {
    let mut inputs = Vec::with_capacity(backspaces * 2 + text.len() * 2);
    for _ in 0..backspaces {
        inputs.push(key_input(VK_BACK, true));
        inputs.push(key_input(VK_BACK, false));
    }
    inputs.extend(text.encode_utf16().flat_map(|u| [unicode_input(u, true), unicode_input(u, false)]));
    send(&inputs);
}

fn unicode_input(unit: u16, down: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: unit,
                dwFlags: KEYEVENTF_UNICODE | if down { 0 } else { KEYEVENTF_KEYUP },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(vk: VIRTUAL_KEY, down: bool) -> INPUT {
    let mut flags = if down { 0 } else { KEYEVENTF_KEYUP };
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT
            | VK_INSERT | VK_DELETE | VK_LWIN | VK_RWIN | VK_APPS
            | VK_BROWSER_BACK | VK_BROWSER_FORWARD
            | VK_MEDIA_PLAY_PAUSE | VK_MEDIA_NEXT_TRACK | VK_MEDIA_PREV_TRACK
            | VK_VOLUME_UP | VK_VOLUME_DOWN | VK_VOLUME_MUTE
    )
}

fn send_mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) {
    send(&[INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as _,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }]);
}

fn send(inputs: &[INPUT]) {
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
}

/// Moves the cursor to a few known points and checks it lands exactly there.
/// Returns the number of points that missed. Restores the original position.
pub fn self_test() -> usize {
    let start = cursor_pos();
    let r = DeskRect::current();
    // Points on the primary monitor: the virtual desktop may have gaps that
    // Windows clamps, which would read as false misses.
    let (w, h) = primary_size();
    let points = [(0, 0), (w - 1, h - 1), (w / 2, h / 2), (w / 3 + 1, h / 7 + 3)];
    let mut misses = 0;
    for p in points {
        send_mouse(r.norm_x(p.0), r.norm_y(p.1), 0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        std::thread::sleep(Duration::from_millis(30));
        if cursor_pos() != p {
            misses += 1;
        }
    }
    send_mouse(r.norm_x(start.0), r.norm_y(start.1), 0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
    misses
}
