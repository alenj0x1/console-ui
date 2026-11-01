//! Stick → cursor velocity. Speeds are in screen heights per second so a
//! profile feels the same on 1080p and 4K.

use serde::Serialize;

/// Speed boost that grows while the stick stays tilted.
#[derive(Clone, Debug, Serialize)]
pub struct Accel {
    /// Normalized deflection above which the boost builds up.
    pub threshold: f32,
    /// Seconds above the threshold before the boost starts.
    pub delay: f32,
    /// Seconds to reach the full boost.
    pub ramp: f32,
    /// Speed multiplier at full boost.
    pub factor: f32,
    /// How fast the built-up boost drains (seconds of hold per second) when
    /// the stick drops below the threshold. Large = instant reset.
    pub decay: f32,
}

/// Help for hitting things: slow down over clickable elements and hold the
/// cursor still for a moment when a click starts.
#[derive(Clone, Debug, Serialize)]
pub struct Assist {
    /// Speed multiplier over a clickable element (only while not boosting).
    pub hover_factor: f32,
    pub click_freeze_ms: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorProfile {
    pub id: String,
    pub deadzone: f32,
    /// Deflection treated as 100% (worn sticks rarely reach 1.0).
    pub outer: f32,
    pub exponent: f32,
    pub max_speed: f32,
    pub accel: Option<Accel>,
    /// Speed multiplier with the left trigger fully pressed.
    pub precision: f32,
    pub assist: Option<Assist>,
}

pub fn builtin_profiles() -> Vec<CursorProfile> {
    vec![
        CursorProfile {
            id: "lineal".into(),
            deadzone: 0.12,
            outer: 0.95,
            exponent: 1.0,
            max_speed: 1.1,
            accel: None,
            precision: 0.3,
            assist: None,
        },
        CursorProfile {
            id: "curva".into(),
            deadzone: 0.12,
            outer: 0.95,
            exponent: 2.2,
            max_speed: 1.6,
            accel: None,
            precision: 0.3,
            assist: None,
        },
        CursorProfile {
            id: "curva-turbo".into(),
            deadzone: 0.12,
            outer: 0.95,
            exponent: 2.0,
            max_speed: 1.2,
            accel: Some(Accel { threshold: 0.92, delay: 0.25, ramp: 0.5, factor: 2.2, decay: 1e6 }),
            precision: 0.3,
            assist: None,
        },
        // Run 1 showed overshoot near targets: lower base speed for aiming,
        // a boost that builds steadily from mid tilt for travel, and help at
        // the target itself.
        CursorProfile {
            id: "asistido".into(),
            deadzone: 0.12,
            outer: 0.95,
            exponent: 2.0,
            max_speed: 0.8,
            accel: Some(Accel { threshold: 0.55, delay: 0.0, ramp: 0.7, factor: 2.4, decay: 2.5 }),
            precision: 0.3,
            assist: Some(Assist { hover_factor: 0.45, click_freeze_ms: 90 }),
        },
    ]
}

pub fn profile(id: &str) -> Option<CursorProfile> {
    builtin_profiles().into_iter().find(|p| p.id == id)
}

pub struct CursorCurve {
    pub profile: CursorProfile,
    hold: f32,
}

impl CursorCurve {
    pub fn new(profile: CursorProfile) -> Self {
        Self { profile, hold: 0.0 }
    }

    /// Returns (vx, vy) in screen heights per second, +y down.
    pub fn velocity(&mut self, x: f32, y: f32, precision_trigger: f32, hovering: bool, dt: f32) -> (f32, f32) {
        let p = &self.profile;
        let mag = (x * x + y * y).sqrt();
        if mag <= p.deadzone {
            // Letting go means the user is about to re-aim: start slow again.
            self.hold = 0.0;
            return (0.0, 0.0);
        }
        let t = ((mag - p.deadzone) / (p.outer - p.deadzone)).clamp(0.0, 1.0);
        let mut speed = t.powf(p.exponent) * p.max_speed;
        let mut boost = 0.0;
        if let Some(a) = &p.accel {
            self.hold = if t >= a.threshold {
                self.hold + dt
            } else {
                (self.hold - a.decay * dt).max(0.0)
            };
            boost = smoothstep(((self.hold - a.delay) / a.ramp).clamp(0.0, 1.0));
            speed *= 1.0 + (a.factor - 1.0) * boost;
        }
        if let Some(assist) = &p.assist {
            // Slow down only when aiming, not when crossing the screen.
            if hovering && boost < 0.5 {
                speed *= assist.hover_factor;
            }
        }
        speed *= 1.0 - (1.0 - p.precision) * precision_trigger.clamp(0.0, 1.0);
        (x / mag * speed, -y / mag * speed)
    }
}

/// Right stick → scroll in wheel notches per second (+y up, +x right).
pub fn scroll_rate(x: f32, y: f32) -> (f32, f32) {
    const DEADZONE: f32 = 0.2;
    const MAX_NOTCHES: f32 = 20.0;
    let shape = |v: f32| {
        let a = ((v.abs() - DEADZONE) / (1.0 - DEADZONE)).clamp(0.0, 1.0);
        a * a * MAX_NOTCHES * v.signum()
    };
    (shape(x), shape(y))
}

fn smoothstep(k: f32) -> f32 {
    k * k * (3.0 - 2.0 * k)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn speed(v: (f32, f32)) -> f32 {
        (v.0 * v.0 + v.1 * v.1).sqrt()
    }

    #[test]
    fn deadzone_is_still() {
        let mut c = CursorCurve::new(profile("asistido").unwrap());
        assert_eq!(c.velocity(0.1, 0.0, 0.0, false, 0.005), (0.0, 0.0));
    }

    #[test]
    fn boost_builds_smoothly_and_resets_on_release() {
        let mut c = CursorCurve::new(profile("asistido").unwrap());
        let mut last = 0.0;
        for _ in 0..200 {
            let s = speed(c.velocity(1.0, 0.0, 0.0, false, 0.005));
            assert!(s >= last - 1e-6, "speed never drops while holding");
            assert!(s - last < 0.05 || last == 0.0, "no jumps between ticks");
            last = s;
        }
        assert!((last - 0.8 * 2.4).abs() < 1e-3);
        c.velocity(0.0, 0.0, 0.0, false, 0.005);
        assert!((speed(c.velocity(1.0, 0.0, 0.0, false, 0.005)) - 0.8).abs() < 0.01);
    }

    #[test]
    fn hover_slows_only_while_aiming() {
        let mut c = CursorCurve::new(profile("asistido").unwrap());
        let free = speed(c.velocity(0.6, 0.0, 0.0, false, 0.005));
        let mut c = CursorCurve::new(profile("asistido").unwrap());
        let over = speed(c.velocity(0.6, 0.0, 0.0, true, 0.005));
        assert!((over / free - 0.45).abs() < 0.01);
        for _ in 0..200 {
            c.velocity(1.0, 0.0, 0.0, true, 0.005);
        }
        assert!(speed(c.velocity(1.0, 0.0, 0.0, true, 0.005)) > 1.8, "travel is not braked");
    }
}
