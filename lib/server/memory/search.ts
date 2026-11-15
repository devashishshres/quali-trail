import "server-only";
import { memoryNamespace, parseHitMetadata } from "./conventions";
import { getMemoryClient } from "./client";
import { MemorySearchError, type MemoryHit, type MemorySearcher } from "./types";

/**
 * Search ONE worker's namespace. Hits that are malformed, claim another
 * worker, or have an out-of-range similarity are dropped; several chunks of
 * the same record VERSION collapse to the best similarity. Different versions
 * stay separate so an outdated copy can never shadow the current one. Callers must still
 * resolve every hit against current database rows.
 */
export const searchWorkerMemory: MemorySearcher = async (workerId, query) => {
  let response;
  try {
    response = await getMemoryClient().search(memoryNamespace(workerId), { query, limit: 10 });
  } catch (e) {
    console.error("memory search failed", { status: (e as { statusCode?: number }).statusCode });
    throw new MemorySearchError("Memory search is unavailable right now.");
  }

  const best = new Map<string, MemoryHit>();
  for (const r of response.results ?? []) {
    const meta = parseHitMetadata(r.metadata, workerId);
    const sim = r.similarity;
    if (!meta || typeof sim !== "number" || !(sim >= 0 && sim <= 1)) continue;
    const key = `${meta.evidenceId}:${meta.version}`;
    const prev = best.get(key);
    if (!prev || sim > prev.similarity) best.set(key, { evidenceId: meta.evidenceId, version: meta.version, similarity: sim });
  }
  return [...best.values()];
};
