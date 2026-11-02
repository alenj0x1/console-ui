//! Core of the controller-driven Windows shell: gamepad input, stick curves,
//! input injection and the mode engine. Windows only.

pub mod curve;
pub mod engine;
pub mod hover;
pub mod inject;
pub mod pad;
pub mod ui;
pub mod xinput;

pub use curve::{CursorProfile, builtin_profiles, profile};
pub use hover::Hover;
pub use engine::{Engine, EngineConfig, Event, Mode, Tuning};
pub use pad::PadState;
pub use ui::UiEvent;
