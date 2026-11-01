// Word suggestions for the on-screen keyboard.
//
// Matching ignores accents ("esta" offers "está", "ano" offers "año"). Ranking
// mixes, per enabled language, how common a word is with how often it follows
// the previous word, plus what this user has typed before. With nothing typed
// yet it predicts the next word.

const fold = (w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Start of a sentence, as written in pairs-<lang>.tsv.
const START = "^";
const MAX_LEARNED_WORD = 32;
const WEIGHTS = {
  // "follows the previous word" against "is a common word".
  context: 0.95,
  // Learned words the dictionaries lack (names, slang): typed a few times,
  // they rank like a very common word. Known words learn through pairs.
  userWord: 0.02,
  // Uses before a learned word (or pair) counts at half weight.
  userHalf: 5,
  userPair: 2,
};

class Suggester {
  constructor(weights = {}) {
    this.k = { ...WEIGHTS, ...weights };
    this.langs = new Map();
    this.user = { words: new Map(), pairs: new Map(), totals: new Map() };
  }

  addLanguage(lang, wordsText, pairsText) {
    const words = wordsText.split(/\r?\n/).filter(Boolean);
    const rank = new Map(words.map((w, i) => [w, i]));
    let harmonic = 0;
    for (let i = 1; i <= words.length; i++) harmonic += 1 / i;
    const follow = new Map();
    const totals = new Map();
    for (const line of pairsText.split(/\r?\n/)) {
      const [a, b, c] = line.split("\t");
      if (!c) continue;
      if (b === "*") totals.set(a, +c);
      else {
        if (!follow.has(a)) follow.set(a, new Map());
        follow.get(a).set(b, +c);
      }
    }
    this.langs.set(lang, { words, folded: words.map(fold), rank, harmonic, follow, totals });
  }

  removeLanguage(lang) {
    this.langs.delete(lang);
  }

  setLearned({ words = {}, pairs = {} } = {}) {
    this.user = { words: new Map(Object.entries(words)), pairs: new Map(), totals: new Map() };
    for (const [key, c] of Object.entries(pairs)) this.addPair(key, c);
  }

  addPair(key, c) {
    const [a, b] = key.split(" ");
    if (!this.user.pairs.has(a)) this.user.pairs.set(a, new Map());
    const m = this.user.pairs.get(a);
    m.set(b, (m.get(b) || 0) + c);
    this.user.totals.set(a, (this.user.totals.get(a) || 0) + c);
  }

  static learnable(word) {
    return word.length > 0 && word.length <= MAX_LEARNED_WORD && /^\p{L}+$/u.test(word);
  }

  // Records a finished word; returns false if it is not something to learn.
  learn(prev, word) {
    const w = word.toLowerCase();
    if (!Suggester.learnable(w)) return false;
    this.user.words.set(w, (this.user.words.get(w) || 0) + 1);
    this.addPair(`${prev || START} ${w}`, 1);
    return true;
  }

  score(prev, w) {
    let s = 0;
    let known = false;
    for (const L of this.langs.values()) {
      const r = L.rank.get(w);
      known ||= r !== undefined;
      const common = r === undefined ? 0 : 1 / (r + 1) / L.harmonic;
      const total = L.totals.get(prev);
      const after = total ? (L.follow.get(prev)?.get(w) || 0) / total : 0;
      s += this.k.context * after + (1 - this.k.context) * common;
    }
    const uc = known ? 0 : this.user.words.get(w) || 0;
    s += this.k.userWord * (uc / (uc + this.k.userHalf));
    const ut = this.user.totals.get(prev);
    // Shrunk while there is little history after `prev`.
    if (ut) s += this.k.userPair * ((this.user.pairs.get(prev)?.get(w) || 0) / (ut + this.k.userHalf));
    return s;
  }

  // Up to `n` suggestions for the word being typed after `prev` (a word, or
  // START at the beginning of a sentence, or "" when unknown).
  suggest(prev, typed, n = 3) {
    prev = (prev || "").toLowerCase();
    const key = fold(typed);
    const lower = typed.toLowerCase();
    const candidates = new Set();
    if (!key) {
      if (!prev) return [];
      for (const L of this.langs.values()) for (const w of L.follow.get(prev)?.keys() || []) candidates.add(w);
      for (const w of this.user.pairs.get(prev)?.keys() || []) candidates.add(w);
    } else {
      for (const L of this.langs.values())
        for (let i = 0; i < L.words.length; i++) if (L.folded[i].startsWith(key)) candidates.add(L.words[i]);
      for (const w of this.user.words.keys()) if (fold(w).startsWith(key)) candidates.add(w);
    }
    candidates.delete(lower);
    // Same word with accents first, then by score.
    const ranked = [...candidates]
      .map((w) => ({ w, same: key && fold(w).length === key.length, s: this.score(prev, w) }))
      .sort((a, b) => b.same - a.same || b.s - a.s)
      .slice(0, n)
      .map((x) => x.w);
    const capital = typed && typed[0] !== typed[0].toLowerCase();
    return ranked.map((w) => (capital ? w[0].toUpperCase() + w.slice(1) : w));
  }
}

if (typeof module !== "undefined") module.exports = { Suggester, fold, START };
