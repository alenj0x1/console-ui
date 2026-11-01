//! Backend-neutral gamepad state. Button bits follow the XInput layout so the
//! XInput backend maps 1:1; other backends translate into it.

pub mod btn {
    pub const DPAD_UP: u16 = 0x0001;
    pub const DPAD_DOWN: u16 = 0x0002;
    pub const DPAD_LEFT: u16 = 0x0004;
    pub const DPAD_RIGHT: u16 = 0x0008;
    /// "Menu" on Xbox controllers, "Options" on PlayStation.
    pub const START: u16 = 0x0010;
    /// "View" on Xbox controllers, "Share/Create" on PlayStation.
    pub const BACK: u16 = 0x0020;
    pub const L3: u16 = 0x0040;
    pub const R3: u16 = 0x0080;
    pub const LB: u16 = 0x0100;
    pub const RB: u16 = 0x0200;
    pub const A: u16 = 0x1000;
    pub const B: u16 = 0x2000;
    pub const X: u16 = 0x4000;
    pub const Y: u16 = 0x8000;

    pub const DPAD: [u16; 4] = [DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT];
}

/// Sticks are in [-1, 1] with +y pointing up; triggers in [0, 1].
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct PadState {
    pub buttons: u16,
    pub lx: f32,
    pub ly: f32,
    pub rx: f32,
    pub ry: f32,
    pub lt: f32,
    pub rt: f32,
}

impl PadState {
    pub fn held(&self, b: u16) -> bool {
        self.buttons & b == b
    }

    /// True when anything is away from rest (used for idle detection).
    pub fn is_active(&self) -> bool {
        const EPS: f32 = 0.2;
        self.buttons != 0
            || self.lx.abs() > EPS
            || self.ly.abs() > EPS
            || self.rx.abs() > EPS
            || self.ry.abs() > EPS
            || self.lt > 0.05
            || self.rt > 0.05
    }
}
