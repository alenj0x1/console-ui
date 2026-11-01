//! Mode engine: turns gamepad state into desktop actions.
//!
//! Modes: `Off` lets games have the controller untouched; `Cursor` drives the
//! mouse and a few keys; `Keyboard` hands navigation events to the on-screen
//! keyboard. Holding View + Menu toggles Off ↔ on; Y opens the keyboard and B
//! closes it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

use crate::curve::{CursorCurve, CursorProfile, scroll_rate};
use crate::hover::Hover;
use crate::inject::{self, Injector, MouseButton};
use crate::pad::{PadState, btn};
use crate::ui::{self, UiEvent, UiNav};
use crate::xinput::XInput;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Cursor,
    Keyboard,
}

#[derive(Clone, Debug)]
pub enum Event {
    Connected(u32),
    Disconnected,
    ModeChanged(Mode),
    Ui(UiEvent),
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub profile: CursorProfile,
    pub start_mode: Mode,
    pub toggle_hold: Duration,
    /// View / Menu released before this counts as a tap.
    pub tap_max: Duration,
    pub repeat_delay: Duration,
    pub repeat_every: Duration,
    /// Y opens the keyboard (needs a host that shows it, e.g. the app).
    pub keyboard_enabled: bool,
    /// B does not close the keyboard (lab).
    pub keyboard_locked: bool,
}

impl EngineConfig {
    pub fn with_profile(profile: CursorProfile) -> Self {
        Self {
            profile,
            start_mode: Mode::Cursor,
            toggle_hold: Duration::from_millis(600),
            tap_max: Duration::from_millis(500),
            repeat_delay: Duration::from_millis(400),
            repeat_every: Duration::from_millis(60),
            keyboard_enabled: false,
            keyboard_locked: false,
        }
    }
}

const MOUSE_MAP: [(u16, MouseButton); 3] = [
    (btn::A, MouseButton::Left),
    (btn::X, MouseButton::Right),
    (btn::L3, MouseButton::Middle),
];

const TAP_MAP: [(u16, VIRTUAL_KEY); 4] = [
    (btn::B, VK_ESCAPE),
    (btn::LB, VK_BROWSER_BACK),
    (btn::RB, VK_BROWSER_FORWARD),
    (btn::R3, VK_RETURN),
];

const DPAD_KEYS: [VIRTUAL_KEY; 4] = [VK_UP, VK_DOWN, VK_LEFT, VK_RIGHT];

/// Short vibration patterns: (on, off) pairs.
const PULSE_ON: &[(u64, u64)] = &[(110, 0)];
const PULSE_OFF: &[(u64, u64)] = &[(70, 80), (70, 0)];

pub struct Engine {
    cfg: EngineConfig,
    mode: Mode,
    pad: XInput,
    curve: CursorCurve,
    pub inj: Injector,
    prev: PadState,
    connected: bool,
    last_tick: Instant,
    last_active: Instant,
    chord_since: Option<Instant>,
    /// View/Menu were part of a chord: their release must not fire a tap.
    chord_used: bool,
    view_down: Option<Instant>,
    menu_down: Option<Instant>,
    dpad_next: [Option<Instant>; 4],
    mouse_down: [bool; 3],
    rumble: Vec<(Instant, bool)>,
    height_px: f32,
    hover: Option<Arc<Hover>>,
    /// Cursor ignores the stick until then (click stabilization).
    freeze_until: Option<Instant>,
    last_move: Instant,
    nav: UiNav,
    ui_out: Vec<UiEvent>,
}

impl Engine {
    pub fn new(cfg: EngineConfig) -> Self {
        let now = Instant::now();
        Self {
            mode: cfg.start_mode,
            curve: CursorCurve::new(cfg.profile.clone()),
            cfg,
            pad: XInput::new(),
            inj: Injector::new(),
            prev: PadState::default(),
            connected: false,
            last_tick: now,
            last_active: now,
            chord_since: None,
            chord_used: false,
            view_down: None,
            menu_down: None,
            dpad_next: [None; 4],
            mouse_down: [false; 3],
            rumble: Vec::new(),
            height_px: inject::primary_height(),
            hover: None,
            freeze_until: None,
            last_move: now,
            nav: UiNav::default(),
            ui_out: Vec::new(),
        }
    }

    /// Source for "cursor is over something clickable" (UI Automation probe or lab).
    pub fn with_hover(mut self, hover: Arc<Hover>) -> Self {
        self.hover = Some(hover);
        self
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn connected(&self) -> bool {
        self.connected
    }

    pub fn profile(&self) -> &CursorProfile {
        &self.curve.profile
    }

    pub fn set_profile(&mut self, p: CursorProfile) {
        self.curve = CursorCurve::new(p);
    }

    pub fn idle_for(&self) -> Duration {
        self.last_active.elapsed()
    }

    pub fn set_mode(&mut self, mode: Mode) {
        if mode == self.mode {
            return;
        }
        self.release_all();
        if let Some(h) = &self.hover {
            h.want(false);
        }
        self.nav.reset();
        if mode == Mode::Off {
            self.queue_rumble(PULSE_OFF);
        } else if self.mode == Mode::Off {
            self.queue_rumble(PULSE_ON);
        }
        self.mode = mode;
    }

    /// Releases anything we are holding down. Call before exiting.
    pub fn release_all(&mut self) {
        for (i, (_, b)) in MOUSE_MAP.iter().enumerate() {
            if std::mem::take(&mut self.mouse_down[i]) {
                inject::mouse_button(*b, false);
            }
        }
        self.dpad_next = [None; 4];
        self.inj.reset_scroll();
    }

    /// Reads the controller once, applies it and appends what happened to
    /// `out`. Call at a steady rate.
    pub fn step(&mut self, out: &mut Vec<Event>) {
        let now = Instant::now();
        let dt = (now - self.last_tick).as_secs_f32().min(0.05);
        self.last_tick = now;
        self.run_rumble(now);

        let Some(pad) = self.pad.poll() else {
            if std::mem::take(&mut self.connected) {
                self.release_all();
                self.prev = PadState::default();
                out.push(Event::Disconnected);
            }
            return;
        };
        if !self.connected {
            self.connected = true;
            self.prev = pad;
            out.push(Event::Connected(self.pad.slot().unwrap_or(0)));
        }
        if pad.is_active() {
            self.last_active = now;
        }

        if let Some(m) = self.chord(&pad, now) {
            out.push(Event::ModeChanged(m));
        }
        let pressed = pad.buttons & !self.prev.buttons;
        match self.mode {
            Mode::Cursor if self.cfg.keyboard_enabled && pressed & btn::Y != 0 => {
                self.set_mode(Mode::Keyboard);
                out.push(Event::ModeChanged(Mode::Keyboard));
            }
            Mode::Cursor => self.cursor(&pad, dt, now),
            Mode::Keyboard if !self.cfg.keyboard_locked && pressed & btn::B != 0 => {
                self.set_mode(Mode::Cursor);
                out.push(Event::ModeChanged(Mode::Cursor));
            }
            Mode::Keyboard => self.keyboard(&pad, now, out),
            Mode::Off => {}
        }
        self.prev = pad;
    }

    fn keyboard(&mut self, pad: &PadState, now: Instant, out: &mut Vec<Event>) {
        let prev = self.prev;
        self.nav.events(pad, &prev, now, &mut self.ui_out);
        let released = !pad.buttons & prev.buttons;
        if released & btn::BACK != 0 && !self.chord_used {
            ui::tap("view", &mut self.ui_out);
        }
        if released & btn::START != 0 && !self.chord_used {
            ui::tap("menu", &mut self.ui_out);
        }
        out.extend(self.ui_out.drain(..).map(Event::Ui));
    }

    fn chord(&mut self, pad: &PadState, now: Instant) -> Option<Mode> {
        let both = pad.held(btn::BACK | btn::START);
        let mut changed = None;
        if both {
            let since = *self.chord_since.get_or_insert(now);
            self.chord_used = true;
            if since != now && now - since >= self.cfg.toggle_hold {
                let next = if self.mode == Mode::Off { Mode::Cursor } else { Mode::Off };
                self.set_mode(next);
                changed = Some(next);
                // Re-arm only after both buttons go up.
                self.chord_since = Some(now + Duration::from_secs(3600));
            }
        } else {
            self.chord_since = None;
        }
        if !pad.held(btn::BACK) && !pad.held(btn::START) {
            // Taps fire from cursor() before this flag clears on the same tick.
            if self.chord_used && self.prev.buttons & (btn::BACK | btn::START) == 0 {
                self.chord_used = false;
            }
        }
        changed
    }

    fn cursor(&mut self, pad: &PadState, dt: f32, now: Instant) {
        let pressed = pad.buttons & !self.prev.buttons;
        let released = !pad.buttons & self.prev.buttons;

        if pressed & (btn::A | btn::X) != 0 {
            if let Some(a) = &self.curve.profile.assist {
                self.freeze_until = Some(now + Duration::from_millis(a.click_freeze_ms as u64));
            }
        }
        let moving = pad.lx.hypot(pad.ly) > self.curve.profile.deadzone;
        if moving {
            self.last_move = now;
        }
        if let Some(h) = &self.hover {
            h.want(now - self.last_move < Duration::from_secs(1));
        }
        let hovering = self.hover.as_ref().is_some_and(|h| h.get());
        let (vx, vy) = self.curve.velocity(pad.lx, pad.ly, pad.lt, hovering, dt);
        let frozen = self.freeze_until.is_some_and(|t| now < t);
        if !frozen && (vx != 0.0 || vy != 0.0) {
            let k = (self.height_px * dt) as f64;
            self.inj.move_by(vx as f64 * k, vy as f64 * k);
        }

        let (sx, sy) = scroll_rate(pad.rx, pad.ry);
        if sx != 0.0 || sy != 0.0 {
            self.inj.scroll(sx * dt, sy * dt);
        }

        for (i, (b, mb)) in MOUSE_MAP.iter().enumerate() {
            if pressed & b != 0 {
                inject::mouse_button(*mb, true);
                self.mouse_down[i] = true;
            } else if released & b != 0 && self.mouse_down[i] {
                inject::mouse_button(*mb, false);
                self.mouse_down[i] = false;
            }
        }

        for (b, vk) in TAP_MAP {
            if pressed & b != 0 {
                inject::key_tap(vk);
            }
        }

        for i in 0..4 {
            let b = btn::DPAD[i];
            if pressed & b != 0 {
                inject::key_tap(DPAD_KEYS[i]);
                self.dpad_next[i] = Some(now + self.cfg.repeat_delay);
            } else if !pad.held(b) {
                self.dpad_next[i] = None;
            } else if let Some(t) = self.dpad_next[i].filter(|t| now >= *t) {
                inject::key_tap(DPAD_KEYS[i]);
                self.dpad_next[i] = Some(t + self.cfg.repeat_every);
            }
        }

        // View tap → Task View, Menu tap → Start. Fired on release so the
        // View + Menu chord never opens either.
        if pressed & btn::BACK != 0 {
            self.view_down = Some(now);
        }
        if pressed & btn::START != 0 {
            self.menu_down = Some(now);
        }
        let tap = |down: Option<Instant>| down.is_some_and(|t| now - t < self.cfg.tap_max);
        if released & btn::BACK != 0 {
            if !self.chord_used && tap(self.view_down) {
                inject::key_combo(&[VK_LWIN, VK_TAB]);
            }
            self.view_down = None;
        }
        if released & btn::START != 0 {
            if !self.chord_used && tap(self.menu_down) {
                inject::key_tap(VK_LWIN);
            }
            self.menu_down = None;
        }
    }

    fn queue_rumble(&mut self, pattern: &[(u64, u64)]) {
        let mut t = Instant::now();
        self.rumble.clear();
        for &(on, off) in pattern {
            self.rumble.push((t, true));
            t += Duration::from_millis(on);
            self.rumble.push((t, false));
            t += Duration::from_millis(off);
        }
    }

    fn run_rumble(&mut self, now: Instant) {
        while let Some(&(at, on)) = self.rumble.first() {
            if at > now {
                break;
            }
            self.rumble.remove(0);
            if on { self.pad.rumble(0.35, 0.2) } else { self.pad.rumble(0.0, 0.0) }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.release_all();
        self.pad.rumble(0.0, 0.0);
    }
}
