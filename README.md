English | [Español](README.es.md)

# Console UI

Use all of Windows from the couch with a game controller: an assisted cursor, an on-screen keyboard with smart suggestions, and a console-style home screen.

> Early development. Not released yet; build it from source.

## What it does

- **Assisted cursor**: the left stick moves the mouse with a predictable acceleration, slows down over buttons and links (read through UI Automation) and holds still for a moment when you click. Right stick scrolls; the d-pad sends arrow keys.
- **On-screen keyboard**: press Y (or click a text field) to open it over any app without stealing focus, on the monitor under the cursor and clear of the text being typed. QWERTY grid with ñ, accents on hold, symbols, and a two-halves layout as an option.
- **Suggestions**: complete the word and restore accents (`esta` → `está`), use the previous word as context and predict the next one. They learn from you, stored encrypted with DPAPI and never in password fields. Spanish by default; English can be turned on from the keyboard.
- **Home screen**: hold Menu for a full-screen view of your Steam and Epic games (official art as the background), pinned apps with their real icons and the music that is playing, over a built-in animation, a Wallpaper Engine video wallpaper or your own videos and pictures. Spotify's web player opens inside the app. Launching a game hands the controller to it.
- **Game mode**: hold View + Menu to leave the controller to games (two short rumbles) and again to get the cursor back (one rumble).
- **Labs**: every design choice was measured with the user before adopting it (see `labs/`).

## Controls

| Control | Cursor mode | Keyboard |
|---|---|---|
| Left stick / d-pad | Move cursor (LT = precision) / arrow keys | Move the highlight |
| Right stick | Scroll | Move the text caret |
| A / X / L3 | Left / right / middle click | Type (hold for accent) / backspace / languages |
| B | Esc | Close the keyboard |
| Y | Open the keyboard (also by clicking a text field) | Space |
| LB / RB | Back / forward | Shift / symbols |
| RT | Tap: Enter. Hold + d-pad: volume, previous/next track | Take the first suggestion |
| View / Menu | Task view / Start menu (hold: home screen) | – / Enter |
| Hold View + Menu | Turn the controller over to games, and back | |

## Requirements

- Windows 10 or 11 (x64) with an XInput (Xbox-compatible) controller. PlayStation controllers work through Steam Input or DS4Windows.
- WebView2 runtime (included in current Windows).
- Optional: [HidHide](https://github.com/nefarius/HidHide) (MIT), so the Start menu and other Store apps don't react to the controller while it moves the cursor.

## Development

```bash
cargo build --release
```

- `target/release/console-ui.exe`: the app; it opens the home screen. `--background` starts it in the tray only, `--lab` opens the keyboard lab (`--exp=suggest` for the suggestions comparison).
- `target/release/padd.exe`: the input core alone, in a console.
- `target/release/cursor-lab.exe`: the cursor lab.
- `cargo test`: unit tests (curves, encrypted store).
- `python -I tools/build_language_data.py`: rebuilds the suggestion data (downloads pinned, hash-checked sources).
- `node labs/keyboard-lab/suggest_eval.js es`: offline suggestion quality.
- `python scripts/release.py X.Y.Z`: cuts a release (bumps versions, closes the changelog section, commits and tags).

| Path | What |
|---|---|
| `crates/padcore` | Input core: XInput, stick curves, SendInput injection, UI Automation, mode engine |
| `crates/padd` | Console host for the core |
| `app` | Tauri 2 app: tray, keyboard overlay (`app/ui`), settings and learned words |
| `labs` | Experiments with data and notes |
| `tools` | Data builders |

## Credits

- [Tauri](https://tauri.app) (MIT / Apache-2.0), [egui/eframe](https://github.com/emilk/egui) for the cursor lab (MIT / Apache-2.0), [windows-rs](https://github.com/microsoft/windows-rs) (MIT / Apache-2.0).
- Fonts [Fredoka](https://github.com/hafontia/Fredoka-One), [Nunito](https://github.com/googlefonts/nunito) and [DM Mono](https://github.com/googlefonts/dm-mono), SIL Open Font License 1.1 (`app/ui/fonts`).
- Word lists derived from [FrequencyWords](https://github.com/hermitdave/FrequencyWords) by Hermit Dave (OpenSubtitles 2018), CC BY-SA 4.0. Word pairs computed from [Tatoeba](https://tatoeba.org) sentences, CC BY 2.0 FR. Details in `app/ui/data/LICENSE-data.txt`.

## License

Code: [MIT](LICENSE). Suggestion data keeps its own licenses (see Credits).
