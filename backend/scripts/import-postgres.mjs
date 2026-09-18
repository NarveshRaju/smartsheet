import 'dotenv/config';
import { PrismaClient as MongoClient } from '@prisma/client';
import legacy from '../generated/postgres/index.js';

if (!process.env.POSTGRES_SOURCE_URL || !process.env.DATABASE_URL?.startsWith('mongodb')) {
  throw new Error('Set POSTGRES_SOURCE_URL and an Atlas DATABASE_URL. No source data will be modified.');
}
const source = new legacy.PrismaClient();
const target = new MongoClient();
const apply = process.argv.includes('--apply');
try {
  // IDs and encrypted token bytes remain unchanged. Run with all sync workers stopped.
  const models = ['user', 'oAuthAccount', 'syncConfiguration', 'syncRecord'];
  const sourceCounts = {};
  for (const model of models) sourceCounts[model] = await source[model].count();
  console.log(JSON.stringify({ mode: apply ? 'import' : 'dry-run', sourceCounts }));
  if (!apply) console.log('Dry run complete. To import into an EMPTY Atlas database, pass --apply.');
  else {
    for (const model of models) {
      if (await target[model].count()) throw new Error('Destination is not empty; refusing to overwrite data. Use a fresh database after an interrupted import.');
    }
    for (const model of models) {
      let cursor;
      let copied = 0;
      while (true) {
        const rows = await source[model].findMany({ take: 100, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        if (!rows.length) break;
        for (const row of rows) {
          if (model === 'syncRecord' && row.rowData === null) delete row.rowData;
          await target[model].create({ data: row });
          copied++;
        }
        cursor = rows.at(-1).id;
      }
      const count = await target[model].count();
      if (count !== sourceCounts[model] || copied !== count) throw new Error(`Count mismatch for ${model}. Keep syncing stopped and inspect migration.`);
      console.log(`${model}: copied and verified ${count}`);
    }
    console.log('Import verified. Keep the original ENCRYPTION_KEY when deploying.');
  }
} finally {
  await Promise.all([source.$disconnect(), target.$disconnect()]);
}
