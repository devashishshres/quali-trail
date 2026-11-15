import type { MemoryHit } from "@/lib/server/memory/types";
export { MemorySearchError } from "@/lib/server/memory/types";

/** Test-only memory hit. */
export const memoryHit = (evidenceId: string, similarity: number, version = 1): MemoryHit => ({ evidenceId, similarity, version });
