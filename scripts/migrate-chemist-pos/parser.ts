import fs from 'fs';
import readline from 'readline';

export interface LegacyRow {
  table: string;
  values: any[];
}

/**
 * Parses a single SQL tuple string like:
 * "('ABZ 10ml susp', 'syrup', NULL, 40.00, 1)"
 * into an array of JS types: [ "ABZ 10ml susp", "syrup", null, 40, 1 ]
 */
export function parseSqlTuple(str: string): any[] {
  const values: any[] = [];
  let i = 0;
  const len = str.length;

  // Skip leading whitespace and '('
  while (i < len && (str[i] === ' ' || str[i] === '\t' || str[i] === '(')) {
    i++;
  }

  while (i < len) {
    // Skip whitespace
    while (i < len && (str[i] === ' ' || str[i] === '\t')) {
      i++;
    }

    if (i >= len || str[i] === ')') {
      break;
    }

    if (str[i] === "'") {
      // String value
      i++; // skip opening quote
      let val = '';
      while (i < len) {
        if (str[i] === '\\') {
          i++;
          if (i < len) {
            const escapeChar = str[i];
            if (escapeChar === 'n') val += '\n';
            else if (escapeChar === 'r') val += '\r';
            else if (escapeChar === 't') val += '\t';
            else if (escapeChar === '\\') val += '\\';
            else if (escapeChar === "'") val += "'";
            else if (escapeChar === '"') val += '"';
            else val += escapeChar;
            i++;
          }
        } else if (str[i] === "'") {
          // Check for '' (escaped quote in standard SQL)
          if (i + 1 < len && str[i + 1] === "'") {
            val += "'";
            i += 2;
          } else {
            // closing quote
            i++;
            break;
          }
        } else {
          val += str[i];
          i++;
        }
      }
      values.push(val);
    } else {
      // Non-string: number, NULL, etc.
      let token = '';
      while (i < len && str[i] !== ',' && str[i] !== ')') {
        token += str[i];
        i++;
      }
      token = token.trim();
      if (token.toUpperCase() === 'NULL') {
        values.push(null);
      } else if (/^-?\d+$/.test(token)) {
        values.push(parseInt(token, 10));
      } else if (/^-?\d+\.\d+$/.test(token)) {
        values.push(parseFloat(token));
      } else if (token.toUpperCase() === 'TRUE') {
        values.push(true);
      } else if (token.toUpperCase() === 'FALSE') {
        values.push(false);
      } else {
        values.push(token);
      }
    }

    // Skip whitespace and comma
    while (i < len && (str[i] === ' ' || str[i] === '\t')) {
      i++;
    }
    if (i < len && str[i] === ',') {
      i++;
    }
  }

  return values;
}

export interface StreamCallbacks {
  onTable?: (tableName: string) => void;
  onRow?: (tableName: string, row: any[]) => void;
}

/**
 * Streams chemist_pos.sql line-by-line and triggers onRow for each parsed record.
 */
export async function streamLegacyDump(
  filePath: string,
  callbacks: StreamCallbacks
): Promise<{ totalLines: number; totalRows: number; tables: string[] }> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let currentInsertTable: string | null = null;
  const tablesSet = new Set<string>();
  let totalLines = 0;
  let totalRows = 0;

  for await (const line of rl) {
    totalLines++;
    const trimmed = line.trim();

    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
    if (insertMatch) {
      currentInsertTable = insertMatch[1];
      tablesSet.add(currentInsertTable);
      if (callbacks.onTable) callbacks.onTable(currentInsertTable);

      const valIdx = trimmed.indexOf('VALUES');
      if (valIdx !== -1) {
        const rest = trimmed.substring(valIdx + 6).trim();
        if (rest.startsWith('(')) {
          const rowVals = parseSqlTuple(rest);
          if (rowVals.length > 0) {
            totalRows++;
            if (callbacks.onRow) callbacks.onRow(currentInsertTable, rowVals);
          }
        }
      }
      if (trimmed.endsWith(';')) {
        currentInsertTable = null;
      }
      continue;
    }

    if (currentInsertTable) {
      if (trimmed.startsWith('(')) {
        const rowVals = parseSqlTuple(trimmed);
        if (rowVals.length > 0) {
          totalRows++;
          if (callbacks.onRow) callbacks.onRow(currentInsertTable, rowVals);
        }
      }
      if (trimmed.endsWith(';')) {
        currentInsertTable = null;
      }
    }
  }

  return {
    totalLines,
    totalRows,
    tables: Array.from(tablesSet),
  };
}
