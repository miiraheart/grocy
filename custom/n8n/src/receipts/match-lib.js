// Match an abbreviated receipt label to a Grocy product.
// products: [{ id, name, userfields: { receipt_aliases: "KEY1\nKEY2" } }]

const ABBREV = {
  SS: 'SANS', 'S/': 'SANS', GLUT: 'GLUTEN', CHOC: 'CHOCOLAT', CHOCO: 'CHOCOLAT', LT: 'LAIT', FROM: 'FROMAGE',
  CR: 'CREME', CREM: 'CREME', FRAI: 'FRAIS', FRAICH: 'FRAICHE', EPAIS: 'EPAISSE', ECR: 'ECREME', NR: 'NOIR',
  BLC: 'BLANC', MLU: 'MOULE', MOUL: 'MOULE', DX: 'DOUX', PRUN: 'PRUNEAUX', CHEV: 'CHEVRE', PTIT: 'PETIT',
  PT: 'PETIT', BISC: 'BISCUIT', YAO: 'YAOURT', YRT: 'YAOURT', CONF: 'CONFITURE', LEG: 'LEGUMES',
  NAT: 'NATURE', SCE: 'SAUCE', HLE: 'HUILE', JB: 'JAMBON', PDT: 'POMME DE TERRE', VEG: 'VEGETAL',
  OEUF: 'OEUFS', BEUR: 'BEURRE', MASCARP: 'MASCARPONE', EMMENT: 'EMMENTAL', LACT: 'LACTOSE',
};
const STOP = new Set(['DE', 'DU', 'DES', 'LA', 'LE', 'LES', 'AU', 'AUX', 'ET', 'A', 'D', 'L', 'EN', 'X']);
const SIZE = /\b(\d+(?:[.,]\d+)?)\s*(G|GR|KG|CL|ML|L|P|PCS|X\d+)\b|\bX\s?\d+\b|\b\d+X\d*\b/g;

function normalizeLabel(label) {
  const base = label.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/Œ/g, 'OE').replace(/[’'`]/g, ' ').replace(/[^A-Z0-9/., ]/g, ' ');
  const sizes = (base.match(SIZE) || []).map((s) => s.replace(/\s|,/g, '').replace('GR', 'G'));
  const words = base.replace(SIZE, ' ').replace(/[./,]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/0/g, 'O'))                 // OCR "CH0C0" -> "CHOCO"
    .filter((w) => w && !/^\d+$/.test(w))
    .flatMap((w) => (ABBREV[w] || w).split(' '))
    .filter((w) => !STOP.has(w));
  return { key: words.join(' '), words, sizes };
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++)
    if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0; while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

const trigrams = (s) => { const g = new Set(); const t = `  ${s} `; for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
function trigramDice(a, b) {
  const A = trigrams(a), B = trigrams(b); let n = 0; for (const g of A) if (B.has(g)) n++;
  return (2 * n) / (A.size + B.size || 1);
}

// Each receipt word finds its best partner in the product name (receipt words are prefixes or truncations).
function tokenScore(rw, pw) {
  if (!rw.length || !pw.length) return 0;
  const per = rw.map((r) => Math.max(...pw.map((p) => (p.startsWith(r) && r.length >= 3 ? 0.97 : jaroWinkler(r, p)))));
  return per.reduce((s, x) => s + x, 0) / per.length;
}

function matchLabel(label, products, { threshold = 0.82, margin = 0.05 } = {}) {
  const n = normalizeLabel(label);
  for (const p of products) {
    const aliases = (p.userfields?.receipt_aliases || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (aliases.includes(n.key)) return { product_id: p.id, score: 1, method: 'alias', key: n.key, candidates: [] };
  }
  const scored = products.map((p) => {
    const pn = normalizeLabel(p.name);
    const s = 0.6 * tokenScore(n.words, pn.words) + 0.4 * trigramDice(n.key, pn.key)
      + (n.sizes.length && n.sizes.some((z) => pn.sizes.includes(z)) ? 0.05 : 0);
    return { product_id: p.id, name: p.name, score: Math.round(Math.min(1, s) * 1000) / 1000 };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const auto = best && best.score >= threshold && (!second || best.score - second.score >= margin);
  return { product_id: auto ? best.product_id : null, score: best?.score ?? 0, method: auto ? 'fuzzy' : 'needs_confirmation', key: n.key, candidates: scored.slice(0, 5) };
}
