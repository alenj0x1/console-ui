//! Asks UI Automation what is clickable at a few screen points and times it.
use std::time::Instant;

use padcore::hover::UiaProbe;
use padcore::inject;

fn main() {
    let probe = UiaProbe::new().expect("UI Automation");
    let (w, h) = inject::primary_size();
    let points = [(24, h - 20), (w / 2, h / 2), (w - 60, h - 20), inject::cursor_pos()];
    for p in points {
        let t = Instant::now();
        let hit = probe.clickable_at(p);
        println!("{p:?}: clicable={hit} ({:.1} ms)", t.elapsed().as_secs_f64() * 1000.0);
    }
    let t = Instant::now();
    for _ in 0..100 {
        probe.clickable_at(points[1]);
    }
    println!("100 consultas: {:.1} ms en promedio", t.elapsed().as_secs_f64() * 10.0);
    let t = Instant::now();
    println!("foco en contraseña: {} ({:.1} ms)", padcore::hover::focused_is_password(), t.elapsed().as_secs_f64() * 1000.0);
}

