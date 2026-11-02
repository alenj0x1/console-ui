//! Silent trailers for Steam games, from the Steam store: the first seconds of
//! the game's main trailer, video only, saved once as a single MP4 in the app
//! data folder and played in a loop behind the home screen.
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
/// Marks a game without a usable trailer, so the store is not asked again.
const NONE: &str = "none";

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
}

impl Trailers {
    pub fn new(dir: PathBuf) -> Self {
        // No redirects: every request must stay on the Steam hosts checked above.
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).max_redirects(0).build().into();
        Self { dir, agent }
    }

    fn file(&self, appid: &str) -> PathBuf {
        self.dir.join(format!("{appid}.mp4"))
    }

    /// The saved trailer of a Steam game id ("steam:<appid>"), if there is one.
    pub fn cached(&self, game: &str) -> Option<PathBuf> {
        let file = self.file(appid(game)?);
        file.is_file().then_some(file)
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
        let rep = representation(&text).ok_or("tráiler sin video H.264")?;
        let base = &mpd[..mpd.rfind('/').ok_or("dirección inválida")? + 1];
        let mut out = self.get(&format!("{base}{}", rep.init), MAX_FRAGMENT)?;
        for n in rep.start..rep.start + FRAGMENTS {
            match self.get(&format!("{base}{}", rep.fragment(n)), MAX_FRAGMENT) {
                Ok(b) => out.extend(b),
                // Shorter trailers simply end sooner.
                Err(_) if n > rep.start => break,
                Err(e) => return Err(e),
            }
        }
        let file = self.file(appid);
        let tmp = file.with_extension("part");
        std::fs::write(&tmp, &out).and_then(|_| std::fs::rename(&tmp, &file)).map_err(|e| e.to_string())?;
        self.trim();
        Ok(Some(file))
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

    /// Deletes the oldest trailers while the folder is over its limit.
    fn trim(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<_> = rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.metadata().ok()?.len(), e.path())))
            .collect();
        files.sort_by_key(|f| f.0);
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        for (_, len, path) in files {
            if total <= MAX_CACHE {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
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

/// The tallest video representation up to 1080p, with its segment template.
fn representation(mpd: &str) -> Option<Representation> {
    let video = mpd.split("<AdaptationSet").find(|s| s.contains("contentType=\"video\""))?;
    let mut best: Option<(u32, Representation)> = None;
    for part in video.split("<Representation").skip(1) {
        let tag = &part[..part.find('>')?];
        let height: u32 = attr(tag, "height")?.parse().ok()?;
        let tpl = &part[part.find("<SegmentTemplate")?..];
        let tpl = &tpl[..tpl.find('>')?];
        let rep = Representation {
            init: attr(tpl, "initialization")?.to_owned(),
            media: attr(tpl, "media")?.to_owned(),
            id: attr(tag, "id")?.to_owned(),
            start: attr(tpl, "startNumber").and_then(|s| s.parse().ok()).unwrap_or(1),
        };
        if rep.init.contains("..") || rep.media.contains("..") || rep.init.contains("://") || rep.media.contains("://") {
            continue;
        }
        let init = rep.init.replace("$RepresentationID$", &rep.id);
        let rep = Representation { init, ..rep };
        if height <= MAX_HEIGHT && best.as_ref().is_none_or(|(h, _)| height > *h) {
            best = Some((height, rep));
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
</AdaptationSet><AdaptationSet id="1" contentType="audio"><Representation id="4" height="9999"></Representation></AdaptationSet>"#;

    #[test]
    fn picks_1080p_video() {
        let r = representation(MPD).unwrap();
        assert_eq!(r.init, "dash_h264/init-stream0.m4s");
        assert_eq!(r.fragment(3), "dash_h264/chunk-stream0-00003.m4s");
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
