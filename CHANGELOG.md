English | [Español](CHANGELOG.es.md)

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Changes waiting for the next version sit under **Unreleased** at the top (this section only exists while there are some, and the docs site doesn't show it); `scripts/release.py` turns it into the new version.

## [Unreleased]

### Added

- Controller input core (XInput, read in the background) with cursor, scroll, clicks, drag, arrow keys, Esc, back/forward, Task view and Start menu.
- Assisted cursor: predictable acceleration, slowdown over clickable elements (UI Automation, only while aiming) and click stabilization.
- Game mode: hold View + Menu to hand the controller to games and back, with rumble feedback.
- Tauri app with tray icon and an on-screen keyboard overlay that never steals focus (Y opens it, B closes it).
- Keyboard layouts: QWERTY grid with ñ, accents on hold, symbols; two-halves layout as an option.
- Word suggestions with accents, previous-word context and next-word prediction; Spanish by default, English from the keyboard's language key (L3).
- Learned words, encrypted with DPAPI, off in password fields; "forget learned words" in the language menu.
- Cursor and keyboard labs with their data and notes.
