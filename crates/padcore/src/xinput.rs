//! XInput backend. Reads work while the app is in the background and need no
//! extra runtime. Polling an empty slot is slow, so disconnected slots are only
//! scanned once per second.

use std::time::{Duration, Instant};

use windows_sys::Win32::UI::Input::XboxController::{
    XINPUT_STATE, XINPUT_VIBRATION, XInputGetState, XInputSetState,
};

use crate::pad::PadState;

const SCAN_EVERY: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct XInput {
    slot: Option<u32>,
    last_scan: Option<Instant>,
}

impl XInput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn slot(&self) -> Option<u32> {
        self.slot
    }

    pub fn poll(&mut self) -> Option<PadState> {
        if let Some(slot) = self.slot {
            if let Some(state) = read(slot) {
                return Some(state);
            }
            self.slot = None;
        }
        let now = Instant::now();
        if self.last_scan.is_some_and(|t| now - t < SCAN_EVERY) {
            return None;
        }
        self.last_scan = Some(now);
        for slot in 0..4 {
            if let Some(state) = read(slot) {
                self.slot = Some(slot);
                return Some(state);
            }
        }
        None
    }

    /// Motor strengths in [0, 1]; (0, 0) stops.
    pub fn rumble(&self, low: f32, high: f32) {
        let Some(slot) = self.slot else { return };
        let mut v = XINPUT_VIBRATION {
            wLeftMotorSpeed: (low.clamp(0.0, 1.0) * 65535.0) as u16,
            wRightMotorSpeed: (high.clamp(0.0, 1.0) * 65535.0) as u16,
        };
        unsafe { XInputSetState(slot, &mut v) };
    }
}

fn read(slot: u32) -> Option<PadState> {
    let mut s: XINPUT_STATE = unsafe { std::mem::zeroed() };
    if unsafe { XInputGetState(slot, &mut s) } != 0 {
        return None;
    }
    let g = s.Gamepad;
    Some(PadState {
        buttons: g.wButtons as u16,
        lx: axis(g.sThumbLX),
        ly: axis(g.sThumbLY),
        rx: axis(g.sThumbRX),
        ry: axis(g.sThumbRY),
        lt: g.bLeftTrigger as f32 / 255.0,
        rt: g.bRightTrigger as f32 / 255.0,
    })
}

fn axis(v: i16) -> f32 {
    (v as f32 / 32767.0).clamp(-1.0, 1.0)
}
