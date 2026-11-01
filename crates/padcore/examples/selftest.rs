//! Checks absolute positioning and sub-pixel accumulation on this machine.
//! Moves the real cursor briefly and puts it back.
use std::time::Duration;

use padcore::inject::{self, Injector};

fn main() {
    println!("puntos fallidos: {} de 4", inject::self_test());

    let start = inject::cursor_pos();
    let mut inj = Injector::new();
    for _ in 0..50 {
        inj.move_by(0.4, 0.25);
        std::thread::sleep(Duration::from_millis(4));
    }
    std::thread::sleep(Duration::from_millis(30));
    let end = inject::cursor_pos();
    println!("subpíxel: esperado +20,+12 (±1), obtenido +{},+{}; resincronizaciones: {}",
        end.0 - start.0, end.1 - start.1, inj.stats.resyncs);
    inj.move_by((start.0 - end.0) as f64, (start.1 - end.1) as f64);
}
