/**
 * Centralized Expiry Date Handling and Normalization Utilities for GIGA CHEMIST.
 * Provides safe normalization of mixed date formats (e.g., YYYY-MM to end of month),
 * consistent FEFO sorting, expiry detection, and threshold categorization.
 */

/**
 * Normalizes any supported date string to canonical ISO 'YYYY-MM-DD'.
 * If a month-only format 'YYYY-MM' is provided, it normalizes to the LAST DAY of that month.
 * Examples:
 *   - '2027-05' -> '2027-05-31'
 *   - '2028-02' (leap year) -> '2028-02-29'
 *   - '2027-05-15' -> '2027-05-15'
 */
export function normalizeExpiryDate(dateInput: string | undefined | null): string {
  if (!dateInput || typeof dateInput !== 'string') {
    return '1970-01-01';
  }

  const trimmed = dateInput.trim();

  // Pattern: YYYY-MM (e.g. 2027-05 or 2027/05)
  const monthOnlyMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (monthOnlyMatch) {
    const year = parseInt(monthOnlyMatch[1], 10);
    const month = parseInt(monthOnlyMatch[2], 10); // 1-12
    if (month >= 1 && month <= 12) {
      // Day 0 of month + 1 gives the last day of the given month
      const lastDay = new Date(year, month, 0).getDate();
      const paddedMonth = month.toString().padStart(2, '0');
      const paddedDay = lastDay.toString().padStart(2, '0');
      return `${year}-${paddedMonth}-${paddedDay}`;
    }
  }

  // Pattern: YYYY-MM-DD
  const fullDateMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (fullDateMatch) {
    const year = parseInt(fullDateMatch[1], 10);
    const month = parseInt(fullDateMatch[2], 10);
    const day = parseInt(fullDateMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const paddedMonth = month.toString().padStart(2, '0');
      const paddedDay = day.toString().padStart(2, '0');
      return `${year}-${paddedMonth}-${paddedDay}`;
    }
  }

  // Fallback: try Date.parse
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return trimmed;
}

/**
 * Determines whether a date is expired relative to reference date (default: today).
 * Compares strictly normalized YYYY-MM-DD strings.
 */
export function isExpired(dateInput: string, referenceDate: Date = new Date()): boolean {
  const normDate = normalizeExpiryDate(dateInput);
  const refStr = referenceDate.toISOString().split('T')[0];
  return normDate <= refStr;
}

/**
 * Determines whether a date is expiring within a given threshold (in days) and not already expired.
 */
export function isExpiringSoon(
  dateInput: string,
  daysThreshold: number = 30,
  referenceDate: Date = new Date()
): boolean {
  if (isExpired(dateInput, referenceDate)) {
    return false;
  }
  const normDate = normalizeExpiryDate(dateInput);
  const targetDate = new Date(referenceDate);
  targetDate.setDate(targetDate.getDate() + daysThreshold);
  const targetStr = targetDate.toISOString().split('T')[0];
  return normDate <= targetStr;
}

/**
 * Calculates days remaining until expiration. Negative if expired.
 */
export function getDaysUntilExpiry(dateInput: string, referenceDate: Date = new Date()): number {
  const normDate = normalizeExpiryDate(dateInput);
  const expDate = new Date(`${normDate}T00:00:00`);
  const refDate = new Date(referenceDate);
  refDate.setHours(0, 0, 0, 0);
  const diffMs = expDate.getTime() - refDate.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * FEFO comparator: sorts batches by earliest normalized expiry date first.
 */
export function compareExpiryDates(dateA: string, dateB: string): number {
  const normA = normalizeExpiryDate(dateA);
  const normB = normalizeExpiryDate(dateB);
  return normA.localeCompare(normB);
}
