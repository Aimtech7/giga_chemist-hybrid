import type { Medicine, MedicineBatch } from '../types';

export interface SearchResult {
  medicine: Medicine;
  score: number;
  matchType: 'barcode' | 'sku' | 'exact_name' | 'exact_brand_generic' | 'starts_with' | 'token_match' | 'partial' | 'category_mfg';
}

/**
 * Normalizes strings by lowercasing, trimming, and replacing non-alphanumeric punctuation with spaces.
 */
function normalizeString(val?: string): string {
  if (!val) return '';
  return val.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Universal Medicine Search & Scoring Engine.
 * Evaluates query against all identifying fields with ranked priority:
 * 1. Exact Barcode Match
 * 2. Exact SKU Match
 * 3. Exact Medicine Name Match
 * 4. Exact Generic / Brand Name Match
 * 5. Starts-with Name / Brand / SKU Match
 * 6. Multi-token partial match (e.g. "amox 500", "cet 10", "pcm 500")
 * 7. Strength / Category / Manufacturer / Form match
 */
export function searchMedicines(
  query: string,
  medicines: Medicine[],
  batches?: MedicineBatch[]
): Medicine[] {
  const cleanQuery = query.trim();
  if (!cleanQuery) return medicines;

  const rawLower = cleanQuery.toLowerCase();
  const normalizedQuery = normalizeString(cleanQuery);
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);

  // Group batches by medicine_id for batch number searching
  const batchesByMedId = new Map<string, MedicineBatch[]>();
  if (batches) {
    for (const b of batches) {
      const existing = batchesByMedId.get(b.medicine_id) || [];
      existing.push(b);
      batchesByMedId.set(b.medicine_id, existing);
    }
  }

  const scoredResults: SearchResult[] = [];

  for (const med of medicines) {
    const medBarcode = (med.barcode || '').toLowerCase().trim();
    const medSku = (med.sku || '').toLowerCase().trim();
    const medName = (med.name || '').toLowerCase().trim();
    const medGeneric = (med.generic_name || '').toLowerCase().trim();
    const medBrand = ((med.brand_name || (med as any).brand) || '').toLowerCase().trim();
    const medStrength = ((med.dosage_strength || (med as any).strength) || '').toLowerCase().trim();
    const medForm = (med.dosage_form || '').toLowerCase().trim();
    const medCategory = (med.category || '').toLowerCase().trim();
    const medMfg = (med.manufacturer || '').toLowerCase().trim();

    // 1. Exact Barcode Match (Rank 1 - Instant top priority)
    if (medBarcode === rawLower) {
      scoredResults.push({ medicine: med, score: 1000, matchType: 'barcode' });
      continue;
    }

    // 2. Exact SKU Match (Rank 2)
    if (medSku === rawLower) {
      scoredResults.push({ medicine: med, score: 900, matchType: 'sku' });
      continue;
    }

    // 3. Exact Medicine Name Match (Rank 3)
    if (medName === rawLower) {
      scoredResults.push({ medicine: med, score: 800, matchType: 'exact_name' });
      continue;
    }

    // 4. Exact Brand or Generic Match (Rank 4)
    if (medBrand === rawLower || medGeneric === rawLower) {
      scoredResults.push({ medicine: med, score: 700, matchType: 'exact_brand_generic' });
      continue;
    }

    // 5. Starts-with Name, Brand, or SKU (Rank 5)
    if (medName.startsWith(rawLower) || medBrand.startsWith(rawLower) || medSku.startsWith(rawLower)) {
      scoredResults.push({ medicine: med, score: 600, matchType: 'starts_with' });
      continue;
    }

    if (medGeneric.startsWith(rawLower)) {
      scoredResults.push({ medicine: med, score: 550, matchType: 'starts_with' });
      continue;
    }

    // Check Barcode prefix / substring
    if (medBarcode.includes(rawLower)) {
      scoredResults.push({ medicine: med, score: 520, matchType: 'barcode' });
      continue;
    }

    // Check SKU prefix / substring (e.g. PCM matching MED-PCM-500)
    if (medSku.includes(rawLower)) {
      scoredResults.push({ medicine: med, score: 500, matchType: 'sku' });
      continue;
    }

    // 6. Tokenized Multi-Term Match (e.g. "amox 500", "cet 10", "paracetamol 500")
    const fullNormalizedSearchCorpus = normalizeString(
      `${med.name} ${med.generic_name} ${med.brand_name || ''} ${med.sku} ${med.dosage_strength} ${med.dosage_form} ${med.category} ${med.manufacturer || ''}`
    );

    let allTokensMatch = true;
    let nameOrBrandMatchCount = 0;

    for (const token of queryTokens) {
      if (!fullNormalizedSearchCorpus.includes(token)) {
        // Also check batch numbers if present
        const medBatches = batchesByMedId.get(med.id) || [];
        const matchesBatch = medBatches.some((b) => b.batch_number.toLowerCase().includes(token));
        if (!matchesBatch) {
          allTokensMatch = false;
          break;
        }
      }

      if (normalizeString(med.name).includes(token) || normalizeString(med.brand_name).includes(token)) {
        nameOrBrandMatchCount++;
      }
    }

    if (allTokensMatch && queryTokens.length > 0) {
      const tokenScore = 350 + (nameOrBrandMatchCount * 50) + (queryTokens.length * 10);
      scoredResults.push({ medicine: med, score: tokenScore, matchType: 'token_match' });
      continue;
    }

    // 7. Partial substring in Name, Generic, or Brand
    if (medName.includes(rawLower) || medBrand.includes(rawLower) || medGeneric.includes(rawLower)) {
      scoredResults.push({ medicine: med, score: 250, matchType: 'partial' });
      continue;
    }

    // 8. Category, Dosage Form, Strength, or Manufacturer match
    if (
      medStrength.includes(rawLower) ||
      medCategory.includes(rawLower) ||
      medMfg.includes(rawLower) ||
      medForm.includes(rawLower)
    ) {
      scoredResults.push({ medicine: med, score: 150, matchType: 'category_mfg' });
      continue;
    }
  }

  // Sort by highest score first, then alphabetically by name
  scoredResults.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.medicine.name.localeCompare(b.medicine.name);
  });

  return scoredResults.map((r) => r.medicine);
}
