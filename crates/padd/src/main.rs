//! Background daemon: drives the desktop with the controller.
//! For now it runs in a console; the Tauri app will host it later.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use padcore::{Engine, EngineConfig, Event, Hover, Mode, builtin_profiles, hover};

/// 250 Hz while the controller is in use.
const ACTIVE_TICK: Duration = Duration::from_millis(4);
/// 60 Hz after a few seconds without input.
const IDLE_TICK: Duration = Duration::from_millis(16);
const IDLE_AFTER: Duration = Duration::from_secs(3);
/// No controller: check for one twice a second.
const NO_PAD_TICK: Duration = Duration::from_millis(500);

fn main() {
    let profile_id = std::env::args().nth(1).unwrap_or_else(|| "asistido".into());
    let profile = builtin_profiles()
        .into_iter()
        .find(|p| p.id == profile_id)
        .unwrap_or_else(|| {
            eprintln!("Perfil desconocido «{profile_id}». Disponibles: lineal, curva, curva-turbo, asistido");
            std::process::exit(2);
        });

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc::set_handler(move || stop.store(true, Ordering::SeqCst)).expect("Ctrl+C handler");
    }

    let hover_state = Hover::new();
    let probe = profile.assist.is_some().then(|| hover::spawn_probe(hover_state.clone(), stop.clone()));
    let mut engine = Engine::new(EngineConfig::with_profile(profile)).with_hover(hover_state);
    println!("Perfil: {}. Mantén View + Menu para activar o desactivar el cursor.", engine.profile().id);

    let mut events = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        engine.step(&mut events);
        for e in events.drain(..) {
            match e {
                Event::Connected(slot) => println!("Control conectado (ranura {slot})"),
                Event::Disconnected => println!("Control desconectado"),
                Event::ModeChanged(Mode::Off) => println!("Cursor desactivado: el control queda libre para juegos"),
                Event::ModeChanged(_) => println!("Cursor activado"),
                Event::Ui(_) | Event::Rescue => {}
            }
        }
        let tick = if !engine.connected() {
            NO_PAD_TICK
        } else if engine.idle_for() > IDLE_AFTER {
            IDLE_TICK
        } else {
            ACTIVE_TICK
        };
        std::thread::sleep(tick);
    }
    if let Some(p) = probe {
        let _ = p.join();
    }
    let s = engine.inj.stats;
    println!("Cerrando. Movimientos: {}, resincronizaciones: {}", s.moves, s.resyncs);
}
