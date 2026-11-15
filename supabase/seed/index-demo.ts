/**
 * Indexes the seeded historical evidence into Supermemory and records the REAL
 * processing result.
 *
 *   npx tsx --env-file=.env.local supabase/seed/index-demo.ts
 *
 * Uses the same convention as the app (lib/server/memory/conventions.ts).
 * A record is marked `indexed` only after Supermemory reports status "done" for
 * it; if processing fails or times out it is marked `failed` (retry from the UI).
 * Safe to re-run: document ids are stable, so re-sending updates in place.
 * Runs with the SECRET key on a developer machine only; never import from app code.
 */
import { createClient } from "@supabase/supabase-js";
import { Supermemory } from "supermemory";
import { memoryContent, memoryDate, memoryDocId, memoryMetadata, memoryNamespace } from "../../lib/server/memory/conventions";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "../../lib/supabase/mappers";
import { DEMO_WORKER } from "./demo-data";

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`Missing environment variable ${n}`);
  return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const memory = new Supermemory({ apiKey: need("SUPERMEMORY_API_KEY") });
  const ns = memoryNamespace(DEMO_WORKER.id);

  const { data, error } = await db.from("evidence").select(EVIDENCE_COLUMNS).eq("worker_id", DEMO_WORKER.id).returns<EvidenceRow[]>();
  if (error) throw error;
  if (!data.length) throw new Error("No demo evidence found. Run the seed first.");

  const mark = (id: string, version: number, status: string, err: string | null) =>
    db.from("evidence").update({ index_status: status, index_error: err, memory_document_id: memoryDocId(id, version) }).eq("id", id).eq("worker_id", DEMO_WORKER.id).eq("version", version);

  for (const row of data) {
    const e = toEvidence(row);
    await memory.add(ns, { id: memoryDocId(e.id, e.version), content: memoryContent(e), metadata: memoryMetadata(e), date: memoryDate(e) });
    await mark(e.id, e.version, "processing", null);

    let final = "processing";
    for (let i = 0; i < 40 && final === "processing"; i++) {
      await sleep(3000);
      const doc = await memory.documents.get(ns, memoryDocId(e.id, e.version));
      const s = doc.system?.status;
      final = s === "done" ? "indexed" : s === "failed" ? "failed" : "processing";
    }
    if (final === "processing") final = "failed"; // timed out: do not claim indexed
    await mark(e.id, e.version, final, final === "failed" ? "Memory processing did not finish. Try again." : null);
    console.log(`${final.padEnd(8)} ${e.title.slice(0, 70)}`);
  }
}

main().catch((err) => {
  console.error("Indexing failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
