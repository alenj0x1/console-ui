# HidHide lab

**Problem:** UWP/XAML apps (Start menu, Settings, Store…) read the controller themselves and move their own focus with the left stick while our cursor moves too, so a scrolled list jumps back up.

**Hypothesis:** hiding the physical controller from every app except Console UI while it drives the desktop (cursor, keyboard, home) removes the conflict; showing it again in game mode keeps games working.

**Tool:** HidHide by Nefarius (MIT), v1.5.230 — latest GitHub release (2024-05-11). Installer `HidHide_1.5.230_x64.exe`, 8,078,016 bytes, SHA-256 `F4BBBCB82E6258641B887C74BC81C4C5F66E4AA811808DFC304347687B7605F6`, Authenticode valid, signed by Nefarius Software Solutions e.U. (downloaded 2026-11-01; not committed).

**Security impact:** installs a signed kernel filter driver (one admin prompt). It only filters which processes can open the hidden devices; the CLI used to toggle it does not need elevation. Risk to watch: if Console UI dies while the controller is hidden, games cannot see it until Console UI runs again or hiding is turned off in the HidHide configuration app.

**Checks to run:**
1. XInput still works for Console UI with the controller hidden (whitelisted by path).
2. Start menu: scroll with the right stick, move the cursor → the list stays put.
3. Game mode shows the controller again: a game (Hollow Knight) and Steam see it.
4. Time to toggle hiding on mode change.

## Runs

### Run 1 — 2026-11-01 (automated checks)

- Device: "Controller (XBOX 360 For Windows)", one present HID child + its USB container (`--dev-gaming`). Both are hidden: XInput opens the container.
- Whitelisted process reads XInput with the controller hidden; an identical non-whitelisted copy gets "not connected". Showing it again restores both.
- `--cloak-on` 21 ms, `--cloak-off` 22 ms (CLI process included).
- In the app: cursor mode → cloak on. Hard kill of the app → the `--guard` watchdog turned cloak off within 2 s.
- Pending (with Alejandro): Start menu scroll + cursor, a game and Steam seeing the controller in game mode.

**Integration** (`app/src/guard.rs`): registers its own exe and hides every present gaming device on each controller connection; cloak on in cursor/keyboard/home, off in game mode and on exit; watchdog process for crashes; disabled in labs and when HidHide is not installed.

### Run 2 — 2026-11-01 (with Alejandro's controller)

- Start menu still jumped after hiding: restarting `StartMenuExperienceHost` did not help, synthetic scroll + move never reproduced it. Unplugging and re-plugging the controller fixed it: a Windows component had opened the controller at sign-in, before the cloak, and HidHide only blocks new opens. Re-plugging is needed once per sign-in; an automatic device restart needs admin rights (to consider with the installer).
