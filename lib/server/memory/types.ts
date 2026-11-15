/** Pure types shared by retrieval and matching (no SDK, no "server-only"). */

/** One validated search hit. `similarity` is RETRIEVAL similarity (0–1), not a qualification score. */
export interface MemoryHit {
  evidenceId: string;
  version: number;
  similarity: number;
}

/** Search is unavailable (provider/network/config). Distinct from "no results". */
export class MemorySearchError extends Error {}

export type MemorySearcher = (workerId: string, query: string) => Promise<MemoryHit[]>;
