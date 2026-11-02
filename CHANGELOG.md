English | [Español](CHANGELOG.es.md)

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Changes waiting for the next version sit under **Unreleased** at the top (this section only exists while there are some, and the docs site doesn't show it); `scripts/release.py` turns it into the new version.

## [Unreleased]

### Added

- Controller input core (XInput, read in the background) with cursor, scroll, clicks, drag, arrow keys, Esc, back/forward, Task view and Start menu.
- Assisted cursor: predictable acceleration, slowdown over clickable elements (UI Automation, only while aiming) and click stabilization.
- Game mode: a game coming to the front (from anywhere) gets the controller, with rumble feedback and a short banner, and the cursor comes back when it closes. Taking the controller back from the tray leaves that game alone.
- Guide (hold View + Menu, even in a game; a View tap in the desktop): open windows with a picture of each, A switches to one (a game gets the controller, anything else the cursor), Y closes one, X / LT / RT control the music, B goes back. It never takes the focus, so the game stays in front.
- Tauri app with tray icon and an on-screen keyboard overlay that never steals focus (Y or a click on a text field opens it, B closes it). It opens on the monitor under the cursor and moves to the top when it would cover the text being typed. Opening the app shows the home screen (`--background` starts it quietly); clicking the tray icon opens it too, and its menu opens the keyboard or hands the controller to games.
- Keyboard layouts: QWERTY grid with ñ, accents on hold, symbols; two-halves layout as an option.
- Word suggestions with accents, previous-word context and next-word prediction; Spanish by default, English from the keyboard's language key (L3).
- Learned words, encrypted with DPAPI, off in password fields; "forget learned words" in the language menu.
- Home screen (hold Menu): installed Steam and Epic games with their official Steam art as the background, pinned Start menu apps with their real icons, and a media tab with the installed media apps (Spotify, VLC…) and whatever else you add from "Editar" (media apps first, every other app under "Todas las apps"), or YouTube, YouTube Music, Netflix, Twitch, Prime Video and Disney+, which open in the default browser where you are signed in. The app that is playing comes first with the song on its card; with the focus on it the background takes the cover's colour and shows the progress, X plays / pauses and LT / RT change the song. Up/down change the system volume and Y mutes. Launching a game hands the controller to it.
- Home screen backgrounds, chosen from the "Fondo" tile in Apps with a live preview: five built-in animated backgrounds drawn by the GPU (Ola diagonal by default, Ondas, Lluvia, Respiración and Ondas lineales), Wallpaper Engine video wallpapers (with a shortcut to its Workshop) and the videos and pictures in Videos, Pictures or any folder added with the controller. The focused game's art covers it on the games tab (can be turned off); the background pauses while it can't be seen.
- Settings tab on the home screen, driven with the controller, with everyday names and a description for every option: Apariencia (main colour, text size, thicker selection frame, background and game art), Botones (confirm with B, pointer on the right stick, how long buttons are held), Puntero (speed, aiming help, ignoring small movements, scroll speed and direction), Teclado (layout, word suggestions, remembering your words, languages and erasing them), Juegos (hand the controller to the game you open) and General (start with Windows in the tray, vibrate on mode changes, and the screen as a list or as tiles). Changes apply at once in every window.
- The Puntero and Botones options show an animated preview of what they change next to them, built from the same values the controller uses, with the previous value faded in for comparison and a line about the chosen value. The background dims while Settings is open.
- Game trailers: after a few seconds on a Steam game, its trailer plays over the art, silent and looping (the first seconds, downloaded once from the Steam store and kept).
- Media tab: the background blends the cover's two main colours, and covers sent as a card with the player's logo are trimmed to the artwork.
- View and Menu hints show the symbols printed on those buttons instead of their names.
- A tap on RT presses Enter (to send after closing the keyboard).
- Volume from anywhere: hold RT and use the d-pad (up/down volume, left/right previous/next track).
- With HidHide installed, other apps stop seeing the controller while it drives Windows (the Start menu and other Store apps no longer move their own focus and jump), and see it again in game mode; a watchdog shows it again if the app ends unexpectedly.
- Admin windows: Windows blocks a normal app's input there, so a banner says why the controller doesn't respond and B hands the focus back to the next normal window (Console UI does not raise its own rights).
- Diagnostic event log in the app-data folder (mode changes, launches, which program the keyboard types into; never the text).
- Cursor and keyboard labs with their data and notes.
