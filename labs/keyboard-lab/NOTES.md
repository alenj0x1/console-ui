# Keyboard lab

**Question:** which on-screen keyboard layout types faster and feels better with a controller?

**Candidates** (`app/ui/keyboard.js`):

- **grid**: QWERTY (Spanish, with ñ) with one highlight. Left stick / d-pad move (geometric up/down, wrap left/right), A types, right stick moves the text caret.
- **split**: two 5×3 halves, one highlight per stick; LT types the left key, RT the right one.

Shared: X backspace (repeats), Y space, LB shift (one-shot), RB symbols, Menu enter. Holding the type button ≥ 350 ms on a vowel types the accented variant (á é í ó ú, ¿ ¡).

Navigation events come from `padcore::ui`: 4-way with hysteresis, first repeat at 260 ms, then 110 → 60 ms depending on tilt (d-pad 80 ms).

**Pipeline under test:** the overlay window is `WS_EX_NOACTIVATE` + topmost, keys are injected with `SendInput` (`KEYEVENTF_UNICODE` for characters) into the lab window, which keeps focus.

**Method:** 24 original Spanish phrases (lowercase, a few accents), shuffled. One warm-up block per layout (2 phrases, unscored), then ABBA scored blocks of 3 phrases. Per phrase: WPM ((chars − 1) / 5 per minute, from the first input event to Enter), error rate (Levenshtein / longer length), keystrokes per character, backspaces. 1–5 rating per scored block.

**Run:** `target/release/console-ui.exe --lab`. Results in `results/`.

## Pre-checks (2026-11-01)

- Both layouts render inside the 800 × 330 overlay; navigation, tap vs hold (e → e, held → é), split LT/RT typing, shift and symbols verified with a stubbed bridge in the browser.
- Lab flow (warm-up → scored → rating → results → save) verified end to end with the same stub.

## Runs

### Run 1 — 2026-11-01 (Alejandro, 6 scored phrases per layout)

| layout | WPM | error rate | KSPC | rating |
|---|---|---|---|---|
| grid | 11.2 | 2.2 % | 1.09 | 4.0 |
| split | 8.2 | 2.1 % | 1.10 | 3.5 |

- The real pipeline works: text (including á, í, ú when held) reached the lab window through the non-activating overlay.
- Grid is 36 % faster with the same accuracy and rated higher. Both improved with practice (grid 8.6 → 12.5 WPM, split 4.8 → 9.4), split more steeply, but it stays behind in every scored block.
- Almost every error is a missing accent: accents were typed in 2 of 9 phrases that needed them (one more real typo: "cprreo"). Hold-for-accent is rarely used in practice.
- **Decision:** grid is the default; split stays as an option. Next improvement for accuracy: word suggestions that also restore accents (esta → está).

### Changes for run 2: word suggestions

- Dictionary `app/ui/data/words.txt` (38,102 words) built by `tools/build_dictionary.py` from FrequencyWords (pinned commit, SHA-256 verified, CC BY-SA 4.0, credited in `LICENSE-words.txt`): Spanish top 30k + English top 12k ×0.2; unaccented spellings rarer than 10 % of their accented twin dropped ("cancion", "tambien").
- Matching ignores accents and ñ: "esta" → está, estás, estaba; "ano" → año; "cancion" → canción. Under 1.1 ms per keystroke over the whole list.
- Strip of 3 above the keys. Grid: RT takes the first one, or go up from the top row and press A. Split: View. Accepting deletes the typed word and types the suggestion plus a space in one `SendInput` batch.
- The keyboard only knows what it typed itself, so the current word resets on space, enter, punctuation and caret moves.
- Lab `--lab --exp=suggest`: grid without vs with suggestions, same protocol. "Actions per letter" now counts controller actions (moves + keys + suggestions) reported by the keyboard.

### Run 2 — 2026-11-01 (grid, without vs with suggestions, 6 scored phrases each)

| variant | WPM | error rate | actions/letter | rating |
|---|---|---|---|---|
| without | 10.9 | 2.4 % | 5.0 | 1.5 |
| with | 12.8 | 0 % | 4.0 | 4.0 |

- Suggestions: +17 % speed, −19 % controller actions, every missing accent gone (24 suggestions accepted). Feedback: "help a lot", but the offered words must be better, and English must only appear when the user enables it (several languages allowed).
- `backspaces` in the "with" rows include the ones `replace_word` sends; they are not user corrections.

### Offline suggestion quality (`suggest_eval.js`, 30 unseen phrases, 191 words)

Simulates typing without accents and taking the target as soon as it is in the top 3 (top 1 = RT, others = up + A).

| dictionary / ranking | keystroke saving | target is first |
|---|---|---|
| current (es + en ×0.2) | 30.2 % | 51.8 % |
| Spanish only, 30k | 30.3 % | 50.8 % |
| Spanish only, 50k | 30.8 % | 51.8 % |
| + previous word context (Tatoeba bigrams, λ 0.95) | 43.0 % | 55.0 % |
| + next-word prediction after a space | 45.6 % | 46.1 % |

- Dictionary size barely matters; ranking by context is the big lever (+13 points).
- Bigram source tried: Tatoeba Spanish sentences (443k, CC BY 2.0 FR), snapshot sha256 bc7e22e3…ae71c (2026-10-31).

### Suggestions v2 — 2026-11-01

Alejandro's choices: previous-word context, next-word prediction, learning from him; languages chosen on the keyboard (L3 key), Spanish only by default.

- Data per language (`words-<lang>.txt`, `pairs-<lang>.tsv`) from `tools/build_language_data.py`: FrequencyWords 50k + Tatoeba pairs (count ≥ 2, top 200 per word, with totals). Tatoeba stock names and corpus artifacts are dropped from pairs when 15× more frequent there than in subtitles (tom, mary, sami, boston, "re/ve/ll"…).
- Ranking: 0.95 × P(word | previous) + 0.05 × Zipf(rank), summed over enabled languages; accent twins first. Learning: user pairs (weight 2, shrunk by +5 while history is short) for every word, plus a word bonus only for words the dictionaries lack (names, slang).
- Learned data: `%APPDATA%\dev.alejandro.consoleui\learned.bin`, DPAPI-encrypted, saved every 15 s and on exit; "forget" deletes it. Off in password fields (UIA `IsPassword`, checked when the keyboard opens and after Enter; errors count as password) and in labs.

| Spanish, 30 unseen phrases | saving | target first |
|---|---|---|
| v1 (es + en, frequency only) | 30.2 % | 51.8 % |
| v2, nothing learned | 42.2 % | 45.5 % |
| v2, learning during the same pass | 41.9 % | — |
| v2, after having typed the phrases once | 71.9 % | — |

Slowest suggestion: 2.6 ms (es), 10.8 ms (es + en). "Target first" drops because next-word predictions now often place it 2nd or 3rd; total actions still fall.
