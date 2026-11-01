# Cursor lab

**Question:** which stick → cursor profile feels best and is fastest for desktop use?

**Method:** 3 profiles × 2 rounds, 12 click targets per block (radius 14/24/40 px, 250–900 px apart), profile order shuffled per round and hidden behind a number. Per target: movement time, Fitts throughput (Shannon ID / MT, W = diameter), misses, path efficiency. 1–5 rating per block. The engine thread logs real tick intervals and step cost.

**Candidates** (`padcore::curve::builtin_profiles`), speeds in screen heights/s:

| id | deadzone | exponent | max | turbo |
|---|---|---|---|---|
| lineal | 0.12 | 1.0 | 1.1 | – |
| curva | 0.12 | 2.2 | 1.6 | – |
| curva-turbo | 0.12 | 2.0 | 1.2 | ×2.2 after 0.25 s at full tilt, 0.5 s ramp |

All use left trigger precision ×0.3.

## Baseline checks (2026-11-01, i5-12400, Windows 10 19045)

- Absolute positioning self-test: 0 of 4 points missed.
- Sub-pixel accumulation: 50 × (0.4, 0.25) px → +20, +13 (expected +20, +12 ±1); 0 resyncs.
- `padd` idle with controller connected: < 0.2 % of one core (below the 15.6 ms counter resolution over 10 s), 8.3 MB RAM.

## Runs


### Run 1 — 2026-11-01 (Alejandro, Xbox-compatible controller)

| profile | mean | throughput | misses/target | path eff. | rating |
|---|---|---|---|---|---|
| lineal | 4056 ms | 1.32 b/s | 0.71 | 50 % | 3.5 |
| curva | 3908 ms | 1.40 b/s | 0.21 | 46 % | 2.5 |
| curva-turbo | 4543 ms | 1.15 b/s | 0.21 | 43 % | 2.5 |

- No winner: differences are within noise (24 trials each) and there is a strong learning effect (curva block 1: 5.3 s → block 4: 2.5 s).
- All profiles are slow (~4 s/target; a mouse is < 1 s) with path efficiency < 50 %: lots of overshoot and correction near the target.
- Small targets (28 px) cost 3–7 s; lineal is fastest on big targets (1.8 s) but worst on small ones and missed most.
- Feedback: "small circles were hard; sometimes it was slower, sometimes faster" → speed felt unpredictable (turbo kicking in, profile changes between blocks).
- Loop timing is fine: tick p50 5.0 ms, p99 5.08 ms; step p50 8 µs, p99 180 µs.

### Changes for run 2 (from run 1 findings)

- **Predictable acceleration** (`asistido`): exponent 2.0, base 0.8 h/s; boost builds steadily from 55 % tilt up to ×2.4 over 0.7 s, drains at 2.5×/s below it, resets on stick release. Unit tests check: no drop or jump while holding, reset on release.
- **Hover brake**: ×0.45 over clickable elements, only while the boost is below half (crossing the screen is not braked). Real desktop source: UI Automation `ElementFromPoint` on its own thread (Button, Hyperlink, MenuItem, ListItem, Edit… enabled and < 20 % of the screen). In the lab, the target circle plays that role.
  - UIA check: Start button and tray = clickable, desktop centre = not; 1.4 ms per query on average (first query 25 ms).
  - Probe only runs while the stick moved in the last second; idle `padd` went from 0.47 % to < 0.1 % of one core (11.7 MB).
- **Click freeze**: 90 ms of no movement after pressing A or X.
- **Lab**: `curva` (baseline) vs `asistido`; 2 unscored warm-up blocks (8 targets), then ABBAAB with 15 targets per block.

### Run 2 — 2026-11-01 (curva vs asistido, 45 scored targets each)

| profile | mean | median | throughput | misses/target | path eff. | rating |
|---|---|---|---|---|---|---|
| curva | 6580 ms | 3750 ms | 1.26 b/s | 0.60 | 41 % | 1.0 |
| asistido | 1820 ms | 1583 ms | 2.25 b/s | 0.02 | 63 % | 3.3 |

By target size (mean): 28 px 11.1 s → 2.5 s, 48 px 5.4 s → 1.7 s, 80 px 2.1 s → 1.4 s.

- `asistido` won every scored block (1.6–2.0 s vs 6.4–7.0 s) and every round's rating; P(a random `asistido` trial is faster than a `curva` one) = 0.79.
- The gain is mostly on small targets, where `curva` overshot repeatedly (22 misses on 28 px vs 1).
- **Decision:** `asistido` is the default profile.
- Caveat: in the lab the brake knows the exact target; on the desktop it depends on what UI Automation exposes (apps with poor accessibility get no brake). Rating 3.3/5 leaves room to tune later.

### Desktop tuning — 2026-11-01

On the real desktop the `asistido` boost (×2.4 from 55 % tilt, 0.7 s ramp) felt too fast: lab targets were close, so it rarely kicked in there. Base speed, curve, brake and click freeze stay as validated; the boost now needs 75 % tilt, tops out at ×1.7 and builds over 1 s (max 1.36 instead of 1.92 screen heights/s). Not re-measured in the lab yet.

Then ×1.7 from 75 % felt "a bit slow"; settled in between: ×2.0 from 65 % tilt over 0.85 s (max 1.6 screen heights/s).
