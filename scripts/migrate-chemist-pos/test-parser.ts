import path from 'path';
import { streamLegacyDump } from './parser';

async function testParser() {
  const sqlPath = path.resolve('chemist_pos.sql');
  console.log(`Testing streaming parser on: ${sqlPath}`);
  const startTime = Date.now();

  const tableCounts = new Map<string, number>();

  const res = await streamLegacyDump(sqlPath, {
    onRow: (table, row) => {
      tableCounts.set(table, (tableCounts.get(table) || 0) + 1);
    },
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Stream parsed ${res.totalLines.toLocaleString()} lines in ${duration}s.`);
  console.log(`Total rows parsed: ${res.totalRows.toLocaleString()}`);
  console.log('Row counts per table:');
  for (const [t, c] of tableCounts) {
    console.log(`- ${t}: ${c.toLocaleString()}`);
  }
}

testParser().catch(console.error);
