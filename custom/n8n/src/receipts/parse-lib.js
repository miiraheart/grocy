// Pure regex parser for French supermarket receipts (raw OCR text in, schema v1 JSON out).
// No model, no network. Works in browsers, Node and JavaScriptCore.

const STORES = [
  ['E.Leclerc', /\bE\.?\s?LECLERC\b/], ['Carrefour', /\bCARREFOUR\b|\bCRF[- ]CITY\b/],
  ['Monoprix', /\bMONOPRIX\b/], ['Intermarché', /\bINTERMARCH[EÉ]\b/], ['Lidl', /\bLIDL\b/],
  ['Biocoop', /\bBIOCOOP\b/], ['La Vie Claire', /\bLA VIE CLAIRE\b/], ['Naturalia', /\bNATURALIA\b/],
  ['Auchan', /\bAUCHAN\b|\bSIMPLY\b/], ['Aldi', /\bA\s?L\s?D\s?I\b/], ['Super U', /\b(SUPER|HYPER|MARCHE) U\b|\bU EXPRESS\b/],
  ['Franprix', /\bFRANPRIX\b/], ['Casino', /\bCASINO\b/], ['Picard', /\bPICARD\b/], ['Grand Frais', /\bGRAND FRAIS\b/],
];
const MONTHS = { janv: 1, janvier: 1, fevr: 2, fevrier: 2, mars: 3, avr: 4, avril: 4, mai: 5, juin: 6, juil: 7, juillet: 7,
  aout: 8, sept: 9, septembre: 9, oct: 10, octobre: 10, nov: 11, novembre: 11, dec: 12, decembre: 12 };

const AMOUNT = String.raw`-?\s?\d{1,4}[.,]\d{2}`;
// The VAT code after a price is a letter or digits, bare ("3,95 1") or in brackets as on Biocoop tickets ("3,95 (1)").
const VAT_CODE = String.raw`(?:\s*\(([A-Z]|\d{1,2})\)|\s+([A-Z]|\d{1,2}))?`;
const TAIL = new RegExp(String.raw`(${AMOUNT})\s*(?:€|EUR|E)?\s*\*?${VAT_CODE}\s*$`);
const QTY_LINE = new RegExp(String.raw`^(\d{1,3})\s*x\s*(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?(?:\s+(${AMOUNT}))?\s*(?:€|EUR)?${VAT_CODE}\s*$`, 'i');
const WEIGHT_LINE = new RegExp(String.raw`^(\d{1,3}[.,]\d{1,4})\s*kg\s*x\s*(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?\s*/\s*kg(?:\s+(${AMOUNT}))?`, 'i');
const INLINE_QTY = /^(.*\S)\s+(\d{1,3})\s*x\s*(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?\s*$/i;
const COLUMN_QTY = /^(.*[A-Za-z].*\S)\s+(\d{1,3}(?:[.,]\d{1,3})?)\s+(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?$/i;  // "LAIT 2 1,69 3,38"
const PRICE_INSIDE = /\d[.,]\d{2}\b/;

const FINAL_TOTAL = /(\bA\s?PAYER\b|\bMONTANT\s+DU\b|\bNET\s+A\s+PAYER\b|\bTOTAL\s+AVEC\s+AVANTAGES\b|^=?\s*T\s?[O0]\s?T\s?A\s?L\b(?!\s+(ACHATS|ALIMENTAIRE|NON|DES|REMISES|AVANT|POINTS|AVANTAGES|TVA|HT|ELIGIBLE))|^TOTAL\s*(€|EUR)|\bTOTAL\s+\d+\s+ARTICLES?\b)/;
const SUBTOTAL = /\bTOTAL\b|\bSOUS[- ]TOTAL\b|\bEUR[*xX]?\s*TOT\b/;
const PAYMENT = /\b(CB|CARTE|CARTE BANCAIRE|CARTE BLEUE|CARTE CREDIT|EMV|SANS CONTACT|ESPECES|COMPTANT|CHEQUE|TICKET RESTO|TITRE RESTAURANT|TRD|RENDU|A RENDRE|RETOUR|MONNAIE|BON D.ACHAT|BON REDUCTION)\b/;
const POST_TOTAL_START = /\bTOTAL\s+(ACHATS|AVANT\s+REMISES?)\b|\bEUR[*xX]?\s*TOT\b|\bSOUS[- ]TOTAL\b/;
const PHONE = /\b0\d([ .]?\d{2}){4}\b/;
const DISCOUNT = /\b(REMISE|PROMO|AVANTAGE|REDUCTION|BON|COUPON|FIDELITE|IMMEDIATE|LOT|OFFRE)\b/;
const VAT_ROW = /^(?:\(([A-Z]|\d{1,2})\)\s*|([A-Z]|\d{1,2})\s+)?(?:T\.?V\.?A\.?\s+)?(\d{1,2}[.,]\d{1,2})\s*%\s+(?:TVA\s+DE\s+)?(\d+[.,]\d{2})\s+(\d+[.,]\d{2})(?:\s+(\d+[.,]\d{2}))?/;
const VAT_WORDS = /\bT\.?V\.?A\b|\bHT\b|\bTTC\b/;
const NOISE = /\b(TEL|T[EÉ]L[EÉ]PHONE|SIRET|SIREN|RCS|TVA\s+INTRA|NAF|WWW|HTTP|BIENVENUE|MERCI|HORAIRES?|OUVERT|LUNDI|MARDI|DIMANCHE|CAISSE|CAISSIER|VENDEUR|OPERATEUR|TICKET|NOMBRE|ARTICLES?\b|DESCRIPTION|DESIGNATION|QTE|MONTANT\s*€?$|SOLDE|CUMUL|POINTS|S.MILES|VIGNETTE|CONSERVER|GARANTIE)\b/;

function normalizeLine(raw) {
  return raw.normalize('NFC')
    .replace(/[хХ×]/g, 'x')        // Cyrillic x/X and multiplication sign from Apple Vision
    .replace(/(\d)\s*[*]\s*(?=\d)/g, '$1 x ')
    .replace(/(\d)[.,]\s(\d{2})\b/g, '$1.$2')      // "0. 42" -> "0.42"
    .replace(/(\d)\s?k[g9]\b/gi, '$1kg')           // "0.210 k9" -> "0.210kg"
    .replace(/\/\s?k[g9]\b/gi, '/kg')
    .replace(/(\d)%(\d{2})/g, '$1.$2%')            // Leclerc "5%50" -> "5.50%"
    .replace(/(\S)-\s(\d)/g, '$1 -$2')             // Monoprix "LABEL- 0,09" -> "LABEL -0,09"
    .replace(/\s+/g, ' ').trim();
}

const num = (s) => (s == null ? null : Number(String(s).replace(/\s/g, '').replace(',', '.')));
const round2 = (x) => Math.round(x * 100) / 100;
const up = (s) => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function parseDate(text) {
  const t = up(text);
  let m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/);
  let d, mo, y;
  if (m) [, d, mo, y] = m;
  else if ((m = t.match(/\b(\d{1,2})\s+([A-Z]{3,9})\.?\s+(\d{4})\b/)) && MONTHS[m[2].toLowerCase()]) { d = m[1]; mo = MONTHS[m[2].toLowerCase()]; y = m[3]; }
  else return null;
  y = String(y).length === 2 ? 2000 + Number(y) : Number(y);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  const tm = t.match(/\b([01]?\d|2[0-3])[:H](\d{2})(?::(\d{2}))?\b/);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return tm ? `${iso}T${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}` : iso;
}

function parseReceipt(rawText) {
  const lines = rawText.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const U = lines.map(up);
  const out = { schema: 'receipt/v1', store: null, date: null, currency: 'EUR', lines: [], totals: {}, vat: [], warnings: [], confidence: 0 };

  const letters = U.map((l) => l.replace(/0/g, 'O').replace(/1/g, 'I'));  // OCR digit/letter confusions in logos
  for (const [name, re] of STORES) if (U.some((l, i) => re.test(l) || re.test(letters[i]))) { out.store = name; break; }
  for (const l of U) { const d = parseDate(l); if (d && (!out.date || d.length > out.date.length)) out.date = d; if (out.date?.includes('T')) break; }

  // Final total: prefer the keyword line whose amount matches a payment line.
  const amountOf = (i) => { const m = U[i].match(TAIL); return m ? num(m[1]) : null; };
  const payments = U.map((l, i) => (PAYMENT.test(l) && !FINAL_TOTAL.test(l) ? amountOf(i) : null)).filter((x) => x != null && x > 0);
  const totalIdx = U.map((l, i) => (FINAL_TOTAL.test(l) && amountOf(i) > 0 ? i : -1)).filter((i) => i >= 0);
  let finalIdx = totalIdx.find((i) => payments.some((p) => Math.abs(p - amountOf(i)) < 0.011)) ?? totalIdx[totalIdx.length - 1] ?? -1;
  if (finalIdx >= 0) out.totals.total = amountOf(finalIdx);
  const postStart = U.findIndex((l) => POST_TOTAL_START.test(l));
  const firstTotal = postStart >= 0 && (finalIdx < 0 || postStart < finalIdx) ? postStart : finalIdx;
  out.totals.paid = payments.find((p) => Math.abs(p - (out.totals.total ?? -1)) < 0.011) ?? null;
  for (const u of U) {
    const vat = u.match(VAT_ROW);
    const code = vat ? vat[1] || vat[2] || null : null;
    if (vat && /%/.test(u) && !out.vat.some((v) => v.code === code)) out.vat.push({ code, rate: num(vat[3]) });
  }

  let pending = null;       // label seen without a price, waiting for a qty/weight line
  let inPostTotal = false;  // between first subtotal and final total: only discount details count
  const end = finalIdx >= 0 ? finalIdx : lines.length;
  let unparsed = 0;         // lines that show a price but became nothing: the regex missed a format, the model should look

  for (let i = 0; i < end; i++) {
    const L = lines[i], u = U[i];
    if (i >= firstTotal && firstTotal >= 0) inPostTotal = true;
    if (/%/.test(u) && (VAT_ROW.test(u) || VAT_WORDS.test(u))) continue;

    const w = L.match(WEIGHT_LINE);
    if (w && !inPostTotal) {
      const qty = num(w[1]), unitPrice = num(w[2]), total = w[3] != null ? num(w[3]) : round2(qty * unitPrice);
      const target = pending ?? (w[3] == null ? out.lines[out.lines.length - 1] : null);
      if (target && !target.is_discount) Object.assign(target, { qty, unit: 'kg', unit_price: unitPrice, total: target.total ?? total });
      else out.lines.push(item(pending?.label ?? '?', qty, 'kg', unitPrice, total, null, i));
      if (pending) { out.lines.push(pending); pending = null; }
      continue;
    }
    const q = L.match(QTY_LINE);
    if (q && !inPostTotal) {
      const qty = num(q[1]), unitPrice = num(q[2]), total = q[3] != null ? num(q[3]) : null;
      if (pending) { Object.assign(pending, { qty, unit_price: unitPrice, total: total ?? round2(qty * unitPrice) }); out.lines.push(pending); pending = null; }
      else if (out.lines.length) Object.assign(out.lines[out.lines.length - 1], { qty, unit_price: unitPrice });
      continue;
    }
    if (SUBTOTAL.test(u)) { const a = amountOf(i); if (a != null && a > 0 && POST_TOTAL_START.test(u) && out.totals.subtotal == null) out.totals.subtotal = a; continue; }
    const t = L.match(TAIL);
    const negative = t && num(t[1]) < 0;
    if (!(negative && (DISCOUNT.test(u) || !PAYMENT.test(u))) && (PAYMENT.test(u) || NOISE.test(u) || PHONE.test(u) || /^[>=*\s]+$/.test(L))) continue;

    if (!t) {
      if (!inPostTotal && /[A-Za-z]{2}/.test(L) && PRICE_INSIDE.test(L)) unparsed++;
      if (!inPostTotal && /[A-Za-z]{2}/.test(L) && !/^>+/.test(L) && i > 0 && looksLikeLabel(L, U[i + 1])) pending = item(L, 1, 'piece', null, null, null, i);
      continue;
    }
    const amount = num(t[1]);
    let label = L.slice(0, t.index).replace(/[\s.:*-]+$/, '').replace(/^[*>\s]+/, '');
    if (!/[A-Za-z]{2}/.test(label)) continue;
    const discountWord = /^(REMISE|PROMO|REDUC|AVANTAGE|BON|COUPON)/.test(up(label));
    if (amount < 0 || discountWord || (inPostTotal && DISCOUNT.test(up(label)))) {
      const d = { ...item(label, 1, 'piece', null, -Math.abs(amount), t[2] ?? t[3], i), is_discount: true };
      if (amount > 0) d.flags.push('sign_inferred');
      out.lines.push(d);
      continue;
    }
    if (inPostTotal) continue;
    let qty = 1, unitPrice = amount, unit = 'piece';
    const iq = label.match(INLINE_QTY);
    const cq = iq ? null : label.match(COLUMN_QTY);
    if (iq) { label = iq[1]; qty = num(iq[2]); unitPrice = num(iq[3]); }
    else if (cq && Math.abs(round2(num(cq[2]) * num(cq[3])) - amount) < 0.011) {
      label = cq[1]; qty = num(cq[2]); unitPrice = num(cq[3]);
      if (/[.,]/.test(cq[2])) unit = 'kg';
    }
    pending = null;
    out.lines.push(item(label, qty, unit, unitPrice, amount, t[2] ?? t[3], i));
  }

  const vatCodes = new Map(out.vat.filter((v) => v.code).map((v) => [v.code, v.rate]));
  for (const l of out.lines) {
    if (l.unit_price == null && l.total != null) l.unit_price = round2(l.total / (l.qty || 1));
    if (l.vat_code && vatCodes.has(l.vat_code)) l.vat_rate = vatCodes.get(l.vat_code);
    if (!l.is_discount && l.unit === 'piece' && Math.abs(round2(l.qty * l.unit_price) - l.total) > 0.011) l.flags.push('qty_x_price_mismatch');
    if (l.unit === 'kg' && Math.abs(l.qty * l.unit_price - l.total) > 0.02) l.flags.push('weight_x_price_mismatch');
  }
  const sumLines = round2(out.lines.reduce((s, l) => s + (l.total ?? 0), 0));
  out.totals.lines_sum = sumLines;
  out.totals.discounts = round2(out.lines.filter((l) => l.is_discount).reduce((s, l) => s + l.total, 0));
  const ref = out.totals.total;
  const matches = ref != null && Math.abs(sumLines - ref) < 0.011;
  if (unparsed) out.warnings.push(`unparsed_lines: ${unparsed}`);
  if (ref == null) out.warnings.push('no_total_found');
  else if (!matches) out.warnings.push(`sum_mismatch: lines ${sumLines} vs total ${ref}`);
  out.confidence = round2((out.store ? 0.15 : 0) + (out.date ? 0.15 : 0) + (ref != null ? 0.2 : 0) + (matches ? 0.4 : 0)
    + 0.1 * (out.lines.filter((l) => !l.flags.length).length / Math.max(1, out.lines.length)));
  return out;
}

function looksLikeLabel(line, nextUpper = '') {
  return QTY_LINE.test(nextUpper.replace(/[хХ×]/g, 'X')) || WEIGHT_LINE.test(nextUpper);
}

function item(label, qty, unit, unitPrice, total, vatCode, lineNo) {
  return { label: label.trim(), qty, unit, unit_price: unitPrice, total, is_discount: false, vat_code: vatCode ?? null, source_line: lineNo, flags: [] };
}

// Joins the OCR lines of several photos of one long receipt (top to bottom). Where two photos overlap, the lines of the
// next photo that repeat the end of the previous one are dropped (up to 2 cut lines at the photo edge are skipped too).
function stitchParts(parts) {
  const key = (l) => up(normalizeLine(String(l))).replace(/[^A-Z0-9]/g, '');
  const out = [];
  for (const part of parts) {
    const lines = (Array.isArray(part) ? part : String(part || '').split(/\r?\n/)).map(String).filter((l) => l.trim());
    const a = out.map(key), b = lines.map(key);
    let skip = 0;
    for (let k = Math.min(a.length, b.length, 30); k > 0 && !skip; k--) {
      for (let o = 0; o <= 2 && o + k <= b.length && !skip; o++) {
        const same = b.slice(o, o + k).filter((x, i) => x && x === a[a.length - k + i]).length;
        if (same >= Math.ceil(k * 0.6) && (k > 1 ? same >= 2 : b[o].length >= 8)) skip = o + k;
      }
    }
    out.push(...lines.slice(skip));
  }
  return out;
}
