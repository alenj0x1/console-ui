//! System volume of the default output device (Core Audio), so the home
//! screen can show and change it itself instead of Windows' volume flyout.

use serde::Serialize;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};

#[derive(Clone, Copy, Serialize)]
pub struct Volume {
    /// 0.0 – 1.0
    pub level: f32,
    pub muted: bool,
}

fn with_endpoint<T>(f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<T>) -> Result<T, String> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r = (|| {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let endpoint: IAudioEndpointVolume = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
            f(&endpoint)
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        r.map_err(|e| e.message())
    }
}

fn read(v: &IAudioEndpointVolume) -> windows::core::Result<Volume> {
    unsafe { Ok(Volume { level: v.GetMasterVolumeLevelScalar()?, muted: v.GetMute()?.as_bool() }) }
}

pub fn get() -> Result<Volume, String> {
    with_endpoint(read)
}

/// Changes the level by `delta` (unmuting when going up).
pub fn step(delta: f32) -> Result<Volume, String> {
    with_endpoint(|v| unsafe {
        let level = (v.GetMasterVolumeLevelScalar()? + delta).clamp(0.0, 1.0);
        v.SetMasterVolumeLevelScalar(level, std::ptr::null())?;
        if delta > 0.0 {
            v.SetMute(false, std::ptr::null())?;
        }
        read(v)
    })
}

pub fn toggle_mute() -> Result<Volume, String> {
    with_endpoint(|v| unsafe {
        v.SetMute(!v.GetMute()?.as_bool(), std::ptr::null())?;
        read(v)
    })
}

#[cfg(test)]
mod tests {
    /// Reads this PC's volume without changing it.
    #[test]
    fn reads_volume() {
        let v = super::get().unwrap();
        assert!((0.0..=1.0).contains(&v.level));
    }
}
