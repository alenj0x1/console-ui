//! "Is the cursor over something clickable?" — fed by a UI Automation probe
//! thread (real desktop) or by the lab (its own targets). The engine only
//! reads the latest answer and ignores it when stale.
//!
//! UI Automation only reads what the accessibility tree exposes (the same as
//! a screen reader): it does not change or click anything.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Accessibility::*;

use crate::inject;

/// Answers older than this are ignored (e.g. a hung app blocked the probe).
const MAX_AGE: Duration = Duration::from_millis(200);
const PROBE_EVERY: Duration = Duration::from_millis(33);
const ASLEEP_EVERY: Duration = Duration::from_millis(100);
/// Re-query even without movement, in case the UI under the cursor changed.
const REFRESH_EVERY: Duration = Duration::from_millis(300);
/// Bigger elements are containers (lists, panes), not targets.
const MAX_AREA_SHARE: f64 = 0.2;

pub struct Hover {
    /// Set by the engine while the stick moves the cursor; the probe stays
    /// asleep otherwise (games, idle).
    wanted: AtomicBool,
    over: AtomicBool,
    stamp_us: AtomicU64,
    origin: Instant,
}

impl Default for Hover {
    fn default() -> Self {
        Self { wanted: AtomicBool::new(false), over: AtomicBool::new(false), stamp_us: AtomicU64::new(0), origin: Instant::now() }
    }
}

impl Hover {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set(&self, over: bool) {
        self.over.store(over, Ordering::Relaxed);
        self.stamp_us.store(self.origin.elapsed().as_micros() as u64, Ordering::Relaxed);
    }

    pub fn want(&self, on: bool) {
        self.wanted.store(on, Ordering::Relaxed);
    }

    pub fn get(&self) -> bool {
        let age = self.origin.elapsed().as_micros() as u64;
        let age = age.saturating_sub(self.stamp_us.load(Ordering::Relaxed));
        age <= MAX_AGE.as_micros() as u64 && self.over.load(Ordering::Relaxed)
    }
}

const CLICKABLE: [UIA_CONTROLTYPE_ID; 13] = [
    UIA_ButtonControlTypeId,
    UIA_HyperlinkControlTypeId,
    UIA_MenuItemControlTypeId,
    UIA_TabItemControlTypeId,
    UIA_CheckBoxControlTypeId,
    UIA_RadioButtonControlTypeId,
    UIA_ComboBoxControlTypeId,
    UIA_SplitButtonControlTypeId,
    UIA_ListItemControlTypeId,
    UIA_TreeItemControlTypeId,
    UIA_DataItemControlTypeId,
    UIA_EditControlTypeId,
    UIA_SliderControlTypeId,
];

/// One UI Automation client; must live on a single COM (MTA) thread.
pub struct UiaProbe {
    uia: IUIAutomation,
    screen_area: f64,
}

impl UiaProbe {
    /// Call on the thread that will use it; initializes COM for that thread.
    pub fn new() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let uia = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let (w, h) = inject::primary_size();
            Ok(Self { uia, screen_area: w as f64 * h as f64 })
        }
    }

    pub fn clickable_at(&self, (x, y): (i32, i32)) -> bool {
        self.query(x, y).unwrap_or(false)
    }

    fn query(&self, x: i32, y: i32) -> windows::core::Result<bool> {
        unsafe {
            let el = self.uia.ElementFromPoint(POINT { x, y })?;
            if !CLICKABLE.contains(&el.CurrentControlType()?) || !el.CurrentIsEnabled()?.as_bool() {
                return Ok(false);
            }
            let r = el.CurrentBoundingRectangle()?;
            let area = (r.right - r.left).max(0) as f64 * (r.bottom - r.top).max(0) as f64;
            Ok(area > 0.0 && area / self.screen_area <= MAX_AREA_SHARE)
        }
    }
}

impl Drop for UiaProbe {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// True when the focused control is a password field (or when it cannot be
/// told, so callers err on the private side). Safe to call from any thread.
pub fn focused_is_password() -> bool {
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let answer = (|| -> windows::core::Result<bool> {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            Ok(uia.GetFocusedElement()?.CurrentIsPassword()?.as_bool())
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        answer.unwrap_or(true)
    }
}

/// Background thread that keeps `hover` up to date for the real cursor.
pub fn spawn_probe(hover: Arc<Hover>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("uia-probe".into())
        .spawn(move || {
            let Ok(probe) = UiaProbe::new() else { return };
            let mut last: Option<((i32, i32), Instant)> = None;
            while !stop.load(Ordering::Relaxed) {
                if !hover.wanted.load(Ordering::Relaxed) {
                    last = None;
                    std::thread::sleep(ASLEEP_EVERY);
                    continue;
                }
                let pos = inject::cursor_pos();
                let due = match last {
                    None => true,
                    Some((p, t)) => {
                        (p.0 - pos.0).abs() + (p.1 - pos.1).abs() >= 2 || t.elapsed() >= REFRESH_EVERY
                    }
                };
                if due {
                    hover.set(probe.clickable_at(pos));
                    last = Some((pos, Instant::now()));
                } else {
                    // Same position, same answer: just keep it fresh.
                    hover.set(hover.over.load(Ordering::Relaxed));
                }
                std::thread::sleep(PROBE_EVERY);
            }
        })
        .expect("spawn uia probe")
}
