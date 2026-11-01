//! Cursor lab: compares the built-in stick profiles blind.
//!
//! Run 2: baseline `curva` vs `asistido`. Two unscored warm-up blocks, then
//! counterbalanced scored blocks (ABBAAB), each profile hidden behind a number. We record movement time, Fitts
//! throughput, misses, path efficiency and a 1–5 rating, plus the engine's
//! real tick timing. Results go to `labs/cursor-lab/results/`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eframe::egui::{self, Align2, Color32, FontId, Pos2, Rect, Stroke, Vec2};
use padcore::{CursorProfile, Engine, EngineConfig, Hover, inject, profile};
use serde::Serialize;

const COMPARE: [&str; 2] = ["curva", "asistido"];
const WARMUP_TARGETS: usize = 8;
const TARGETS_PER_BLOCK: usize = 15;
const ROUNDS: usize = 3;
const TICK: Duration = Duration::from_millis(4);
const RADII: [f32; 3] = [14.0, 24.0, 40.0];

// Graphite theme, single blue accent.
const BG: Color32 = Color32::from_rgb(0x1e, 0x1f, 0x22);
const SURFACE: Color32 = Color32::from_rgb(0x2a, 0x2b, 0x2f);
const SURFACE_HOVER: Color32 = Color32::from_rgb(0x35, 0x37, 0x3c);
const RING: Color32 = Color32::from_rgb(0x3a, 0x3c, 0x41);
const TEXT: Color32 = Color32::from_rgb(0xec, 0xe8, 0xdf);
const MUTED: Color32 = Color32::from_rgb(0x9a, 0x97, 0x90);
const ACCENT: Color32 = Color32::from_rgb(0x4c, 0x8d, 0xff);

struct Shared {
    profile: AtomicUsize,
    stop: AtomicBool,
    intervals_ms: Mutex<Vec<f32>>,
    step_us: Mutex<Vec<f32>>,
    resyncs: AtomicUsize,
    /// The lab plays the role of the UI Automation probe: "over the target".
    hover: Arc<Hover>,
}

fn engine_thread(shared: Arc<Shared>, profiles: Vec<CursorProfile>) {
    let mut current = shared.profile.load(Ordering::Relaxed);
    let mut engine = Engine::new(EngineConfig::with_profile(profiles[current].clone())).with_hover(shared.hover.clone());
    let mut last = Instant::now();
    let mut events = Vec::new();
    while !shared.stop.load(Ordering::Relaxed) {
        let want = shared.profile.load(Ordering::Relaxed);
        if want != current {
            current = want;
            engine.set_profile(profiles[current].clone());
        }
        let t0 = Instant::now();
        engine.step(&mut events);
        events.clear();
        let step = t0.elapsed();
        let interval = t0 - last;
        last = t0;
        if let (Ok(mut iv), Ok(mut st)) = (shared.intervals_ms.lock(), shared.step_us.lock()) {
            if iv.len() < 500_000 {
                iv.push(interval.as_secs_f32() * 1000.0);
                st.push(step.as_secs_f32() * 1_000_000.0);
            }
        }
        shared.resyncs.store(engine.inj.stats.resyncs as usize, Ordering::Relaxed);
        std::thread::sleep(TICK);
    }
}

/// Tiny xorshift RNG; the lab only needs shuffles and positions.
struct Rng(u64);

impl Rng {
    fn seeded() -> Self {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64;
        Self(t | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            v.swap(i, self.below(i + 1));
        }
    }
}

#[derive(Serialize, Clone)]
struct Trial {
    profile: String,
    warmup: bool,
    block: usize,
    distance: f32,
    width: f32,
    time_ms: f32,
    path: f32,
    misses: u32,
}

struct Target {
    center: Pos2,
    radius: f32,
}

enum Stage {
    Intro,
    Block { idx: usize, n: usize, target: Target, from: Pos2, t0: Instant, path: f32, last: Option<Pos2>, misses: u32 },
    Rate { idx: usize },
    Done { saved: Option<String> },
}

struct Lab {
    shared: Arc<Shared>,
    profiles: Vec<CursorProfile>,
    /// Profile index per block; the first `warmups` blocks are practice.
    order: Vec<usize>,
    warmups: usize,
    stage: Stage,
    trials: Vec<Trial>,
    ratings: Vec<(String, u8)>,
    rng: Rng,
    self_test_misses: usize,
}

impl Lab {
    fn new(shared: Arc<Shared>, profiles: Vec<CursorProfile>, self_test_misses: usize) -> Self {
        let mut rng = Rng::seeded();
        let mut order: Vec<usize> = (0..profiles.len()).collect();
        rng.shuffle(&mut order);
        let warmups = order.len();
        let first = rng.below(2);
        for round in 0..ROUNDS {
            let pair = if round % 2 == 0 { [first, 1 - first] } else { [1 - first, first] };
            order.extend(pair);
        }
        Self { shared, profiles, order, warmups, stage: Stage::Intro, trials: Vec::new(), ratings: Vec::new(), rng, self_test_misses }
    }

    fn new_target(&mut self, area: Rect, from: Pos2) -> Target {
        let radius = RADII[self.rng.below(RADII.len())];
        let inner = area.shrink(radius + 24.0);
        loop {
            let p = Pos2::new(
                inner.left() + self.rng.unit() * inner.width(),
                inner.top() + self.rng.unit() * inner.height(),
            );
            let d = p.distance(from);
            if (250.0..=900.0).contains(&d) {
                return Target { center: p, radius };
            }
        }
    }

    fn start_block(&mut self, idx: usize, area: Rect, from: Pos2) {
        self.shared.profile.store(self.order[idx], Ordering::Relaxed);
        let target = self.new_target(area, from);
        self.stage = Stage::Block { idx, n: 0, target, from, t0: Instant::now(), path: 0.0, last: Some(from), misses: 0 };
    }

    fn write_results(&self) -> Option<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("results");
        std::fs::create_dir_all(&dir).ok()?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        let path = dir.join(format!("{stamp}.json"));
        let intervals = self.shared.intervals_ms.lock().ok()?.clone();
        let steps = self.shared.step_us.lock().ok()?.clone();
        let doc = serde_json::json!({
            "profiles": self.profiles,
            "order": self.order.iter().map(|&i| &self.profiles[i].id).collect::<Vec<_>>(),
            "warmup_blocks": self.warmups,
            "trials": self.trials,
            "ratings": self.ratings,
            "summary": summary(&self.profiles, &self.trials, &self.ratings),
            "timing": {
                "interval_ms": percentiles(&intervals),
                "step_us": percentiles(&steps),
                "resyncs": self.shared.resyncs.load(Ordering::Relaxed),
                "self_test_misses": self.self_test_misses,
            },
            "screen_height_px": inject::primary_height(),
        });
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&doc).ok()?).ok()?;
        std::fs::rename(&tmp, &path).ok()?;
        Some(path.display().to_string())
    }
}

#[derive(Serialize)]
struct Row {
    profile: String,
    trials: usize,
    mean_ms: f32,
    throughput_bps: f32,
    miss_rate: f32,
    path_efficiency: f32,
    rating: f32,
}

fn summary(profiles: &[CursorProfile], trials: &[Trial], ratings: &[(String, u8)]) -> Vec<Row> {
    profiles
        .iter()
        .map(|p| {
            let t: Vec<&Trial> = trials.iter().filter(|t| t.profile == p.id && !t.warmup).collect();
            let n = t.len().max(1) as f32;
            let r: Vec<f32> = ratings.iter().filter(|r| r.0 == p.id).map(|r| r.1 as f32).collect();
            Row {
                profile: p.id.clone(),
                trials: t.len(),
                mean_ms: t.iter().map(|t| t.time_ms).sum::<f32>() / n,
                // Fitts (Shannon form): ID = log2(D / W + 1), W = target diameter.
                throughput_bps: t.iter().map(|t| (t.distance / t.width + 1.0).log2() / (t.time_ms / 1000.0)).sum::<f32>() / n,
                miss_rate: t.iter().map(|t| t.misses as f32).sum::<f32>() / n,
                path_efficiency: t.iter().map(|t| t.distance / t.path.max(t.distance)).sum::<f32>() / n,
                rating: r.iter().sum::<f32>() / r.len().max(1) as f32,
            }
        })
        .collect()
}

fn percentiles(v: &[f32]) -> serde_json::Value {
    if v.is_empty() {
        return serde_json::Value::Null;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f32| s[((s.len() - 1) as f32 * q) as usize];
    serde_json::json!({ "p50": at(0.5), "p95": at(0.95), "p99": at(0.99), "max": at(1.0), "n": s.len() })
}

/// Rounded button drawn by hand; returns true when clicked.
fn button(ui: &mut egui::Ui, rect: Rect, label: &str, primary: bool) -> bool {
    let resp = ui.allocate_rect(rect, egui::Sense::click());
    let fill = match (primary, resp.hovered()) {
        (true, false) => ACCENT,
        (true, true) => ACCENT.gamma_multiply(0.85),
        (false, false) => SURFACE,
        (false, true) => SURFACE_HOVER,
    };
    let p = ui.painter();
    p.rect_filled(rect, 10.0, fill);
    p.rect_stroke(rect, 10.0, Stroke::new(1.0, RING), egui::StrokeKind::Inside);
    p.text(rect.center(), Align2::CENTER_CENTER, label, FontId::proportional(22.0), TEXT);
    resp.clicked()
}

impl eframe::App for Lab {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        ctx.request_repaint();
        egui::CentralPanel::default().frame(egui::Frame::new().fill(BG)).show(ui, |ui| {
            let area = ui.max_rect();
            let (ptr, clicked) = ctx.input(|i| (i.pointer.latest_pos(), i.pointer.primary_pressed()));
            let total = self.order.len();

            // Thin progress line along the top.
            let done = match &self.stage {
                Stage::Intro => 0.0,
                Stage::Block { idx, n, .. } => (*idx as f32 + *n as f32 / if *idx < self.warmups { WARMUP_TARGETS } else { TARGETS_PER_BLOCK } as f32) / total as f32,
                Stage::Rate { idx } => (*idx + 1) as f32 / total as f32,
                Stage::Done { .. } => 1.0,
            };
            let bar = Rect::from_min_size(area.min, Vec2::new(area.width(), 3.0));
            ui.painter().rect_filled(bar, 0.0, SURFACE);
            ui.painter().rect_filled(Rect::from_min_size(bar.min, Vec2::new(bar.width() * done, 3.0)), 0.0, ACCENT);

            let painter = ui.painter().clone();
            match &mut self.stage {
                Stage::Intro => {
                    let c = area.center();
                    painter.text(c - Vec2::new(0.0, 150.0), Align2::CENTER_CENTER, "Laboratorio del cursor", FontId::proportional(40.0), TEXT);
                    painter.text(c - Vec2::new(0.0, 100.0), Align2::CENTER_CENTER,
                        format!("{} rondas de práctica y {} que cuentan. Stick izquierdo para mover, A para hacer clic, gatillo izquierdo para precisión.", self.warmups, total - self.warmups),
                        FontId::proportional(20.0), MUTED);
                    painter.circle_filled(c, 32.0, ACCENT);
                    painter.text(c + Vec2::new(0.0, 70.0), Align2::CENTER_CENTER, "Haz clic en el círculo para empezar", FontId::proportional(20.0), MUTED);
                    if self.self_test_misses > 0 {
                        painter.text(c + Vec2::new(0.0, 120.0), Align2::CENTER_CENTER,
                            format!("Aviso: el cursor no cayó exacto en {} de 4 puntos de prueba", self.self_test_misses),
                            FontId::proportional(18.0), Color32::from_rgb(0xe0, 0x6c, 0x5f));
                    }
                    if clicked && ptr.is_some_and(|p| p.distance(c) <= 32.0) {
                        self.start_block(0, area, c);
                    }
                }
                Stage::Block { idx, n, target, from, t0, path, last, misses } => {
                    self.shared.hover.set(ptr.is_some_and(|p| p.distance(target.center) <= target.radius));
                    if let (Some(p), Some(l)) = (ptr, *last) {
                        *path += p.distance(l);
                    }
                    *last = ptr;
                    painter.circle_filled(target.center, target.radius, ACCENT);
                    painter.circle_stroke(target.center, target.radius + 6.0, Stroke::new(1.5, RING));
                    if clicked {
                        let hit = ptr.is_some_and(|p| p.distance(target.center) <= target.radius);
                        if !hit {
                            *misses += 1;
                        } else {
                            let (idx, n, from, center) = (*idx, *n + 1, *from, target.center);
                            let warmup = idx < self.warmups;
                            self.trials.push(Trial {
                                profile: self.profiles[self.order[idx]].id.clone(),
                                warmup,
                                block: idx,
                                distance: from.distance(center),
                                width: target.radius * 2.0,
                                time_ms: t0.elapsed().as_secs_f32() * 1000.0,
                                path: *path,
                                misses: *misses,
                            });
                            let per_block = if warmup { WARMUP_TARGETS } else { TARGETS_PER_BLOCK };
                            if n >= per_block {
                                self.shared.hover.set(false);
                                if warmup {
                                    self.start_block(idx + 1, area, center);
                                } else {
                                    self.stage = Stage::Rate { idx };
                                }
                            } else {
                                let target = self.new_target(area, center);
                                self.stage = Stage::Block { idx, n, target, from: center, t0: Instant::now(), path: 0.0, last: ptr, misses: 0 };
                            }
                        }
                    }
                }
                Stage::Rate { idx } => {
                    let idx = *idx;
                    let c = area.center();
                    painter.text(c - Vec2::new(0.0, 90.0), Align2::CENTER_CENTER,
                        format!("¿Cómo se sintió el perfil {}?", self.order[idx] + 1), FontId::proportional(32.0), TEXT);
                    let w = 84.0;
                    let gap = 16.0;
                    let row = 5.0 * w + 4.0 * gap;
                    for i in 0..5u8 {
                        let r = Rect::from_min_size(Pos2::new(c.x - row / 2.0 + i as f32 * (w + gap), c.y - w / 2.0), Vec2::splat(w));
                        if button(ui, r, &(i + 1).to_string(), false) {
                            self.ratings.push((self.profiles[self.order[idx]].id.clone(), i + 1));
                            if idx + 1 >= self.order.len() {
                                self.shared.stop.store(true, Ordering::Relaxed);
                                let saved = self.write_results();
                                self.stage = Stage::Done { saved };
                            } else {
                                self.start_block(idx + 1, area, ptr.unwrap_or(c));
                            }
                        }
                    }
                    painter.text(Pos2::new(c.x - row / 2.0, c.y + w / 2.0 + 24.0), Align2::LEFT_CENTER, "Incómodo", FontId::proportional(16.0), MUTED);
                    painter.text(Pos2::new(c.x + row / 2.0, c.y + w / 2.0 + 24.0), Align2::RIGHT_CENTER, "Natural", FontId::proportional(16.0), MUTED);
                }
                Stage::Done { saved } => {
                    let rows = summary(&self.profiles, &self.trials, &self.ratings);
                    let mono = FontId::monospace(18.0);
                    let x0 = area.center().x - 420.0;
                    let mut y = area.center().y - 140.0;
                    painter.text(Pos2::new(x0, y - 50.0), Align2::LEFT_CENTER, "Resultados", FontId::proportional(32.0), TEXT);
                    let head = format!("{:<12}{:>10}{:>12}{:>10}{:>12}{:>10}", "Perfil", "Tiempo", "Bits/s", "Fallos", "Ruta", "Nota");
                    painter.text(Pos2::new(x0, y), Align2::LEFT_CENTER, head, mono.clone(), MUTED);
                    for (i, r) in rows.iter().enumerate() {
                        y += 34.0;
                        let line = format!("{:<12}{:>8.0}ms{:>12.2}{:>10.2}{:>11.0}%{:>10.1}",
                            format!("{} {}", i + 1, r.profile), r.mean_ms, r.throughput_bps, r.miss_rate, r.path_efficiency * 100.0, r.rating);
                        painter.text(Pos2::new(x0, y), Align2::LEFT_CENTER, line, mono.clone(), TEXT);
                    }
                    let msg = match saved {
                        Some(p) => format!("Guardado en {p}"),
                        None => "No se pudo guardar el resultado".into(),
                    };
                    painter.text(Pos2::new(x0, y + 60.0), Align2::LEFT_CENTER, msg, FontId::proportional(16.0), MUTED);
                }
            }
        });
    }
}

fn main() -> eframe::Result {
    let profiles: Vec<CursorProfile> = COMPARE.iter().map(|id| profile(id).expect("built-in profile")).collect();
    let self_test_misses = inject::self_test();
    let shared = Arc::new(Shared {
        profile: AtomicUsize::new(0),
        stop: AtomicBool::new(false),
        intervals_ms: Mutex::new(Vec::new()),
        step_us: Mutex::new(Vec::new()),
        resyncs: AtomicUsize::new(0),
        hover: Hover::new(),
    });
    {
        let (shared, profiles) = (shared.clone(), profiles.clone());
        std::thread::spawn(move || engine_thread(shared, profiles));
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("Laboratorio del cursor").with_maximized(true),
        ..Default::default()
    };
    eframe::run_native("cursor-lab", options, Box::new(move |_cc| Ok(Box::new(Lab::new(shared, profiles, self_test_misses)))))
}
