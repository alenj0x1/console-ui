"""Builds the keyboard's suggestion data, one set of files per language:

  app/ui/data/words-<lang>.txt    one word per line, most frequent first
  app/ui/data/pairs-<lang>.tsv    "previous<TAB>next<TAB>count" (previous "^" =
                                  start of sentence), top continuations only;
                                  "previous<TAB>*<TAB>count" is how often the
                                  previous word was followed by anything

Sources (downloaded and verified by SHA-256; the derived files are committed
so the app never downloads anything):

  * Words: FrequencyWords by Hermit Dave, OpenSubtitles 2018 counts, pinned
    commit. Content CC BY-SA 4.0.
  * Pairs: Tatoeba sentences per language. CC BY 2.0 FR. Tatoeba only serves
    its latest weekly export, so a new snapshot fails the hash check on
    purpose: review it and update TATOEBA_SHA.

Run: python -I tools/build_language_data.py
Lab variants: --lang es --keep 30000 --out-dir some/dir
"""

import argparse
import bz2
import collections
import hashlib
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

FW_COMMIT = "525f9b560de45753a5ea01069454e72e9aa541c6"
LANGS = {
    # lang: (FrequencyWords file, sha256, Tatoeba code, sha256, letters)
    "es": (
        "content/2018/es/es_50k.txt", "dcff3ad4316192f4dc4ff7d26e637c6ff314ef1ca0f3f720c5649018a71056c0",
        "spa", "bc7e22e31dec6557dd5cf5ce3547f1f2519a62c76a0699c9a5a5c84a83bae71c",
        "a-záéíóúüñ",
    ),
    "en": (
        "content/2018/en/en_50k.txt", "5351ff405b1126ef555791dd4d9798a48e3e9a501a9fc481a9da957752cfb458",
        "eng", "07f33d399f0a55b917202abbd901f23c39c54a6dd562252985ce8c7e168db6ef",
        "a-z",
    ),
}
KEEP_WORDS = 50000
# Single letters that are real words.
SHORT = {"es": {"a", "e", "o", "u", "y"}, "en": {"a", "i"}}
# An unaccented spelling far rarer than its accented twin is a typo in the
# subtitles ("cancion" vs "canción"), not a word.
TYPO_RATIO = 0.1
MIN_PAIR_COUNT = 2
# Tatoeba reuses a few stock names ("Tom", "Mary", "Sami") in thousands of
# sentences. A word this many times more frequent there than in subtitles is
# such an artifact and is not suggested from pairs.
ARTIFACT_RATIO = 15
PAIRS_PER_WORD = 200
START = "^"

DATA = Path(__file__).resolve().parent.parent / "app" / "ui" / "data"


def download(url: str, sha256: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != sha256:
        sys.exit(f"Hash mismatch for {url}\n  expected {sha256}\n  got      {digest}")
    return data


def fold(word: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", word) if not unicodedata.combining(c))


def build_words(lang: str, keep: int) -> dict[str, int]:
    path, sha, *_, letters = LANGS[lang]
    valid = re.compile(f"^[{letters}]+$")
    text = download(f"https://raw.githubusercontent.com/hermitdave/FrequencyWords/{FW_COMMIT}/{path}", sha).decode()
    counts: dict[str, int] = {}
    for line in text.splitlines():
        word, _, count = line.rpartition(" ")
        if valid.match(word) and (len(word) > 1 or word in SHORT[lang]):
            counts[word] = int(count)
            if len(counts) >= keep:
                break
    best: dict[str, int] = collections.defaultdict(int)
    for w, c in counts.items():
        best[fold(w)] = max(best[fold(w)], c)
    return {w: c for w, c in counts.items() if not (w == fold(w) and c < TYPO_RATIO * best[w])}


def build_pairs(lang: str, vocab: dict[str, int]) -> tuple[list[tuple[str, str, int]], list[str]]:
    _, _, code, sha, letters = LANGS[lang]
    raw = download(f"https://downloads.tatoeba.org/exports/per_language/{code}/{code}_sentences.tsv.bz2", sha)
    token = re.compile(f"[{letters}]+")
    pairs: collections.Counter = collections.Counter()
    for line in bz2.decompress(raw).decode("utf-8").splitlines():
        words = [START] + token.findall(line.rsplit("\t", 1)[-1].lower())
        pairs.update((a, b) for a, b in zip(words, words[1:]) if b in vocab and (a == START or a in vocab))
    seen: collections.Counter = collections.Counter()
    for (_, b), c in pairs.items():
        seen[b] += c
    subs_total, seen_total = sum(vocab.values()), sum(seen.values())
    artifacts = {b for b, c in seen.items() if (c / seen_total) > ARTIFACT_RATIO * (vocab[b] / subs_total)}
    totals: collections.Counter = collections.Counter()
    by_prev: dict[str, list[tuple[str, int]]] = collections.defaultdict(list)
    for (a, b), c in pairs.items():
        totals[a] += c
        if c >= MIN_PAIR_COUNT and b not in artifacts:
            by_prev[a].append((b, c))
    rows = []
    for a, nexts in by_prev.items():
        nexts.sort(key=lambda x: -x[1])
        rows.append((a, "*", totals[a]))
        rows.extend((a, b, c) for b, c in nexts[:PAIRS_PER_WORD])
    return rows, sorted(artifacts, key=lambda b: -seen[b])


def write(path: Path, lines: list[str]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    tmp.replace(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", action="append", choices=sorted(LANGS))
    ap.add_argument("--keep", type=int, default=KEEP_WORDS)
    ap.add_argument("--out-dir", type=Path, default=DATA)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for lang in args.lang or LANGS:
        counts = build_words(lang, args.keep)
        words = list(counts)
        pairs, artifacts = build_pairs(lang, counts)
        write(args.out_dir / f"words-{lang}.txt", words)
        write(args.out_dir / f"pairs-{lang}.tsv", [f"{a}\t{b}\t{c}" for a, b, c in pairs])
        print(f"{lang}: {len(words)} words, {len(pairs)} pairs; artifacts: {' '.join(artifacts[:25])}")


if __name__ == "__main__":
    main()
