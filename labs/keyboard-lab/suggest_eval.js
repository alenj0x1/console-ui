// Offline check of suggestion quality with the real Suggester: types each
// phrase without accents, letter by letter, and takes a suggestion as soon as
// the target word is in the top 3 (top 1 = RT, others = up + A). With nothing
// typed yet, a predicted next word counts too.
//
// Usage: node suggest_eval.js [lang ...] [--w '{"userWord":0.02}']  (default: es)
// Prints a fresh run and a second pass after learning the first one.
const fs = require("fs");
const path = require("path");
const { Suggester, fold, START } = require("../../app/ui/suggest.js");

const data = process.env.SUGGEST_DATA || path.join(__dirname, "../../app/ui/data");
const args = process.argv.slice(2);
const wi = args.indexOf("--w");
const weights = wi >= 0 ? JSON.parse(args.splice(wi, 2)[1]) : {};
const langs = args.length ? args : ["es"];
const phrases = fs.readFileSync(path.join(__dirname, "eval-phrases.txt"), "utf8").split(/\r?\n/).filter(Boolean);

const s = new Suggester(weights);
for (const lang of langs)
  s.addLanguage(lang, fs.readFileSync(`${data}/words-${lang}.txt`, "utf8"), fs.readFileSync(`${data}/pairs-${lang}.tsv`, "utf8"));

function run(learn) {
  let letters = 0, actions = 0, top1 = 0, total = 0, ms = 0;
  const missed = [];
  for (const phrase of phrases) {
    let prev = START;
    for (const w of phrase.split(" ")) {
      total++;
      letters += w.length + 1;
      const plain = fold(w);
      let done = false;
      for (let k = 0; k <= w.length; k++) {
        const t = performance.now();
        const at = s.suggest(prev, plain.slice(0, k)).indexOf(w);
        ms = Math.max(ms, performance.now() - t);
        if (at >= 0) {
          actions += k + (at === 0 ? 1 : 2);
          if (at === 0) top1++;
          done = true;
          break;
        }
      }
      if (!done) {
        actions += w.length + 1;
        if (plain !== w) missed.push(w);
      }
      if (learn) s.learn(prev, w);
      prev = w;
    }
  }
  return { saving: +(1 - actions / letters).toFixed(3), top1: +(top1 / total).toFixed(3), slowest_ms: +ms.toFixed(1), missedAccents: missed };
}

const noLearn = run(false);
console.log(JSON.stringify({ langs, weights, noLearn, fresh: run(true), learned: run(false) }));
