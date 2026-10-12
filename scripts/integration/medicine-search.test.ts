import fs from 'fs';
import pg from 'pg';
import { getAllMedicines } from '../../server/db/medicines';
import { getAllBatches } from '../../server/db/batches';
import { buildCatalogue, normalize, queryCatalogue, summarize, type CatalogueRow } from '../../src/services/medicineSearch';
import type { Medicine, MedicineBatch } from '../../src/types';

/**
 * Medicines search / filter / sort against the REAL Shop 1 catalogue.   npm run test:medicine-search
 *
 * Source (READ ONLY, nothing is written anywhere):
 *   default      the production cloud copy (DATABASE_URL in .env.online), read exactly like the online
 *                API does: READ ONLY transaction, search_path giga_online, giga.shop_id = SHOP_ID
 *   CATALOGUE_DB a shop database URL instead (e.g. PC2 giga_chemist), read through the same functions
 * Sample medicines are picked from the data itself; nothing is hard-coded except the query "biscal".
 */
let passed = 0, failed = 0;
const check = (ok: boolean, label: string, detail?: unknown) => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};

async function load(): Promise<{ medicines: Medicine[]; batches: MedicineBatch[]; source: string }> {
  const local = process.env.CATALOGUE_DB;
  const env = fs.existsSync('.env.online') ? fs.readFileSync('.env.online', 'utf-8') : '';
  const url = local || env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
  const shop = env.match(/^SHOP_ID=(.*)$/m)?.[1]?.trim();
  if (!url) throw new Error('No catalogue source: set CATALOGUE_DB or provide .env.online.');
  const c = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    if (!local) await c.query(`SELECT set_config('search_path', 'giga_online, pg_catalog', true), set_config('giga.shop_id', $1, true)`, [shop]);
    const medicines = await getAllMedicines(c as any);
    const batches = await getAllBatches(c as any);
    await c.query('ROLLBACK');
    return { medicines, batches, source: local ? 'shop database (CATALOGUE_DB)' : `production cloud copy, shop ${shop}` };
  } finally {
    await c.end();
  }
}

(async () => {
  const { medicines, batches, source } = await load();
  console.log(`\n=== CATALOGUE: ${medicines.length} medicines, ${batches.length} batches (${source}) ===`);
  let t = Date.now();
  const all = buildCatalogue(medicines, batches);
  const buildMs = Date.now() - t;
  const S = summarize(all);
  console.log(`  summary: ${JSON.stringify(S)}  (index built in ${buildMs} ms)`);
  const ids = (rows: CatalogueRow[]) => rows.map((r) => r.m.id);
  const find = (q: string, f: any = {}) => queryCatalogue(all, { ...f, query: q }).rows;
  const byName = [...all].sort((a, b) => a.m.name.localeCompare(b.m.name));

  console.log('\n=== SEARCH ===');
  const withBarcode = all.filter((r) => r.m.barcode);
  let barcodeHits = 0;
  for (const r of withBarcode) if (find(r.m.barcode)[0]?.m.id === r.m.id) barcodeHits++;
  check(medicines.length >= 2000 && barcodeHits === withBarcode.length, `1/3: every one of the ${withBarcode.length} barcoded medicines is found first by its exact barcode`, { barcodeHits });
  const late = byName[byName.length - 1];
  check(find(late.m.name)[0]?.m.id === late.m.id && byName.indexOf(late) > 60, `2: a medicine far beyond the first 60 rows (#${byName.indexOf(late) + 1}: "${late.m.name}") is found`);
  const skuRow = all.find((r) => r.m.sku && find(r.m.sku).length > 0)!;
  check(find(skuRow.m.sku)[0]?.m.id === skuRow.m.id, `4: exact SKU "${skuRow.m.sku}" returns that medicine first`);
  const word = all.map((r) => r.name.split(' ')[0]).find((w) => w.length >= 7)!;
  const part = word.slice(0, 5);
  const partHits = find(part);
  check(partHits.length > 0 && partHits.every((r) => r.hay.includes(part) || r.hayCompact.includes(part)), `5: partial name "${part}" -> ${partHits.length} medicines, all containing it`);
  const gen = all.find((r) => r.m.generic_name && normalize(r.m.generic_name) !== r.name && normalize(r.m.generic_name).length >= 5);
  check(!gen || ids(find(gen.m.generic_name)).includes(gen.m.id), gen ? `6: generic name "${gen.m.generic_name}" finds "${gen.m.name}"` : '6: (no medicine has a distinct generic name)');
  const brand = all.find((r) => r.m.brand_name && normalize(r.m.brand_name).length >= 4);
  check(!brand || ids(find(brand.m.brand_name)).includes(brand.m.id), brand ? `7: brand "${brand.m.brand_name}" finds "${brand.m.name}"` : '7: (no brand names in this catalogue)');
  const cats = [...new Set(all.map((r) => r.m.category).filter(Boolean))];
  const cat = cats.find((c) => normalize(c).length >= 5 && all.filter((r) => r.m.category === c).length >= 3) || cats[0];
  const inCat = all.filter((r) => r.m.category === cat);
  const catHits = new Set(ids(find(cat)));
  check(inCat.every((r) => catHits.has(r.m.id)), `8: category "${cat}" search returns all ${inCat.length} medicines of that category`);
  const strengthRow = all.find((r) => /\b\d{2,4}\s?mg\b/i.test(r.m.name) && r.name.split(' ')[0].length >= 5)!;
  const num = strengthRow.m.name.match(/(\d{2,4})\s?mg/i)![1];
  const mt = `${strengthRow.name.split(' ')[0].slice(0, 4)} ${num}`;
  const mtHits = ids(find(mt));
  const mtRev = ids(find(`${num} ${strengthRow.name.split(' ')[0].slice(0, 4)}`));
  check(mtHits.includes(strengthRow.m.id) && mtRev.includes(strengthRow.m.id), `9: multi-token "${mt}" (and reversed) finds "${strengthRow.m.name}"`);
  const strengthOnly = all.find((r) => r.m.dosage_strength && /\d/.test(r.m.dosage_strength));
  check(!strengthOnly || ids(find(`${strengthOnly.name.split(' ')[0]} ${strengthOnly.m.dosage_strength}`)).includes(strengthOnly.m.id), 'strength field is searchable');
  const target = byName[Math.floor(byName.length / 2)];
  check(find(target.m.name.toUpperCase())[0]?.m.id === target.m.id && find(target.m.name.toLowerCase())[0]?.m.id === target.m.id, `10: case-insensitive ("${target.m.name}")`);
  check(find(`   ${target.m.name}   `)[0]?.m.id === target.m.id && find(target.m.name.replace(/ /g, '    '))[0]?.m.id === target.m.id, '11: leading / trailing / repeated spaces ignored');
  const punct = target.m.name.split(' ')[0];
  const dashed = punct.length >= 4 ? `${punct.slice(0, 3)}-${punct.slice(3)}` : punct;
  check(ids(find(dashed)).includes(target.m.id) && ids(find(`${punct}.`)).includes(target.m.id), `12: punctuation ignored ("${dashed}", "${punct}.")`);
  // The real catalogue has no distinct generic / brand values: prove those fields on a synthetic row too.
  const synth = buildCatalogue([{ ...(all[0].m as any), id: 'synthetic', name: 'Panadol Extra 500mg', generic_name: 'Paracetamol', brand_name: 'GSK Panadol', barcode: 'SYN-1', sku: 'SYN-SKU' } as Medicine], []);
  check(queryCatalogue(synth, { query: 'paracetamol' }).rows.length === 1 && queryCatalogue(synth, { query: 'gsk' }).rows.length === 1
    && queryCatalogue(synth, { query: 'PARACET 500' }).rows.length === 1, '6/7: generic name and brand are searched (synthetic row: "Paracetamol", "GSK")');
  const batchRow = all.find((r) => r.batches[0]?.batch_number && r.batches[0].batch_number.length >= 4);
  check(!batchRow || ids(find(batchRow.batches[0].batch_number)).includes(batchRow.m.id), 'batch number is searchable');
  check(find('zzqx no such medicine 98765').length === 0, 'an unrelated query returns nothing (no wild matches)');

  console.log('\n=== FILTERS / SORT ===');
  const active = queryCatalogue(all, { status: 'active' }).rows, inactive = queryCatalogue(all, { status: 'inactive' }).rows;
  check(active.length === S.active && inactive.length === S.inactive && active.length + inactive.length === all.length && inactive.every((r) => r.m.status !== 'active'),
    `13/20: status filter (active ${active.length}, inactive ${inactive.length}; inactive visible)`);
  const st = (s: any) => queryCatalogue(all, { stock: s }).rows;
  check(st('in').length === S.in && st('low').length === S.low && st('out').length === S.out && S.in + S.low + S.out === all.length
    && st('low').every((r) => r.m.current_stock > 0 && r.m.current_stock <= r.m.reorder_level), `14: stock filter (in ${S.in}, low ${S.low}, out ${S.out})`);
  check(queryCatalogue(all, { category: cat }).rows.length === inCat.length, '15: category filter');
  const combos: [string, any][] = [['active', { status: 'active' }], ['inactive', { status: 'inactive' }], ['in', { stock: 'in' }], ['low', { stock: 'low' }], ['out', { stock: 'out' }], ['category', { category: cat }]];
  const comboQ = part;
  check(combos.every(([, f]) => {
    const got = new Set(ids(queryCatalogue(all, { ...f, query: comboQ }).rows));
    const expect = queryCatalogue(all, f).rows.filter((r) => got.has(r.m.id));
    const searchAll = new Set(ids(find(comboQ)));
    return queryCatalogue(all, f).rows.filter((r) => searchAll.has(r.m.id)).length === got.size && expect.length === got.size;
  }), `16: search "${comboQ}" combined with active / inactive / in / low / out / category = intersection`);
  const sAsc = queryCatalogue(all, {}, { key: 'stock', dir: 'asc' }).rows, sDesc = queryCatalogue(all, {}, { key: 'stock', dir: 'desc' }).rows;
  check(sAsc.every((r, i) => i === 0 || sAsc[i - 1].m.current_stock <= r.m.current_stock) && sDesc[0].m.current_stock === Math.max(...all.map((r) => r.m.current_stock)), '17: stock sort low-high / high-low');
  const nAsc = queryCatalogue(all, {}).rows, nDesc = queryCatalogue(all, {}, { key: 'name', dir: 'desc' }).rows;
  check(nAsc.every((r, i) => i === 0 || nAsc[i - 1].m.name.localeCompare(r.m.name, undefined, { sensitivity: 'base' }) <= 0) && nDesc[0].m.id === nAsc[nAsc.length - 1].m.id, '18: medicine name sort A-Z / Z-A');
  const ex = queryCatalogue(all, {}, { key: 'expiry', dir: 'asc' }).rows;
  check(ex.every((r, i) => i === 0 || (ex[i - 1].nearestExpiry || '9999') <= (r.nearestExpiry || '9999')), 'nearest-expiry sort');
  check(st('out').length > 0 && queryCatalogue(all, {}).rows.length === all.length, `19: zero-stock medicines visible (${S.out} out of stock, all ${all.length} rows listed)`);
  const soon = queryCatalogue(all, { expiry: 'soon' }).rows, expd = queryCatalogue(all, { expiry: 'expired' }).rows, unk = queryCatalogue(all, { expiry: 'unknown' }).rows;
  check(soon.every((r) => r.expiringSoon) && expd.every((r) => r.expired) && unk.every((r) => r.nearestExpiry === null), `expiry filters (soon ${soon.length}, expired ${expd.length}, unknown ${unk.length})`);

  console.log('\n=== PERFORMANCE ===');
  const queries = ['para', 'amox 500', 'biscal', '1234', 'syrup', 'tab', 'cetirizine', 'flucon 200', 'zz', 'a'];
  t = Date.now();
  for (let i = 0; i < 20; i++) for (const q of queries) queryCatalogue(all, { query: q, status: 'all' });
  const per = (Date.now() - t) / (20 * queries.length);
  check(buildMs < 1500 && per < 40, `23: ${all.length} medicines: index ${buildMs} ms, ${per.toFixed(1)} ms per search+filter+sort`);

  console.log('\n=== "biscal" (reported as found, no faked result) ===');
  const exact = queryCatalogue(all, { query: 'biscal' });
  const contains = all.filter((r) => r.hayCompact.includes('biscal'));
  console.log(`  stored medicines containing "biscal" (any field, punctuation ignored): ${contains.length}${contains.length ? ' -> ' + contains.map((r) => r.m.name).join(' | ') : ''}`);
  console.log(`  search "biscal" returns ${exact.rows.length}${exact.fuzzy ? ' close-spelling' : ''} result(s)${exact.rows.length ? ': ' + exact.rows.slice(0, 10).map((r) => r.m.name).join(' | ') : ''}`);
  check(contains.length === 0 ? (exact.rows.length === 0 || exact.fuzzy) : ids(exact.rows).includes(contains[0].m.id), '"biscal": result consistent with the stored data');

  console.log(`\n  RESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('FATAL', e?.message || e);
  process.exitCode = 1;
});
