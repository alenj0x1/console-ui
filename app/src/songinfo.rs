//! A song's cover in high resolution and its lyrics, looked up on the
//! internet by title and artist (Windows only gives a small cover and no
//! lyrics). Only while "music_online" is on.
//!
//! - Covers: Deezer's search first, then Apple's (iTunes); both are free and
//!   need no account. Saved in the app data folder, so each is fetched once.
//! - Lyrics: LRCLIB, synced line by line when it has them. Kept in memory
//!   only, never written to disk.
//!
//! Only these hosts are contacted, over HTTPS, without redirects and with
//! size limits; a result is used only when its title and artist match.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;

const DEEZER: &str = "https://api.deezer.com/search";
const ITUNES: &str = "https://itunes.apple.com/search";
const LRCLIB: &str = "https://lrclib.net/api/search";
/// Covers come from these image hosts only.
const IMAGE_HOSTS: [&str; 2] = [".dzcdn.net", ".mzstatic.com"];
const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 6 * 1024 * 1024;
/// Saved covers kept; the oldest go first.
const MAX_COVERS: usize = 400;
/// Songs whose lyrics are remembered while the app runs.
const MAX_LYRICS: usize = 64;
/// A synced result counts only if its length is this close to the track's.
const DURATION_SLACK_MS: u64 = 4000;
const AGENT_NAME: &str = concat!("console-ui/", env!("CARGO_PKG_VERSION"));

static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .max_redirects(0)
        .user_agent(AGENT_NAME)
        .build()
        .into()
});

fn get(url: &str, query: &[(&str, &str)], limit: u64) -> Result<Vec<u8>, String> {
    let mut req = AGENT.get(url);
    for (k, v) in query {
        req = req.query(*k, *v);
    }
    let mut res = req.call().map_err(|e| e.to_string())?;
    res.body_mut().with_config().limit(limit).read_to_vec().map_err(|e| e.to_string())
}

fn json(url: &str, query: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&get(url, query, MAX_JSON)?).map_err(|e| e.to_string())
}

/// Lower case, letters and digits only, without what usually varies between
/// services: "(feat. …)", "[Remastered]", " - Live", "feat. …".
fn simplify(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in s.to_lowercase().chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth as i32 - 1).max(0) as usize,
            _ if depth > 0 => {}
            _ => out.push(c),
        }
    }
    let cut = [" - ", " feat. ", " feat ", " ft. ", " with "].iter().filter_map(|m| out.find(m)).min();
    if let Some(at) = cut {
        out.truncate(at);
    }
    out.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// The first artist of a list ("A, B", "A & B", "A feat. B").
fn first_artist(s: &str) -> String {
    let s = s.to_lowercase();
    let end = [",", " & ", " x ", " feat", " ft.", ";", "/"].iter().filter_map(|m| s.find(m)).min().unwrap_or(s.len());
    simplify(&s[..end])
}

fn same_song(title: &str, artist: &str, their_title: &str, their_artist: &str) -> bool {
    let (a, b) = (first_artist(artist), simplify(their_artist));
    let artist_ok = !a.is_empty() && (b.contains(&a) || a.contains(&b) && !b.is_empty());
    let title_ok = { let (t, u) = (simplify(title), simplify(their_title)); !t.is_empty() && t == u };
    artist_ok && title_ok
}

// ---------- covers ----------

fn key(title: &str, artist: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{}|{}", first_artist(artist), simplify(title)).bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn cover_dir(app_data: &Path) -> PathBuf {
    app_data.join("covers")
}

/// The song's cover in high resolution (blocking), from the folder or the
/// internet. None when no service has a matching one.
pub fn cover(dir: &Path, title: &str, artist: &str) -> Option<Vec<u8>> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return None;
    }
    let key = key(title, artist);
    let file = dir.join(format!("{key}.jpg"));
    if let Ok(b) = std::fs::read(&file) {
        return Some(b);
    }
    // Remembered misses: not asked again in this run.
    static MISSES: LazyLock<Mutex<std::collections::HashSet<String>>> = LazyLock::new(Default::default);
    if MISSES.lock().unwrap().contains(&key) {
        return None;
    }
    let url = deezer_cover(title, artist).or_else(|| itunes_cover(title, artist));
    let Some(bytes) = url.and_then(|u| image(&u)) else {
        MISSES.lock().unwrap().insert(key);
        return None;
    };
    let _ = std::fs::create_dir_all(dir);
    let tmp = file.with_extension("jpg.part");
    if std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, &file)).is_ok() {
        trim(dir);
    }
    Some(bytes)
}

fn deezer_cover(title: &str, artist: &str) -> Option<String> {
    let q = format!("artist:\"{}\" track:\"{}\"", artist.replace('"', ""), title.replace('"', ""));
    let res = json(DEEZER, &[("q", &q), ("limit", "10")]).ok()?;
    res["data"].as_array()?.iter().find_map(|t| {
        let ok = same_song(title, artist, t["title"].as_str()?, t["artist"]["name"].as_str()?);
        ok.then(|| t["album"]["cover_xl"].as_str().map(str::to_owned)).flatten()
    })
}

fn itunes_cover(title: &str, artist: &str) -> Option<String> {
    let term = format!("{artist} {title}");
    let res = json(ITUNES, &[("term", &term), ("media", "music"), ("entity", "song"), ("limit", "10")]).ok()?;
    res["results"].as_array()?.iter().find_map(|t| {
        let ok = same_song(title, artist, t["trackName"].as_str()?, t["artistName"].as_str()?);
        // Apple names the size in the address: ask for 1000 px.
        ok.then(|| t["artworkUrl100"].as_str().map(|u| u.replace("100x100bb", "1000x1000bb"))).flatten()
    })
}

fn image(url: &str) -> Option<Vec<u8>> {
    let host = url.strip_prefix("https://")?.split('/').next()?;
    if host.contains('@') || host.contains(':') || !IMAGE_HOSTS.iter().any(|h| host.ends_with(h)) {
        return None;
    }
    let bytes = get(url, &[], MAX_IMAGE).ok()?;
    // JPEG or PNG only.
    (bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(b"\x89PNG")).then_some(bytes)
}

fn trim(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= MAX_COVERS {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, p) in &files[..files.len() - MAX_COVERS] {
        let _ = std::fs::remove_file(p);
    }
}

// ---------- lyrics ----------

#[derive(Clone, Serialize)]
pub struct Line {
    /// When the line starts, from the start of the track.
    pub ms: u64,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct Lyrics {
    /// The song they belong to (the page checks it is still playing).
    pub title: String,
    pub artist: String,
    /// Synced lines; empty when only plain text is known.
    pub lines: Vec<Line>,
    pub plain: Vec<String>,
    pub instrumental: bool,
}

static LYRICS: LazyLock<Mutex<HashMap<String, Option<Lyrics>>>> = LazyLock::new(Default::default);

/// The song's lyrics (blocking). Ok(None) = LRCLIB has none for it; a
/// network error is not remembered, so it is tried again.
pub fn lyrics(title: &str, artist: &str, duration_ms: u64) -> Result<Option<Lyrics>, String> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return Ok(None);
    }
    let key = key(title, artist);
    if let Some(l) = LYRICS.lock().unwrap().get(&key) {
        return Ok(l.clone());
    }
    let res = json(LRCLIB, &[("track_name", title), ("artist_name", artist)])?;
    let found = pick_lyrics(&res, title, artist, duration_ms);
    let mut cache = LYRICS.lock().unwrap();
    if cache.len() >= MAX_LYRICS {
        cache.clear();
    }
    cache.insert(key, found.clone());
    Ok(found)
}

fn pick_lyrics(res: &serde_json::Value, title: &str, artist: &str, duration_ms: u64) -> Option<Lyrics> {
    let matches: Vec<&serde_json::Value> = res
        .as_array()?
        .iter()
        .filter(|t| same_song(title, artist, t["trackName"].as_str().unwrap_or(""), t["artistName"].as_str().unwrap_or("")))
        .collect();
    let close = |t: &&&serde_json::Value| {
        let ms = (t["duration"].as_f64().unwrap_or(0.0) * 1000.0) as u64;
        duration_ms == 0 || ms.abs_diff(duration_ms) <= DURATION_SLACK_MS
    };
    let synced = matches.iter().filter(close).find(|t| t["syncedLyrics"].as_str().is_some_and(|s| !s.trim().is_empty()));
    let any = synced.or_else(|| matches.iter().find(|t| t["plainLyrics"].as_str().is_some_and(|s| !s.trim().is_empty())));
    let song = |lines, plain, instrumental| Lyrics { title: title.to_owned(), artist: artist.to_owned(), lines, plain, instrumental };
    let Some(t) = any else {
        let instrumental = matches.iter().any(|t| t["instrumental"].as_bool() == Some(true));
        return instrumental.then(|| song(Vec::new(), Vec::new(), true));
    };
    let lines = synced.map(|s| parse_lrc(s["syncedLyrics"].as_str().unwrap_or(""))).unwrap_or_default();
    let plain = t["plainLyrics"].as_str().unwrap_or("").lines().map(str::trim).map(str::to_owned).collect();
    Some(song(lines, plain, false))
}

/// "[mm:ss.xx] text" lines (a line can carry several times); tags like
/// "[ar: …]" are skipped.
fn parse_lrc(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(body) = rest.strip_prefix('[') {
            let Some(end) = body.find(']') else { break };
            if let Some(ms) = lrc_time(&body[..end]) {
                times.push(ms);
            }
            rest = body[end + 1..].trim_start();
        }
        for ms in times {
            out.push(Line { ms, text: rest.trim().to_owned() });
        }
    }
    out.sort_by_key(|l| l.ms);
    out
}

fn lrc_time(t: &str) -> Option<u64> {
    let (m, s) = t.split_once(':')?;
    let m: u64 = m.trim().parse().ok()?;
    let s: f64 = s.trim().parse().ok()?;
    (s >= 0.0 && s < 60.0).then(|| m * 60_000 + (s * 1000.0).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_across_services() {
        assert!(same_song("FANCY", "TWICE", "FANCY", "TWICE"));
        assert!(same_song("Shape of You", "Ed Sheeran", "Shape of You (Remastered)", "Ed Sheeran"));
        assert!(same_song("Señorita", "Shawn Mendes, Camila Cabello", "Señorita", "Shawn Mendes"));
        assert!(same_song("Song - Live", "A & B", "Song", "A"));
        assert!(!same_song("Fancy", "TWICE", "Fancy Like", "Walker Hayes"));
        assert!(!same_song("", "TWICE", "", "TWICE"));
    }

    #[test]
    fn reads_lrc() {
        let l = parse_lrc("[ar: x]\n[00:01.50] one\n[00:10.00][01:02.25] two\n[00:05.00]");
        let got: Vec<(u64, &str)> = l.iter().map(|l| (l.ms, l.text.as_str())).collect();
        assert_eq!(got, [(1500, "one"), (5000, ""), (10000, "two"), (62250, "two")]);
    }

    #[test]
    fn only_image_hosts() {
        assert!(image("https://evil.example/x.jpg").is_none());
        assert!(image("https://cdn-images.dzcdn.net@evil.example/x.jpg").is_none());
        assert!(image("http://cdn-images.dzcdn.net/x.jpg").is_none());
    }

    #[test]
    #[ignore = "uses the internet"]
    fn finds_online() {
        let dir = std::env::temp_dir().join("console-ui-covers");
        let c = cover(&dir, "FANCY", "TWICE").expect("cover");
        println!("cover {} KB", c.len() / 1024);
        let l = lyrics("FANCY", "TWICE", 213_000).unwrap().expect("lyrics");
        println!("{} synced lines, {} plain", l.lines.len(), l.plain.len());
    }
}
