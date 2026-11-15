import "server-only";
import { Supermemory } from "supermemory";
import type { Evidence, MemoryIndexStatus } from "@/lib/types";
import { requireEnv } from "../../supabase/server";
import { memoryContent, memoryDate, memoryDocId, memoryMetadata, memoryNamespace } from "./conventions";

let cached: Supermemory | null = null;
/** Server-only SDK client. The API key never leaves the server. */
export function getMemoryClient(): Supermemory {
  cached ??= new Supermemory({ apiKey: requireEnv("SUPERMEMORY_API_KEY"), timeoutInSeconds: 20, maxRetries: 1 });
  return cached;
}

/** Provider processing state -> the lifecycle shown in the UI. */
export function mapProviderStatus(status: unknown): MemoryIndexStatus {
  if (status === "done") return "indexed";
  if (status === "failed") return "failed";
  return "processing"; // queued | extracting | chunking | embedding | indexing | unknown
}

/**
 * Send (or idempotently re-send) one record. `accepted` is NOT "indexed":
 * Supermemory processes asynchronously; completion is read by readIndexState.
 */
export async function submitEvidence(e: Evidence): Promise<MemoryIndexStatus> {
  const res = await getMemoryClient().add(memoryNamespace(e.workerId), {
    id: memoryDocId(e.id, e.version),
    content: memoryContent(e),
    metadata: memoryMetadata(e),
    date: memoryDate(e),
  });
  return mapProviderStatus(res.status);
}

/** Actual processing state at the provider. Missing document => failed (retryable). */
export async function readIndexState(workerId: string, evidenceId: string, version: number): Promise<{ status: MemoryIndexStatus; error: string | null }> {
  try {
    const doc = await getMemoryClient().documents.get(memoryNamespace(workerId), memoryDocId(evidenceId, version));
    const status = mapProviderStatus(doc.system?.status);
    return { status, error: status === "failed" ? "Memory processing failed. Try again." : null };
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404) return { status: "failed", error: "This record was not found in memory. Try again." };
    throw e; // provider unreachable: keep the current state, retry later
  }
}

/** Best-effort removal of a superseded document version. Never throws. */
export async function deleteMemoryDocument(workerId: string, documentId: string): Promise<void> {
  try {
    await getMemoryClient().documents.delete(memoryNamespace(workerId), { ids: [documentId] });
  } catch {
    /* an orphaned old version is harmless: search rejects outdated versions */
  }
}
