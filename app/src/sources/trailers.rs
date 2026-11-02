//! Trailers for Steam games, from the Steam store: the first seconds of the
//! game's main trailer, saved once in the app data folder and played in a
//! loop behind the home screen. The video is one MP4; its sound is a separate
//! M4A that the page plays alongside only when the user wants sound.
//!
//! The store gives trailers as MPEG-DASH: an init segment plus 3-second
//! fragments. Joining the init with the first fragments is a valid
//! fragmented MP4 that the page plays directly. Only Steam's own hosts are
//! contacted, over HTTPS, with size and time limits.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

const STORE: &str = "https://store.steampowered.com/api/appdetails?filters=movies&appids=";
/// Trailers come from Steam's video CDN only.
const VIDEO_HOSTS: [&str; 2] = ["https://video.akamai.steamstatic.com/", "https://video.fastly.steamstatic.com/"];
/// About 24 seconds: enough for a loop, small on disk (~15 MB at 1080p).
const FRAGMENTS: u32 = 8;
const MAX_HEIGHT: u32 = 1080;
const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_FRAGMENT: u64 = 8 * 1024 * 1024;
/// Old trailers are deleted once the folder grows past this.
const MAX_CACHE: u64 = 600 * 1024 * 1024;
/// Marks a game without a usable trailer (or without sound), so the store is
/// not asked again.
const NONE: &str = "none";
const NO_SOUND: &str = "nosound";

#[derive(Deserialize)]
struct Movie {
    #[serde(default)]
    dash_h264: String,
    #[serde(default)]
    highlight: bool,
}

pub struct Trailers {
    dir: PathBuf,
    agent: ureq::Agent,
    /// Sounds that failed to download in this run (a network error is not
    /// saved, so they are tried again on the next start).
    failed: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl Trailers {
    pub fn new(dir: PathBuf) -> Self {
        // No redirects: every request must stay on the Steam hosts checked above.
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).max_redirects(0).build().into();
        Self { dir, agent, failed: Default::default() }
    }

    fn file(&self, appid: &str) -> PathBuf {
        self.dir.join(format!("{appid}.mp4"))
    }

    /// The saved trailer of a Steam game id ("steam:<appid>"), if there is one.
    pub fn cached(&self, game: &str) -> Option<PathBuf> {
        let file = self.file(appid(game)?);
        file.is_file().then_some(file)
    }

    /// The saved sound of a game's trailer, if there is one.
    pub fn cached_sound(&self, game: &str) -> Option<PathBuf> {
        let file = self.dir.join(format!("{}.m4a", appid(game)?));
        file.is_file().then_some(file)
    }

    /// Whether the trailer's sound was already looked for (or failed in this run).
    pub fn sound_known(&self, game: &str) -> bool {
        appid(game).is_some_and(|a| {
            self.dir.join(format!("{a}.m4a")).is_file() || self.dir.join(format!("{a}.{NO_SOUND}")).is_file() || self.failed.lock().unwrap().contains(a)
        })
    }

    /// Whether the store was already asked about this game.
    pub fn known(&self, game: &str) -> bool {
        appid(game).is_some_and(|a| self.file(a).is_file() || self.dir.join(format!("{a}.{NONE}")).is_file())
    }

    /// Downloads the trailer (blocking). Ok(None) = the game has none.
    pub fn fetch(&self, game: &str) -> Result<Option<PathBuf>, String> {
        let appid = appid(game).ok_or("no es un juego de Steam")?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let Some(mpd) = self.trailer_manifest(appid)? else {
            let _ = std::fs::write(self.dir.join(format!("{appid}.{NONE}")), b"");
            return Ok(None);
        };
        let text = self.get(&mpd, MAX_JSON)?;
        let text = String::from_utf8_lossy(&text);
        let rep = representation(&text, "video").ok_or("tráiler sin video H.264")?;
        let file = self.file(appid);
        self.save(&mpd, &rep, &file)?;
        // The sound comes along; without it the trailer still plays silent.
        if let Some(sound) = representation(&text, "audio") {
            self.save_sound(appid, &mpd, &sound);
        }
        self.trim();
        Ok(Some(file))
    }

    /// Downloads only the sound of a trailer saved before sound was kept
    /// (blocking). Ok(None) = the trailer has none.
    pub fn fetch_sound(&self, game: &str) -> Result<Option<PathBuf>, String> {
        let appid = appid(game).ok_or("no es un juego de Steam")?;
        let sound = (|| {
            let Some(mpd) = self.trailer_manifest(appid)? else { return Ok(None) };
            let text = self.get(&mpd, MAX_JSON)?;
            Ok(representation(&String::from_utf8_lossy(&text), "audio").map(|r| (mpd, r)))
        })();
        let file = match sound {
            Ok(Some((mpd, rep))) => self.save_sound(appid, &mpd, &rep),
            Ok(None) => {
                let _ = std::fs::write(self.dir.join(format!("{appid}.{NO_SOUND}")), b"");
                None
            }
            Err(e) => {
                self.failed.lock().unwrap().insert(appid.to_owned());
                return Err(e);
            }
        };
        self.trim();
        Ok(file)
    }

    /// Only a missing sound is saved as such; a failed download is retried
    /// on the next start.
    fn save_sound(&self, appid: &str, mpd: &str, rep: &Representation) -> Option<PathBuf> {
        let file = self.dir.join(format!("{appid}.m4a"));
        match self.save(mpd, rep, &file) {
            Ok(()) => Some(file),
            Err(_) => {
                self.failed.lock().unwrap().insert(appid.to_owned());
                None
            }
        }
    }

    /// Joins a representation's init segment and first fragments into `file`.
    fn save(&self, mpd: &str, rep: &Representation, file: &Path) -> Result<(), String> {
        let base = &mpd[..mpd.rfind('/').ok_or("dirección inválida")? + 1];
        let mut out = self.get(&format!("{base}{}", rep.init), MAX_FRAGMENT)?;
        for n in rep.start..rep.start.saturating_add(FRAGMENTS) {
            match self.get(&format!("{base}{}", rep.fragment(n)), MAX_FRAGMENT) {
                Ok(b) => out.extend(b),
                // Shorter trailers simply end sooner.
                Err(_) if n > rep.start => break,
                Err(e) => return Err(e),
            }
        }
        // Each file has its own partial name: the video and its sound may be
        // saved at the same time.
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let tmp = file.with_extension(format!("{ext}.part"));
        std::fs::write(&tmp, &out).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| e.to_string())
    }

    /// The highlighted trailer's DASH manifest, if the store lists one.
    fn trailer_manifest(&self, appid: &str) -> Result<Option<String>, String> {
        let body = self.get(&format!("{STORE}{appid}"), MAX_JSON)?;
        let json: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let movies: Vec<Movie> = serde_json::from_value(json[appid]["data"]["movies"].clone()).unwrap_or_default();
        let pick = movies.iter().find(|m| m.highlight).or(movies.first());
        Ok(pick.map(|m| m.dash_h264.clone()).filter(|u| VIDEO_HOSTS.iter().any(|h| u.starts_with(h)) && !u.contains("..")))
    }

    fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, String> {
        let allowed = url.starts_with(STORE) || VIDEO_HOSTS.iter().any(|h| url.starts_with(h));
        if !allowed {
            return Err("dirección no permitida".into());
        }
        let mut res = self.agent.get(url).call().map_err(|e| e.to_string())?;
        res.body_mut().with_config().limit(limit).read_to_vec().map_err(|e| e.to_string())
    }

    /// Deletes the oldest trailers, each with its sound, while the folder is
    /// over its limit.
    fn trim(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let mut trailers: Vec<_> = rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
            .filter_map(|e| {
                let video = e.path();
                let sound = video.with_extension("m4a");
                Some((e.metadata().ok()?.modified().ok()?, size(&video) + size(&sound), video, sound))
            })
            .collect();
        trailers.sort_by_key(|t| t.0);
        let mut total: u64 = trailers.iter().map(|t| t.1).sum();
        for (_, len, video, sound) in trailers {
            if total <= MAX_CACHE {
                break;
            }
            if std::fs::remove_file(&video).is_ok() {
                let _ = std::fs::remove_file(&sound);
                total -= len;
            }
        }
    }
}

fn appid(game: &str) -> Option<&str> {
    game.strip_prefix("steam:").filter(|a| !a.is_empty() && a.len() < 12 && a.chars().all(|c| c.is_ascii_digit()))
}

struct Representation {
    init: String,
    media: String,
    id: String,
    start: u32,
}

impl Representation {
    fn fragment(&self, n: u32) -> String {
        // "$Number%05d$" → zero-padded to 5 digits.
        self.media.replace("$RepresentationID$", &self.id).replace("$Number%05d$", &format!("{n:05}")).replace("$Number$", &n.to_string())
    }
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    tag[at..].split('"').next()
}

/// A representation of `kind` ("video" or "audio") with its segment
/// template: the tallest video up to 1080p, or the first sound.
fn representation(mpd: &str, kind: &str) -> Option<Representation> {
    let set = mpd.split("<AdaptationSet").find(|s| s.contains(&format!("contentType=\"{kind}\"")))?;
    let mut best: Option<(u32, Representation)> = None;
    for part in set.split("<Representation").skip(1) {
        let tag = &part[..part.find('>')?];
        let height: u32 = if kind == "video" { attr(tag, "height")?.parse().ok()? } else { 0 };
        let tpl = &part[part.find("<SegmentTemplate")?..];
        let tpl = &tpl[..tpl.find('>')?];
        let rep = Representation {
            init: attr(tpl, "initialization")?.to_owned(),
            media: attr(tpl, "media")?.to_owned(),
            id: attr(tag, "id")?.to_owned(),
            start: attr(tpl, "startNumber").and_then(|s| s.parse().ok()).unwrap_or(1),
        };
        let plain_id = !rep.id.is_empty() && rep.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !plain_id || rep.init.contains("..") || rep.media.contains("..") || rep.init.contains("://") || rep.media.contains("://") {
            continue;
        }
        let init = rep.init.replace("$RepresentationID$", &rep.id);
        let rep = Representation { init, ..rep };
        if height <= MAX_HEIGHT && best.as_ref().is_none_or(|(h, _)| height > *h) {
            best = Some((height, rep));
        }
        // Any sound will do: the first one.
        if kind == "audio" && best.is_some() {
            break;
        }
    }
    best.map(|(_, r)| r)
}

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("trailers")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MPD: &str = r#"<AdaptationSet id="0" contentType="video">
<Representation id="0" mimeType="video/mp4" width="1920" height="1080"><SegmentTemplate timescale="1000000" duration="3000000" initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"></SegmentTemplate></Representation>
<Representation id="1" mimeType="video/mp4" width="1280" height="720"><SegmentTemplate initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"></SegmentTemplate></Representation>
</AdaptationSet><AdaptationSet id="1" contentType="audio"><Representation id="4" mimeType="audio/mp4"><SegmentTemplate initialization="dash_h264/init-stream$RepresentationID$.m4s" media="dash_h264/chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"></SegmentTemplate></Representation></AdaptationSet>"#;

    #[test]
    fn picks_1080p_video() {
        let r = representation(MPD, "video").unwrap();
        assert_eq!(r.init, "dash_h264/init-stream0.m4s");
        assert_eq!(r.fragment(3), "dash_h264/chunk-stream0-00003.m4s");
    }

    #[test]
    fn picks_the_sound() {
        let r = representation(MPD, "audio").unwrap();
        assert_eq!(r.init, "dash_h264/init-stream4.m4s");
        assert_eq!(r.fragment(1), "dash_h264/chunk-stream4-00001.m4s");
    }

    #[test]
    fn only_steam_ids() {
        assert_eq!(appid("steam:367520"), Some("367520"));
        assert_eq!(appid("steam:../x"), None);
        assert_eq!(appid("epic:Fortnite"), None);
    }

    #[test]
    #[ignore = "downloads from the Steam store"]
    fn downloads_one() {
        let t = Trailers::new(std::env::temp_dir().join("console-ui-trailers"));
        let file = t.fetch("steam:367520").unwrap().unwrap();
        let len = std::fs::metadata(&file).unwrap().len();
        println!("{} ({} MB)", file.display(), len / 1024 / 1024);
        assert!(len > 1024 * 1024);
    }
}
