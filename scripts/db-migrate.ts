/**
 * Create / update the database schema — the same migrations /api/init runs.
 * Points at whatever db.ts picks: Turso when TURSO_DATABASE_URL is set, else
 * the local vybe.db. For the hosted database:
 *
 *   npx tsx --env-file=.env.production.local scripts/db-migrate.ts
 *   (or: npm run db:migrate)
 *
 * Safe to re-run: every step is idempotent.
 */
import { migrate } from "../src/lib/migrate";
import { client } from "../src/lib/db";

async function main() {
  const target = process.env.TURSO_DATABASE_URL ? process.env.TURSO_DATABASE_URL.replace(/\?.*$/, "") : "local vybe.db";
  console.log(`migrating ${target}…`);
  await migrate();
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables = res.rows.map((r) => String((r as unknown as { name: string }).name));
  console.log(`✓ ${tables.length} tables: ${tables.join(", ")}`);
}

main().then(() => process.exit(0), (err) => { console.error("✗ migration failed:", err instanceof Error ? err.message : err); process.exit(1); });
