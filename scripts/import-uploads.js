'use strict';
// One-time move of uploaded documents from the old Railway volume into the database.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/import-uploads.js <path to the old uploads folder>
//
// Each attachments row names its file in stored_name; the file with that name in the folder is
// stored in attachment_blobs. Re-running is safe: files already imported are skipped.
const fs = require('fs');
const path = require('path');
const { db, ready, putBlob } = require('../src/db');

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: node scripts/import-uploads.js <path to the old uploads folder>');
    process.exit(1);
  }
  await ready();
  const names = (await db.prepare('SELECT DISTINCT stored_name FROM attachments').all()).map((r) => r.stored_name);
  let imported = 0;
  const missing = [];
  for (const name of names) {
    const file = path.join(dir, path.basename(name));
    if (!fs.existsSync(file)) {
      missing.push(name);
      continue;
    }
    const res = await putBlob(name, fs.readFileSync(file));
    if (res.changes) imported++;
  }
  console.log(`${names.length} attachments referenced, ${imported} newly imported, ${missing.length} files not found.`);
  if (missing.length) console.log('Missing:\n  ' + missing.join('\n  '));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
