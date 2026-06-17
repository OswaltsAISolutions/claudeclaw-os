// One-shot: create a Desktop folder for every client and export all existing
// ready artifacts into them. Safe to re-run (idempotent overwrites).
// Usage: node scripts/export-backfill.mjs   (from repo root)
import { initDatabase, listClients, listClientArtifacts } from '../dist/db.js';
import { exportArtifactDocs, ensureClientFolder } from '../dist/clients-export.js';

initDatabase();
let folders = 0, docs = 0;
for (const c of listClients()) {
  ensureClientFolder(c.company);
  folders++;
  for (const a of listClientArtifacts(c.id)) {
    exportArtifactDocs(c, a);
    docs++;
  }
}
console.log(`folders ensured: ${folders}, artifacts processed: ${docs}`);
