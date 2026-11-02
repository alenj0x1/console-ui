//! What is playing, from Windows' media controls (the same ones the volume
//! flyout shows): Spotify, browsers, any player that reports itself. No
//! account or API key needed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

const POLL: Duration = Duration::from_secs(1);
const MAX_COVER: u64 = 4 * 1024 * 1024;

pub static MEDIA: LazyLock<Media> = LazyLock::new(Media::default);

#[derive(Clone, Default, PartialEq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// AppUserModelID of the player (e.g. "Spotify.exe", "Chrome").
    pub source: String,
    /// Changes whenever the cover changes, so the page can reload it.
    pub cover: u32,
    /// Track position when the player last reported it, and the track length.
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Unix time (ms) of that report: the page advances the bar from it.
    pub sampled_ms: u64,
}

#[derive(Default)]
pub struct Media {
    pub now: Mutex<NowPlaying>,
    pub cover: Mutex<Option<Vec<u8>>>,
    manager: Mutex<Option<Manager>>,
    started: AtomicBool,
}

impl Media {
    /// Polls once a second on its own thread and emits "media" on changes.
    pub fn start(app: AppHandle) {
        let media: &'static Media = &MEDIA;
        if media.started.swap(true, Ordering::Relaxed) {
            return;
        }
        let _ = std::thread::Builder::new().name("media".into()).spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let mut revision = 0;
            loop {
                let (next, cover) = media.read().unwrap_or_default();
                let changed = {
                    let mut now = media.now.lock().unwrap();
                    let track_changed = (now.title.as_str(), now.artist.as_str()) != (next.title.as_str(), next.artist.as_str());
                    // Players often send the cover a moment after the title:
                    // a late cover counts as a new one.
                    let late_cover = !track_changed && cover.is_some() && media.cover.lock().unwrap().is_none();
                    if track_changed || late_cover {
                        revision += 1;
                        *media.cover.lock().unwrap() = cover;
                    }
                    let next = NowPlaying { cover: revision, ..next };
                    let changed = *now != next;
                    *now = next;
                    changed
                };
                if changed {
                    let _ = app.emit("media", media.now.lock().unwrap().clone());
                }
                std::thread::sleep(POLL);
            }
        });
    }

    fn manager(&self) -> windows::core::Result<Manager> {
        let mut m = self.manager.lock().unwrap();
        if m.is_none() {
            *m = Some(Manager::RequestAsync()?.join()?);
        }
        Ok(m.clone().unwrap())
    }

    fn read(&self) -> windows::core::Result<(NowPlaying, Option<Vec<u8>>)> {
        let Ok(session) = self.manager()?.GetCurrentSession() else {
            return Ok(Default::default());
        };
        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
        let now = NowPlaying {
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            playing,
            source: session.SourceAppUserModelId()?.to_string(),
            cover: 0,
            position_ms: 0,
            duration_ms: 0,
            sampled_ms: 0,
        };
        let now = match session.GetTimelineProperties() {
            Ok(t) => {
                // TimeSpan is in 100 ns units; DateTime counts 100 ns since 1601.
                let ms = |d: i64| (d.max(0) / 10_000) as u64;
                let end = t.EndTime().map(|d| d.Duration).unwrap_or(0) - t.StartTime().map(|d| d.Duration).unwrap_or(0);
                let sampled = t.LastUpdatedTime().map(|d| d.UniversalTime).unwrap_or(0) - 116_444_736_000_000_000;
                NowPlaying { position_ms: ms(t.Position().map(|d| d.Duration).unwrap_or(0)), duration_ms: ms(end), sampled_ms: ms(sampled), ..now }
            }
            Err(_) => now,
        };
        let cover = props.Thumbnail().ok().and_then(|t| {
            let stream = t.OpenReadAsync().ok()?.join().ok()?;
            let size = stream.Size().ok()?;
            if size == 0 || size > MAX_COVER {
                return None;
            }
            let reader = DataReader::CreateDataReader(&stream).ok()?;
            reader.LoadAsync(size as u32).ok()?.join().ok()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf).ok()?;
            Some(buf)
        });
        Ok((now, cover))
    }

    /// Call from a thread with COM initialized (see `control_blocking`).
    fn control(&self, action: &str) -> Result<(), String> {
        let session = self.manager().and_then(|m| m.GetCurrentSession()).map_err(|_| "no hay música sonando".to_string())?;
        let op = match action {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "prev" => session.TrySkipPreviousAsync(),
            _ => return Err(format!("acción desconocida: {action}")),
        };
        op.and_then(|o| o.join()).map(|_| ()).map_err(|e| e.message())
    }
}

/// Play/pause, next or previous on the current player, from any thread.
pub fn control_blocking(action: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    MEDIA.control(action)
}

#[cfg(test)]
mod tests {
    /// Saves what is playing right now and its cover to the temp folder.
    #[test]
    #[ignore = "reads this PC's player"]
    fn current_cover() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        let (now, cover) = super::MEDIA.read().unwrap();
        println!("{} | {} | {}", now.source, now.title, now.artist);
        let cover = cover.expect("no cover");
        let file = std::env::temp_dir().join("console-ui-cover.bin");
        std::fs::write(&file, &cover).unwrap();
        println!("{} bytes -> {}", cover.len(), file.display());
    }
}
