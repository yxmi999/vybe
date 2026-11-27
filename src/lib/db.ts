import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// The hosted site uses the online Turso DB. The desktop app ALWAYS uses its
// own local file, even if TURSO_* happens to be set on that machine — it must
// never read or write the hosted database directly.
const useTurso = !!process.env.TURSO_DATABASE_URL && process.env.VYBE_DESKTOP !== "1";

const client = createClient(
  useTurso
    ? { url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN }
    // Local file DB — in the desktop app this lives in the per-user data
    // folder (VYBE_DATA_DIR), since the install folder is read-only.
    : { url: `file:${(process.env.VYBE_DATA_DIR || process.cwd()).replace(/\\/g, "/")}/vybe.db` }
);

export const db = drizzle(client, { schema });
export { client };
