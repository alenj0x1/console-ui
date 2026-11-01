English | [Español](CHANGELOG.es.md)

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Changes waiting for the next version sit under **Unreleased** at the top (this section only exists while there are some, and the docs site doesn't show it); `scripts/release.py` turns it into the new version.

## [Unreleased]

### Added

- Controller input core (XInput, read in the background) with cursor, scroll, clicks, drag, arrow keys, Esc, back/forward, Task view and Start menu.
- Assisted cursor: predictable acceleration, slowdown over clickable elements (UI Automation, only while aiming) and click stabilization.
- Game mode: hold View + Menu to hand the controller to games and back, with rumble feedback.
- Tauri app with tray icon and an on-screen keyboard overlay that never steals focus (Y opens it, B closes it). Opening the app shows the home screen (`--background` starts it quietly); clicking the tray icon opens it too, and its menu opens the keyboard or hands the controller to games.
- Keyboard layouts: QWERTY grid with ñ, accents on hold, symbols; two-halves layout as an option.
- Word suggestions with accents, previous-word context and next-word prediction; Spanish by default, English from the keyboard's language key (L3).
- Learned words, encrypted with DPAPI, off in password fields; "forget learned words" in the language menu.
- Home screen (hold Menu): installed Steam and Epic games with their official Steam art as the background, pinned Start menu apps with their real icons, and a music player (cover and its colour as the background, progress, round transport buttons). Up/down change the system volume and Y mutes. Launching a game hands the controller to it.
- Volume from anywhere: hold RT and use the d-pad (up/down volume, left/right previous/next track).
- With HidHide installed, other apps stop seeing the controller while it drives Windows (the Start menu and other Store apps no longer move their own focus and jump), and see it again in game mode; a watchdog shows it again if the app ends unexpectedly.
- Admin windows: Windows blocks a normal app's input there, so a banner says why the controller doesn't respond and B hands the focus back to the next normal window (Console UI does not raise its own rights).
- Diagnostic event log in the app-data folder (mode changes, launches, which program the keyboard types into; never the text).
- Cursor and keyboard labs with their data and notes.
