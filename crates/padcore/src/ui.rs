//! Gamepad → UI navigation events for on-screen interfaces (keyboard, home).
//! Sticks and d-pad become 4-way moves with key-like repeat; buttons become
//! press/release. View and Menu only arrive as taps (press + release together)
//! so the View + Menu chord never leaks into the UI.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::pad::{PadState, btn};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Left,
    Right,
    Dpad,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UiEvent {
    Press { button: &'static str },
    Release { button: &'static str },
    Nav { source: Source, dir: Dir },
}

const BUTTONS: [(u16, &str); 8] = [
    (btn::A, "a"),
    (btn::B, "b"),
    (btn::X, "x"),
    (btn::Y, "y"),
    (btn::LB, "lb"),
    (btn::RB, "rb"),
    (btn::L3, "l3"),
    (btn::R3, "r3"),
];

const FIRST_REPEAT: Duration = Duration::from_millis(260);
const DPAD_REPEAT: Duration = Duration::from_millis(80);
const STICK_ON: f32 = 0.55;
const STICK_OFF: f32 = 0.35;
const TRIGGER_ON: f32 = 0.5;
const TRIGGER_OFF: f32 = 0.35;

#[derive(Default)]
struct Repeat {
    dir: Option<Dir>,
    next: Option<Instant>,
}

impl Repeat {
    /// `want` is the held direction (if any); `every` the repeat interval.
    fn update(&mut self, want: Option<Dir>, every: Duration, now: Instant) -> Option<Dir> {
        if want != self.dir {
            self.dir = want;
            self.next = want.map(|_| now + FIRST_REPEAT);
            return want;
        }
        let next = self.next?;
        if now < next {
            return None;
        }
        self.next = Some(next.max(now - every) + every);
        self.dir
    }
}

fn stick_dir(x: f32, y: f32, current: Option<Dir>) -> Option<Dir> {
    let mag = x.hypot(y);
    if mag < if current.is_some() { STICK_OFF } else { STICK_ON } {
        return None;
    }
    let horizontal = if x > 0.0 { Dir::Right } else { Dir::Left };
    let vertical = if y > 0.0 { Dir::Up } else { Dir::Down };
    // Hysteresis near diagonals: keep the current axis unless the other clearly wins.
    let (ax, ay) = (x.abs(), y.abs());
    Some(match current {
        Some(Dir::Left | Dir::Right) if ax >= ay * 0.8 => horizontal,
        Some(Dir::Up | Dir::Down) if ay >= ax * 0.8 => vertical,
        _ if ax >= ay => horizontal,
        _ => vertical,
    })
}

/// Faster repeat the further the stick is pushed: 110 ms → 60 ms.
fn stick_every(x: f32, y: f32) -> Duration {
    let t = ((x.hypot(y) - STICK_ON) / (1.0 - STICK_ON)).clamp(0.0, 1.0);
    Duration::from_millis((110.0 - 50.0 * t) as u64)
}

fn dpad_dir(pad: &PadState) -> Option<Dir> {
    [(btn::DPAD_UP, Dir::Up), (btn::DPAD_DOWN, Dir::Down), (btn::DPAD_LEFT, Dir::Left), (btn::DPAD_RIGHT, Dir::Right)]
        .into_iter()
        .find(|(b, _)| pad.held(*b))
        .map(|(_, d)| d)
}

#[derive(Default)]
pub struct UiNav {
    left: Repeat,
    right: Repeat,
    dpad: Repeat,
    lt: bool,
    rt: bool,
}

impl UiNav {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn events(&mut self, pad: &PadState, prev: &PadState, now: Instant, out: &mut Vec<UiEvent>) {
        let pressed = pad.buttons & !prev.buttons;
        let released = !pad.buttons & prev.buttons;
        for (b, name) in BUTTONS {
            if pressed & b != 0 {
                out.push(UiEvent::Press { button: name });
            } else if released & b != 0 {
                out.push(UiEvent::Release { button: name });
            }
        }
        for (held, value, name) in [(&mut self.lt, pad.lt, "lt"), (&mut self.rt, pad.rt, "rt")] {
            if !*held && value >= TRIGGER_ON {
                *held = true;
                out.push(UiEvent::Press { button: name });
            } else if *held && value <= TRIGGER_OFF {
                *held = false;
                out.push(UiEvent::Release { button: name });
            }
        }
        let moves = [
            (Source::Left, self.left.update(stick_dir(pad.lx, pad.ly, self.left.dir), stick_every(pad.lx, pad.ly), now)),
            (Source::Right, self.right.update(stick_dir(pad.rx, pad.ry, self.right.dir), stick_every(pad.rx, pad.ry), now)),
            (Source::Dpad, self.dpad.update(dpad_dir(pad), DPAD_REPEAT, now)),
        ];
        for (source, dir) in moves {
            if let Some(dir) = dir {
                out.push(UiEvent::Nav { source, dir });
            }
        }
    }
}

/// View / Menu taps as a press + release pair.
pub fn tap(button: &'static str, out: &mut Vec<UiEvent>) {
    out.push(UiEvent::Press { button });
    out.push(UiEvent::Release { button });
}
