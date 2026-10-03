// Spanish prosody engine for Lyricpad: syllables, stress and rhyme detection.
//
// Everything here is plain text analysis, no dictionary and no network. It
// follows Spanish spelling rules, so it is accurate for Spanish and only a
// rough guess for other languages.
//
// Works both in the renderer (window.Prosody) and in Node (module.exports).

(function (root) {
  'use strict';

  const STRONG = 'aeoáéó';
  const ACCENTED = 'áéíóú';
  const BASE = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', y: 'i' };
  const isVowelChar = (c) => 'aeiouáéíóúü'.includes(c);
  const base = (c) => BASE[c] || c;

  // Very common words that would "rhyme" with half the song. Ignored when
  // looking for internal rhymes (never at the end of a line).
  const STOP = new Set(
    (
      'para pero como cuando donde desde hasta entre sobre porque aunque este esta estos estas ese esa esos esas ' +
      'aquel aquella una uno unos unas ella ellos ellas otro otra otros otras todo toda todos todas cada mismo misma ' +
      'tengo tiene tienes tienen estoy estas estan estamos somos eres era eran fue fui hay hace hacen quiero quiere ' +
      'puedo puede algo nada nadie mucho mucha muy mas menos tanto tanta solo sino pues luego antes ahora siempre nunca ' +
      'aqui ahi alli alla ante bajo contra hacia segun tras mientras tambien tampoco quien cual cuyo cuya suyo suya ' +
      'nuestro nuestra vuestro vuestra ello'
    ).split(' ')
  );

  // Words that carry no stress of their own in speech (articles, short
  // prepositions, conjunctions, clitic pronouns, possessives). With a written
  // accent (tú, mí, qué, más) they are different words and do carry stress.
  const UNSTRESSED = new Set(
    (
      'el la los las lo un unos unas al del de a en con por para sin sobre tras desde hasta entre hacia ante bajo ' +
      'y e o u ni que pero mas sino si porque aunque pues como cuando donde mientras ' +
      'me te se nos os le les mi mis tu tus su sus nuestro nuestra nuestros nuestras vuestro vuestra tan medio'
    ).split(' ')
  );

  // lower case, no accent marks
  const plain = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ---------- Word level ----------

  // Vowel nuclei of a word, in order. Each nucleus is one syllable.
  // { v: main vowel (a/e/i/o/u), pos: index of the main vowel in the word, accented }
  function nuclei(wordRaw) {
    const w = wordRaw.toLowerCase();
    const n = w.length;
    const vowels = []; // { c, i }
    for (let i = 0; i < n; i++) {
      const c = w[i];
      const prev = w[i - 1];
      const next = w[i + 1];
      if (isVowelChar(c)) {
        // silent u in que/qui/gue/gui
        if (c === 'u' && (prev === 'q' || (prev === 'g' && next && 'eiéí'.includes(next)))) continue;
        vowels.push({ c, i });
      } else if (c === 'y' && (n === 1 || i === n - 1)) {
        vowels.push({ c: 'y', i }); // "y", "hoy", "rey": sounds like i
      }
    }

    const out = [];
    let group = null;
    const close = () => {
      if (!group) return;
      let main = group.find((x) => ACCENTED.includes(x.c)) || group.find((x) => STRONG.includes(x.c));
      if (!main) main = group[group.length - 1]; // weak + weak: the second one carries it
      out.push({ v: base(main.c), pos: main.i, accented: group.some((x) => ACCENTED.includes(x.c)) });
      group = null;
    };

    for (let k = 0; k < vowels.length; k++) {
      const cur = vowels[k];
      const prev = vowels[k - 1];
      // Vowels are in the same run when adjacent, or separated only by a silent h
      const adjacent = prev && (cur.i === prev.i + 1 || (cur.i === prev.i + 2 && w[prev.i + 1] === 'h'));
      if (!group || !adjacent) {
        close();
        group = [cur];
        continue;
      }
      const p = prev.c;
      const c = cur.c;
      const hiatus =
        p === 'í' || p === 'ú' || c === 'í' || c === 'ú' || // accented weak vowel always breaks
        (STRONG.includes(c) && group.some((x) => STRONG.includes(x.c))); // two strong vowels
      if (hiatus) {
        close();
        group = [cur];
      } else {
        group.push(cur);
      }
    }
    close();
    return out;
  }

  // Index (into nuclei) of the stressed syllable
  function stressIndex(wordRaw, nuc) {
    if (nuc.length <= 1) return 0;
    const acc = nuc.findIndex((x) => x.accented);
    if (acc !== -1) return acc;
    const last = wordRaw.toLowerCase().slice(-1);
    // ends in vowel, n or s: stress on the second-to-last syllable
    return 'aeiouns'.includes(last) ? nuc.length - 2 : nuc.length - 1;
  }

  // How the end of a word sounds, written with one symbol per sound
  // (b=v, ll=y, silent h, c/z, g/j, qu=k...). Used for perfect rhyme.
  function phonetic(s) {
    const w = s.toLowerCase();
    let out = '';
    for (let i = 0; i < w.length; i++) {
      const c = w[i];
      const next = w[i + 1] || '';
      const soft = next !== '' && 'eiéí'.includes(next);
      if (c === 'h') {
        if (w[i - 1] === 'c') out += 'C'; // ch
        continue;
      }
      if (c === 'c') {
        if (next === 'h') continue; // emitted by the h
        out += soft ? 'z' : 'k';
      } else if (c === 'q') {
        out += 'k';
        if (next === 'u') i++;
      } else if (c === 'g') {
        if (next === 'u' && w[i + 2] && 'eiéí'.includes(w[i + 2])) {
          out += 'g';
          i++;
        } else out += soft ? 'j' : 'g';
      } else if (c === 'v') out += 'b';
      else if (c === 'l' && next === 'l') {
        out += 'y';
        i++;
      } else if (c === 'x') out += 'ks';
      else if (c === 'y') out += i === w.length - 1 ? 'i' : 'y';
      else out += base(c);
    }
    return out.replace(/(.)\1+/g, '$1');
  }

  function analyzeWord(wordRaw) {
    const nuc = nuclei(wordRaw);
    if (!nuc.length) return { syl: 0, nuc, stress: -1, cons: '', asso: '' };
    const s = stressIndex(wordRaw, nuc);
    const tail = nuc.slice(s).map((x) => x.v);
    // In words stressed three or more syllables from the end, only the
    // stressed vowel and the last one count for assonance (PÁ-ja-ro ~ a-o)
    const asso = tail.length > 2 ? tail[0] + tail[tail.length - 1] : tail.join('');
    return { syl: nuc.length, nuc, stress: s, cons: phonetic(wordRaw.slice(nuc[s].pos)), asso };
  }

  // ---------- Line level ----------

  const WORD_RE = /[\p{L}]+(?:['’][\p{L}]+)*/gu;

  function analyzeLine(text) {
    const words = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      const a = analyzeWord(m[0]);
      words.push({ text: m[0], start: m.index, end: m.index + m[0].length, ...a });
    }

    // Syllables as actually pronounced: vowels meeting across a word boundary
    // merge into one (sinalefa), unless strong punctuation sits in between.
    let syl = 0;
    const seq = []; // every syllable of the line: { v, at: char index in the line, w: word index }
    // Spoken syllables with their stress, for the rhythm pattern:
    // { at: char index of the vowel, stressed }. Merged vowels count once.
    const beats = [];
    let merge = false; // the previous word ended in a vowel that joins this one
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      syl += w.syl;
      w.nuc.forEach((x) => seq.push({ v: x.v, at: w.start + x.pos, w: i }));
      const tonic = !UNSTRESSED.has(w.text.toLowerCase());
      w.nuc.forEach((x, k) => {
        const b = { at: w.start + x.pos, stressed: tonic && k === w.stress };
        if (k === 0 && merge && beats.length) {
          const prev = beats[beats.length - 1];
          // one syllable for both vowels: stressed if either is, drawn under the stressed one
          if (b.stressed || !prev.stressed) prev.at = b.at;
          prev.stressed = prev.stressed || b.stressed;
        } else beats.push(b);
      });
      merge = false;
      const nx = words[i + 1];
      if (!nx || !w.syl || !nx.syl) continue;
      const between = text.slice(w.end, nx.start);
      if (/[.;:!?¡¿…—–()"«»]/.test(between)) continue;
      const lw = w.text.toLowerCase();
      const ln = nx.text.toLowerCase();
      const endsVowel = isVowelChar(lw.slice(-1)) || (lw.slice(-1) === 'y' && w.nuc.length > 0);
      const startsVowel = isVowelChar(ln[0]) || (ln[0] === 'h' && isVowelChar(ln[1] || '')) || ln === 'y';
      if (endsVowel && startsVowel) {
        syl--;
        merge = true;
      }
    }

    let last = -1;
    for (let i = words.length - 1; i >= 0; i--) {
      if (words[i].syl) {
        last = i;
        break;
      }
    }
    return { words, syl: Math.max(syl, 0), seq, beats, last };
  }

  // Lines that are labels, not lyrics: [Chorus], (x2), # note
  const isLabel = (t) => /^\s*(\[.*\]|\(.*\)|#.*|\/\/.*)\s*$/.test(t);

  // ---------- Whole text ----------

  // opts: { window: how many lyric lines away a rhyme partner can be, internal: boolean }
  function analyze(text, opts) {
    const o = { window: 6, internal: true, ...(opts || {}) };
    const raw = text.split('\n');
    const lines = raw.map((t, i) => {
      const label = isLabel(t);
      const a = label || !t.trim() ? { words: [], syl: 0, seq: [], beats: [], last: -1 } : analyzeLine(t);
      return {
        i,
        text: t,
        blank: !t.trim(),
        label,
        syl: a.syl,
        words: a.words,
        seq: a.seq,
        beats: a.beats,
        repeats: [], // { start, end, key, count }: words used again and again
        end: a.last >= 0 ? a.words[a.last] : null,
        endIdx: a.last,
        group: null, // rhyme key shared with nearby lines
        kind: null, // 'cons' | 'asso' | 'rep'
        depth: 0, // how many syllables rhyme, counted from the end
        full: false, // the whole line rhymes with another one
        letter: '',
        ranges: [], // { start, end, cls, key }
      };
    });

    // Order among lyric lines only, so blank lines and labels don't eat window
    const lyric = lines.filter((l) => l.end);
    lyric.forEach((l, k) => (l.k = k));
    // Stanza number: goes up on every blank line or label
    let stanza = 0;
    for (const l of lines) {
      if (l.blank || l.label) stanza++;
      l.stanza = stanza;
    }

    // 1) End rhymes: same vowels from the stressed syllable on, close enough
    for (const l of lyric) {
      const partners = [];
      for (let k = Math.max(0, l.k - o.window); k <= Math.min(lyric.length - 1, l.k + o.window); k++) {
        if (k !== l.k && lyric[k].end.asso === l.end.asso) partners.push(lyric[k]);
      }
      if (!partners.length) continue;
      l.group = l.end.asso;
      const word = phonetic(l.end.text);
      const others = partners.filter((p) => phonetic(p.end.text) !== word);
      if (!others.length) l.kind = 'rep'; // only "rhymes" with the very same word
      else l.kind = others.some((p) => p.end.cons === l.end.cons) ? 'cons' : 'asso';

      // How far back the match goes: compare syllable vowels from the end
      let best = 0;
      let full = false;
      for (const p of partners) {
        let d = 0;
        while (
          d < l.seq.length &&
          d < p.seq.length &&
          l.seq[l.seq.length - 1 - d].v === p.seq[p.seq.length - 1 - d].v
        )
          d++;
        if (d > best) best = d;
        const shorter = Math.min(l.seq.length, p.seq.length);
        if (d >= shorter && shorter >= 4 && l.text.trim().toLowerCase() !== p.text.trim().toLowerCase()) full = true;
      }
      l.depth = best;
      l.full = full;
    }

    // 2) Highlight ranges for end rhymes
    for (const l of lyric) {
      if (!l.group) continue;
      const w = l.end;
      const stressAt = w.start + w.nuc[w.stress].pos;
      const baseSyl = w.nuc.length - w.stress; // syllables covered by the plain rhyme
      // Multisyllabic part: syllables before the stressed one that also match
      if (l.kind !== 'rep' && l.depth > baseSyl) {
        const first = l.seq[l.seq.length - l.depth];
        if (first && first.at < stressAt) {
          // If the match begins on the first syllable of a word, take the whole word
          const fw = l.words[first.w];
          const from = fw.nuc[0] && fw.start + fw.nuc[0].pos === first.at ? fw.start : first.at;
          l.ranges.push({ start: from, end: stressAt, cls: 'ext', key: l.group });
        }
      }
      l.ranges.push({ start: stressAt, end: w.end, cls: l.kind, key: l.group });
    }

    // 3) Internal rhymes: words inside a line that share the sound of a
    //    line ending one or two lines around it, within the same stanza
    if (o.internal) {
      for (const l of lyric) {
        const near = new Set();
        for (let k = Math.max(0, l.k - 2); k <= Math.min(lyric.length - 1, l.k + 2); k++) {
          if (lyric[k].group && lyric[k].stanza === l.stanza) near.add(lyric[k].group);
        }
        if (!near.size) continue;
        l.words.forEach((w, wi) => {
          if (wi === l.endIdx || w.syl < 2 || w.asso.length < 2) return;
          if (STOP.has(plain(w.text))) return;
          if (!near.has(w.asso)) return;
          const start = w.start + w.nuc[w.stress].pos;
          if (l.ranges.some((r) => start < r.end && w.end > r.start)) return; // already covered
          l.ranges.push({ start, end: w.end, cls: 'int', key: w.asso });
        });
      }
    }
    lines.forEach((l) => l.ranges.sort((a, b) => a.start - b.start));

    // 4) Rhyme scheme letters, restarting on every stanza (blank line)
    let map = new Map();
    for (const l of lines) {
      if (l.blank) {
        map = new Map();
        continue;
      }
      if (!l.end) continue;
      if (!l.group) {
        l.letter = '–';
        continue;
      }
      if (!map.has(l.group)) map.set(l.group, String.fromCharCode(65 + (map.size % 26)));
      l.letter = map.get(l.group);
    }

    // 5) A stable colour per sound across the whole text
    const colors = new Map();
    for (const l of lines) {
      for (const r of l.ranges) if (!colors.has(r.key)) colors.set(r.key, colors.size % 8);
    }
    lines.forEach((l) => l.ranges.forEach((r) => (r.color = colors.get(r.key))));

    // 6) Repeated words: the same word three or more times in the song, or
    //    twice almost in a row. Lines repeated whole (a chorus sung twice)
    //    count once, and filler words don't count at all.
    const repeated = new Map();
    {
      const fold = (w) => {
        const p = plain(w);
        return p.length > 4 && p.endsWith('s') ? p.slice(0, -1) : p; // garitos = garito
      };
      const seenLines = new Set();
      const uses = new Map(); // key -> [{ l, w }]
      for (const l of lyric) {
        const whole = plain(l.text).replace(/[^a-z0-9ñ]+/g, ' ').trim();
        if (seenLines.has(whole)) continue;
        seenLines.add(whole);
        for (const w of l.words) {
          const key = fold(w.text);
          if (key.length < 4 || STOP.has(key) || STOP.has(plain(w.text)) || UNSTRESSED.has(key)) continue;
          if (!uses.has(key)) uses.set(key, []);
          uses.get(key).push({ l, w });
        }
      }
      for (const [key, list] of uses) {
        if (list.length < 2) continue;
        const close = list.some((u, i) => i > 0 && u.l.k - list[i - 1].l.k <= 2);
        if (list.length < 3 && !close) continue;
        repeated.set(key, list.length);
        for (const u of list) u.l.repeats.push({ start: u.w.start, end: u.w.end, key, count: list.length });
      }
    }

    const rhymed = lyric.filter((l) => l.group && l.kind !== 'rep').length;
    return {
      lines,
      repeated,
      stats: {
        lyricLines: lyric.length,
        rhymed,
        density: lyric.length ? rhymed / lyric.length : 0,
        avgSyl: lyric.length ? lyric.reduce((s, l) => s + l.syl, 0) / lyric.length : 0,
      },
    };
  }

  const api = { analyze, analyzeLine, analyzeWord, nuclei, phonetic };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Prosody = api;
})(typeof window !== 'undefined' ? window : globalThis);
