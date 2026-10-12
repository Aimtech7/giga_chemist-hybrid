import type { Medicine, MedicineBatch } from '../types';

/**
 * Catalogue search / filter / sort for the Medicines & Inventory screens. Pure functions (no DOM, no
 * API): the same code runs in the browser and in the test suite against the real catalogue.
 *
 * - Every search runs over the WHOLE loaded catalogue (all medicines of the selected shop), never over
 *   the rendered rows.
 * - Comparison text is NORMALIZED (lower case, trimmed, repeated spaces collapsed, harmless punctuation
 *   - / . , ( ) + _ : ; ' " ignored); stored data is never changed.
 * - Multi-word queries match when EVERY token is found somewhere in the medicine's searchable fields
 *   (name, generic, brand, barcode, SKU, category, type, strength, form, manufacturer, unit, batch numbers).
 * - Ranking: exact barcode > exact SKU > exact name > name starts with > generic/brand starts with >
 *   contains the whole query > all tokens found > (only when nothing else matches) close spelling.
 * - Typo tolerance is conservative and NAME-ONLY (name / generic / brand words of 5+ letters, one edit;
 *   9+ letters, two): barcodes and SKUs are never fuzzy-matched.
 */
export type StockState = 'in' | 'low' | 'out';
export type ExpiryFilter = 'all' | 'soon' | 'expired' | 'unknown';
export type SortKey = 'name' | 'stock' | 'retail' | 'wholesale' | 'expiry' | 'status';

export const EXPIRING_SOON_DAYS = 90;

export function normalize(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[-/.,()+_:;'"`’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Same text with every separator removed: "bis-cal" and "biscal" compare equal. */
const compact = (v: string) => v.replace(/\s+/g, '');
export const tokens = (q: string) => normalize(q).split(' ').filter(Boolean);

export function stockState(m: Pick<Medicine, 'current_stock' | 'reorder_level'>): StockState {
  const s = Number(m.current_stock) || 0;
  return s <= 0 ? 'out' : s <= (Number(m.reorder_level) || 0) ? 'low' : 'in';
}

export interface CatalogueRow {
  m: Medicine;
  batches: MedicineBatch[];
  batchCount: number;
  /** Earliest expiry among batches that still hold stock (null = none known). */
  nearestExpiry: string | null;
  expired: boolean;
  expiringSoon: boolean;
  unknownExpiry: boolean;
  state: StockState;
  // precomputed search keys
  hay: string;
  hayCompact: string;
  name: string;
  nameCompact: string;
  altNames: string[];
  nameWords: string[];
  barcode: string;
  sku: string;
}

/** Builds the search index once per catalogue load (not per keystroke). */
export function buildCatalogue(medicines: Medicine[], batches: MedicineBatch[], today = new Date()): CatalogueRow[] {
  const day = today.toISOString().slice(0, 10);
  const soon = new Date(today.getTime() + EXPIRING_SOON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const byMed = new Map<string, MedicineBatch[]>();
  for (const b of batches) {
    const list = byMed.get(b.medicine_id) || [];
    list.push(b);
    byMed.set(b.medicine_id, list);
  }
  return medicines.map((m) => {
    const bs = (byMed.get(m.id) || []).slice().sort((a, b) => (a.expiry_date || '9999').localeCompare(b.expiry_date || '9999'));
    const stocked = bs.filter((b) => Number(b.quantity_available) > 0);
    const dated = stocked.filter((b) => b.expiry_date).map((b) => String(b.expiry_date).slice(0, 10)).sort();
    const nearest = dated[0] || null;
    const fields = [m.name, m.generic_name, m.brand_name, m.barcode, m.sku, m.category, m.medicine_type, m.dosage_strength, m.dosage_form, m.manufacturer, m.unit,
      ...bs.map((b) => b.batch_number)];
    const hay = normalize(fields.filter(Boolean).join(' '));
    const name = normalize(m.name);
    const altNames = [normalize(m.generic_name), normalize(m.brand_name)].filter(Boolean);
    return {
      m, batches: bs, batchCount: bs.length, nearestExpiry: nearest,
      expired: Boolean(nearest && nearest <= day),
      expiringSoon: Boolean(nearest && nearest > day && nearest <= soon),
      // No known expiry on any batch that holds stock (or no dated batch at all).
      unknownExpiry: nearest === null,
      state: stockState(m),
      hay, hayCompact: compact(hay), name, nameCompact: compact(name), altNames,
      nameWords: [...new Set([name, ...altNames].join(' ').split(' ').filter((w) => w.length >= 4))],
      barcode: normalize(m.barcode), sku: normalize(m.sku),
    };
  });
}

/** Levenshtein distance with an early exit above `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}
/** A name word close to the token (same start letter; compared on the word's prefix of the token's length). */
function fuzzyWord(token: string, words: string[]): boolean {
  if (token.length < 5 || /\d/.test(token)) return false;
  const max = token.length >= 9 ? 2 : 1;
  return words.some((w) => w[0] === token[0] && (within(token, w, max) || (w.length > token.length && within(token, w.slice(0, token.length), max))));
}

/** 0 = best. Infinity = no match. */
export function rank(row: CatalogueRow, query: string): number {
  const q = normalize(query);
  if (!q) return 50;
  const qc = compact(q);
  if (row.barcode && row.barcode === q) return 0;
  if (row.sku && row.sku === q) return 1;
  if (row.name === q || row.nameCompact === qc) return 2;
  if (row.name.startsWith(q) || row.nameCompact.startsWith(qc)) return 3;
  if (row.altNames.some((a) => a.startsWith(q) || compact(a).startsWith(qc))) return 4;
  if (row.hay.includes(q) || row.hayCompact.includes(qc)) return 5;
  const ts = q.split(' ');
  if (ts.every((t) => row.hay.includes(t) || row.hayCompact.includes(t))) return 6;
  return Infinity;
}

/** Close-spelling fallback (name words only), used only when nothing matches exactly. */
export function fuzzyRank(row: CatalogueRow, query: string): number {
  const ts = tokens(query);
  if (!ts.length) return Infinity;
  return ts.every((t) => row.hay.includes(t) || fuzzyWord(t, row.nameWords)) ? 7 : Infinity;
}

export interface CatalogueFilters {
  query?: string;
  status?: 'all' | 'active' | 'inactive';
  stock?: 'all' | StockState;
  expiry?: ExpiryFilter;
  category?: string;
}

export interface CatalogueResult {
  rows: CatalogueRow[];
  /** True when the rows come from the close-spelling fallback (shown to the user). */
  fuzzy: boolean;
}

/** Search + filters over the WHOLE catalogue, then sort (ranking first when searching). */
export function queryCatalogue(all: CatalogueRow[], f: CatalogueFilters, sort: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'name', dir: 'asc' }): CatalogueResult {
  const pass = (r: CatalogueRow) =>
    (!f.status || f.status === 'all' || (f.status === 'active') === (r.m.status === 'active'))
    && (!f.stock || f.stock === 'all' || r.state === f.stock)
    && (!f.category || r.m.category === f.category)
    && (!f.expiry || f.expiry === 'all' || (f.expiry === 'soon' ? r.expiringSoon : f.expiry === 'expired' ? r.expired : r.unknownExpiry));
  const filtered = all.filter(pass);
  const q = (f.query || '').trim();
  let ranked: { r: CatalogueRow; k: number }[];
  let fuzzy = false;
  if (q) {
    ranked = filtered.map((r) => ({ r, k: rank(r, q) })).filter((x) => x.k !== Infinity);
    if (ranked.length === 0) {
      ranked = filtered.map((r) => ({ r, k: fuzzyRank(r, q) })).filter((x) => x.k !== Infinity);
      fuzzy = ranked.length > 0;
    }
  } else ranked = filtered.map((r) => ({ r, k: 0 }));
  const dir = sort.dir === 'asc' ? 1 : -1;
  const cmp = (a: CatalogueRow, b: CatalogueRow): number => {
    switch (sort.key) {
      case 'stock': return ((Number(a.m.current_stock) || 0) - (Number(b.m.current_stock) || 0)) * dir;
      case 'retail': return ((Number(a.m.selling_price) || 0) - (Number(b.m.selling_price) || 0)) * dir;
      case 'wholesale': return ((a.m.wholesale_price ?? -1) - (b.m.wholesale_price ?? -1)) * dir;
      case 'expiry': return (a.nearestExpiry || '9999-12-31').localeCompare(b.nearestExpiry || '9999-12-31') * dir;
      case 'status': return String(a.m.status).localeCompare(String(b.m.status)) * dir;
      default: return a.m.name.localeCompare(b.m.name, undefined, { sensitivity: 'base' }) * dir;
    }
  };
  // When searching, relevance decides first (barcode / exact name on top); the chosen sort breaks ties.
  ranked.sort((x, y) => (q ? x.k - y.k : 0) || cmp(x.r, y.r) || x.r.m.name.localeCompare(y.r.m.name));
  return { rows: ranked.map((x) => x.r), fuzzy };
}

export interface CatalogueSummary { total: number; active: number; inactive: number; in: number; low: number; out: number; units: number }
export function summarize(all: CatalogueRow[]): CatalogueSummary {
  const s: CatalogueSummary = { total: all.length, active: 0, inactive: 0, in: 0, low: 0, out: 0, units: 0 };
  for (const r of all) {
    if (r.m.status === 'active') s.active++; else s.inactive++;
    s[r.state]++;
    s.units += Math.max(0, Number(r.m.current_stock) || 0);
  }
  return s;
}
