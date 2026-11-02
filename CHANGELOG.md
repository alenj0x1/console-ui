English | [Español](CHANGELOG.es.md)

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Changes waiting for the next version sit under **Unreleased** at the top (this section only exists while there are some, and the docs site doesn't show it); `scripts/release.py` turns it into the new version.

## [Unreleased]

### Added

- Controller input core (XInput, read in the background) with cursor, scroll, clicks, drag, arrow keys, Esc, back/forward, Task view and Start menu.
- Assisted cursor: predictable acceleration, slowdown over clickable elements (UI Automation, only while aiming) and click stabilization.
- Game mode: a game coming to the front (from anywhere) gets the controller, with rumble feedback and a short banner, and the cursor comes back when it closes. Taking the controller back from the tray leaves that game alone.
- Control center (hold View + Menu, even in a game; a View tap in the desktop): open windows with a picture of each, A switches to one (a game gets the controller, anything else the cursor), Y closes one, X / LT / RT control the music, B goes back. It never takes the focus, so the game stays in front.
- Tauri app with tray icon and an on-screen keyboard overlay that never steals focus (Y or a click on a text field opens it, B closes it). It opens on the monitor under the cursor and moves to the top when it would cover the text being typed. Opening the app shows the home screen (`--background` starts it quietly); clicking the tray icon opens it too, and its menu opens the keyboard or hands the controller to games.
- Keyboard layouts: QWERTY grid with ñ, accents on hold, symbols; two-halves layout as an option.
- Word suggestions with accents, previous-word context and next-word prediction; Spanish by default, English from the keyboard's language key (L3).
- Learned words, encrypted with DPAPI, off in password fields; "forget learned words" in the language menu.
- Home screen (hold Menu): installed Steam and Epic games with their official Steam art as the background, pinned Start menu apps with their real icons, and a media tab with the installed media apps (Spotify, VLC…) and whatever else you add from "Editar" (media apps first, every other app under "Todas las apps"), or YouTube, YouTube Music, Netflix, Twitch, Prime Video and Disney+, which open in the default browser where you are signed in. The app that is playing comes first with the song on its card; with the focus on it the background takes the cover's colour and shows the progress, X plays / pauses and LT / RT change the song. Up/down change the system volume and Y mutes (in Games, Y searches). Launching a game hands the controller to it.
- Home screen backgrounds, chosen from the "Fondo" tile in Apps with a live preview: five built-in animated backgrounds drawn by the GPU (Ola diagonal by default, Ondas, Lluvia, Respiración and Ondas lineales), Wallpaper Engine video wallpapers (with a shortcut to its Workshop) and the videos and pictures in Videos, Pictures or any folder added with the controller. The focused game's art covers it on the games tab (can be turned off); the background pauses while it can't be seen.
- Settings tab on the home screen, driven with the controller, with everyday names and a description for every option: Apariencia (high contrast, main colour, text size from 100 to 150 %, thicker selection frame, background and game art), Botones (layout for both hands or one, custom buttons, controller colour, confirm with B, pointer on the right stick, how long buttons are held), Puntero (speed, aiming help, ignoring small movements, scroll speed and direction), Teclado (layout, word suggestions, remembering your words, languages and erasing them), Juegos (hand the controller to the game you open) and General (start with Windows in the tray, vibrate on mode changes, and the screen as a list or as tiles). Changes apply at once in every window.
- Turning on confirm with B, the pointer on the right stick or a one-hand layout asks to keep the change and goes back by itself after 10 seconds without an answer.
- High contrast: plain black behind everything, white text and lines, and a thick yellow frame on the selection; it turns on by itself when Windows uses high contrast. Pictures, covers and tiles keep their size when the text grows, so every tab fits at 150 %.
- One-hand layouts (left or right): the stick on that side moves the pointer, the bumper clicks, the trigger right-clicks and the d-pad or the face buttons scroll and go back or forward, also on the home screen and the keyboard. In a game, holding View (left) or Menu (right) alone opens the control center. Button hints across the app show the button that does each action.
- Custom buttons: a drawing of the controller with every reassignable button around it and what it does; the focused one lights up and a line joins it to its row. Choosing one opens its actions next to the drawing, with the original one marked.
- Controller colour: twelve dark colours, some with a fine regular texture (dots, lines, grid, stripes, honeycomb, carbon fibre, rings), plus a random combination made from a seed, with another combination and the previous one a press away. The drawing keeps its lines, letters and selection readable on every colour.
- "Dejar todo como venía" in General puts every option back as it came (pinned apps, the media tab and learned words stay); it asks for a second press first.
- Controller buttons are drawn as on the controller everywhere (A, B, X, Y, L3 and R3 round, bumpers and triggers with their shape, View and Menu with their symbols), also inside the settings' descriptions.
- The Puntero and Botones options show an animated preview of what they change next to them, built from the same values the controller uses, with the previous value faded in for comparison and a line about the chosen value. The background dims while Settings is open.
- Game trailers: after a few seconds on a Steam game, its trailer plays over the art, silent and looping (the first seconds, downloaded once from the Steam store and kept).
- Media tab: the background blends the cover's two main colours, and covers sent as a card with the player's logo are trimmed to the artwork.
- View and Menu hints show the symbols printed on those buttons instead of their names.
- A tap on RT presses Enter, in the keyboard too (the first suggestion is on View).
- Volume from anywhere: hold RT and use the d-pad (up/down volume, left/right previous/next track).
- With HidHide installed, other apps stop seeing the controller while it drives Windows (the Start menu and other Store apps no longer move their own focus and jump), and see it again in game mode; a watchdog shows it again if the app ends unexpectedly.
- Admin windows: Windows blocks a normal app's input there, so a banner says why the controller doesn't respond and B hands the focus back to the next normal window (Console UI does not raise its own rights).
- Diagnostic event log in the app-data folder (mode changes, launches, which program the keyboard types into; never the text).
- Welcome: the first time, a short practice finished with the controller itself (point and click, choose the pointer speed and how much movement to ignore, type with the keyboard, open the home screen and the control center) and a few more things worth knowing; it can be skipped and repeated from Settings.
- Search in Games: Y opens a search with letters and numbers picked with the controller; results are in alphabetical order, match the start of each word, and LT / RT jump to the previous or next letter.
- LT + d-pad jumps the pointer to the nearest button or link in that direction (read with UI Automation).
- Quick menu: holding View with the pointer shows a round menu with Keyboard, Snip, Desktop, Close window and Home; the right stick aims and letting go of View picks; with it in the middle, letting go does nothing.
- TV mode, in Settings: leaves only the chosen screen on, as the main one, and sends the sound to the chosen output; it asks whether the TV shows it and, with no answer in 15 s, goes back by itself; turning it off (from the control center too, or opening the app again after it closed abruptly) puts the screens and sound back as they were.
- Control center: the controller's battery next to the clock and a power menu on Menu (sleep, restart, shut down and sign out; the last three need A held for a second).
- Notices when the controller connects (with its battery), disconnects or runs low, and on the home screen when something cannot be opened or saved.
- With Windows' "Show animations" off, backgrounds and previews stay still and trailers don't play.
- Commands that type, open programs, read learned words or power off answer only the window that uses them; network folders are refused as backgrounds, and words typed in consoles or remote desktops are never learned.
- Cursor and keyboard labs with their data and notes.
- Windows installer (NSIS, per user, Spanish or English): Start menu shortcut, WebView2 downloaded if missing, and an optional HidHide step that downloads the official release, checks its SHA-256 and signature and runs its installer. Uninstalling removes the "start with Windows" entry, shows the controller to games again and deletes settings only when asked. Opening the app while it runs brings up its home screen instead of a second copy.
