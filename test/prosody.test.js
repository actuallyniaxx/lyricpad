// Run with: node test/prosody.test.js
const P = require('../renderer/prosody.js');
let fail = 0, n = 0;
const eq = (name, got, want) => { n++; if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };

// --- syllables per word
const syl = { casa: 2, garito: 3, mierda: 2, buenas: 2, país: 2, día: 2, aire: 2, ciudad: 2, poeta: 3, héroe: 3, queso: 2,
  guitarra: 3, pingüino: 3, averigüéis: 4, hoy: 1, rey: 1, estoy: 2, buey: 1, ahora: 3, prohibir: 2, búho: 2, alcohol: 3,
  murciélago: 4, rápido: 3, canción: 2, río: 2, reír: 2, leído: 3, aéreo: 4, cuando: 2, y: 1, flipaos: 3, volteretas: 4,
  guion: 1, paraguas: 3, ahumar: 2, yo: 1, playa: 2, oído: 3, caos: 2, teatro: 3, ruido: 2, viuda: 2 };
for (const [w, s] of Object.entries(syl)) eq(`syl ${w}`, P.analyzeWord(w).syl, s);

// --- stress + rhyme keys
const keys = { garito: ['ito', 'io'], malas: ['alas', 'aa'], bakalas: ['alas', 'aa'], verlo: ['erlo', 'eo'], serlo: ['erlo', 'eo'],
  canción: ['on', 'o'], corazón: ['on', 'o'], pájaro: ['ajaro', 'ao'], árbol: ['arbol', 'ao'], reloj: ['oj', 'o'],
  vivo: ['ibo', 'io'], recibo: ['ibo', 'io'], calle: ['aye', 'ae'], raye: ['aye', 'ae'], hace: ['aze', 'ae'], queso: ['eso', 'eo'],
  bueno: ['eno', 'eo'], estoy: ['oi', 'o'], guerra: ['era', 'ea'], gente: ['ente', 'ee'], jefe: ['efe', 'ee'], murciélago: ['elago', 'eo'] };
for (const [w, [c, a]] of Object.entries(keys)) { const r = P.analyzeWord(w); eq(`cons ${w}`, r.cons, c); eq(`asso ${w}`, r.asso, a); }

// --- syllables per line (with sinalefa)
const lines = {
  'En un lugar de la Mancha': 8,
  'de cuyo nombre no quiero acordarme': 11,
  'al garito ese de mierda, por las buenas, por las malas': 16,
  'que seguir siendo un garito sin saber serlo': 13,
  'mi amor está aquí': 5,          // mia-mor-es-táa-quí
  'Para. ¿Y ahora?': 5,            // strong punctuation blocks the first merge: pa-ra | ya-ho-ra
  'tú y yo': 2,                    // tuy-yo
};
for (const [l, s] of Object.entries(lines)) eq(`line "${l}"`, P.analyzeLine(l).syl, s);

// --- rhyme detection
const song = [
  'al garito ese de mierda, por las buenas, por las malas',
  'volteretas de flipaos, no me pueden, vais a verlo',
  'mejor volver a ser un garito de bakalas',
  'que seguir siendo un garito de hip-hop sin saber serlo',
  '',
  '[Estribillo]',
  'la noche es larga y el camino corto',
  'la calle me habla pero no la escucho',
  'la noche es larga y el camino corto',
].join('\n');
const A = P.analyze(song);
const L = A.lines;
eq('group 0/2', [L[0].group, L[2].group], ['aa', 'aa']);
eq('kind malas/bakalas', [L[0].kind, L[2].kind], ['cons', 'cons']);
eq('group 1/3', [L[1].group, L[3].group], ['eo', 'eo']);
eq('kind verlo/serlo', L[1].kind, 'cons');
eq('scheme', L.slice(0, 4).map((l) => l.letter).join(''), 'ABAB');
eq('label ignored', [L[5].label, L[5].syl, L[5].letter], [true, 0, '']);
eq('repeated word', [L[6].kind, L[8].kind], ['rep', 'rep']);
eq('no rhyme', L[7].letter, '–');
// multisyllabic: "saber serlo" / "a verlo" share e-e-o → extension before the stressed vowel
eq('depth verlo/serlo', [L[1].depth >= 2, L[3].depth >= 2], [true, true]);
// internal rhyme: "garito" inside lines does not match aa/eo, so no internal marks expected on it
eq('ranges sorted', L.every((l) => l.ranges.every((r, i, a) => !i || a[i - 1].start <= r.start)), true);

// assonance only
const B = P.analyze('me quedo en casa\ncon toda mi rabia\nhoy no pasa nada').lines;
eq('asso group', [B[0].group, B[1].group, B[2].group], ['aa', 'aa', 'aa']);
eq('asso kind casa/rabia', B[1].kind, 'asso');
eq('internal "pasa"', B[2].ranges.some((r) => r.cls === 'int'), true);

// full-verse rhyme
const C = P.analyze('tengo la pena negra\nvengo la cena lenta').lines;
eq('full verse', [C[0].full, C[1].full], [true, true]);

console.log(fail ? `${fail} of ${n} FAILED` : `all ${n} passed`);
process.exit(fail ? 1 : 0);
