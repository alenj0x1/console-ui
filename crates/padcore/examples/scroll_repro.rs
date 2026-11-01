//! Reproduces "scroll a menu, then move the cursor": opens the Start menu,
//! scrolls its list with the wheel, then moves the cursor like the engine
//! does, with or without the UI Automation hover probe. Saves nothing; it
//! prints where it is so screenshots can be taken between steps.
//!
//! cargo run --release -p padcore --example scroll_repro -- [probe] [fine]
//! `fine` scrolls in the small steps the engine sends (≈8 units per tick).
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use padcore::hover::{self, Hover};
use padcore::inject::{self, Injector};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_ESCAPE, VK_LWIN};

fn pause(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn main() {
    let probe = std::env::args().any(|a| a == "probe");
    let fine = std::env::args().any(|a| a == "fine");
    let hover_state = Hover::new();
    let stop = Arc::new(AtomicBool::new(false));
    if probe {
        hover::spawn_probe(hover_state.clone(), stop.clone());
    }
    let (w, h) = inject::primary_size();
    let mut inj = Injector::new();

    inject::key_tap(VK_LWIN);
    pause(1200);
    // Over the app list of the Start menu (bottom-left of the screen).
    let target = (w / 9, h * 3 / 5);
    let cur = inject::cursor_pos();
    inj.move_by((target.0 - cur.0) as f64, (target.1 - cur.1) as f64);
    pause(300);
    if fine {
        // Right stick near full tilt: ~16 notches/s at 5 ms ticks.
        for _ in 0..250 {
            inj.scroll(0.0, -16.0 * 0.005);
            pause(5);
        }
    } else {
        for _ in 0..40 {
            inj.scroll(0.0, -0.5);
            pause(16);
        }
    }
    println!("scrolled");
    pause(1500); // screenshot "after scroll"
    for _ in 0..60 {
        hover_state.want(true);
        inj.move_by(1.5, 0.6);
        pause(5);
    }
    println!("moved");
    pause(1500); // screenshot "after move"
    inject::key_tap(VK_ESCAPE);
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
}
