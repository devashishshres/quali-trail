/**
 * THE Supermemory convention for QualiTrail. Ingestion (indexing.ts) and
 * retrieval (search.ts) both use ONLY this file, so they cannot drift apart.
 * Pure on purpose: no SDK, no env, unit-testable.
 *
 * It matches the data the Evidence Passport side already indexed in the shared
 * Supermemory project (verified read-only against the live namespace):
 *
 *   namespace    worker_<workerId>             one isolated memory space per worker
 *   document id  <evidenceId>_v<version>       == evidence.memory_document_id.
 *                                              New content version => new document;
 *                                              older versions are outdated.
 *   metadata     evidenceId, evidenceVersion, workerId, evidenceType, isSynthetic,
 *                (+ temporal* fields Supermemory derives from the document `date`)
 *
 * Supermemory holds only a SEARCHABLE COPY of the descriptive fields. The
 * authoritative record, its verification status and the original file live in
 * Postgres / private storage. Search hits are never trusted for display:
 * they are resolved back to current worker-owned database rows by evidenceId.
 */
import { z } from "zod";
import type { Evidence } from "@/lib/types";

export const memoryNamespace = (workerId: string) => `${process.env.SUPERMEMORY_NAMESPACE_PREFIX ?? ""}worker_${workerId}`;
export const memoryDocId = (evidenceId: string, version: number) => `${evidenceId}_v${version}`;

export type MemoryMetadata = Record<string, string | number | boolean>;

export function memoryMetadata(e: Pick<Evidence, "id" | "workerId" | "version" | "type" | "isSynthetic">): MemoryMetadata {
  return {
    evidenceId: e.id,
    evidenceVersion: e.version,
    workerId: e.workerId,
    evidenceType: e.type,
    isSynthetic: e.isSynthetic,
  };
}

/**
 * The record's own date, passed as the document `date`. Supermemory derives the
 * temporalContext / temporalEvent* metadata from it (as seen on the live data).
 */
export const memoryDate = (e: Pick<Evidence, "date">): string | undefined => e.date ?? undefined;

/**
 * Searchable text built ONLY from the record's descriptive fields.
 * Deliberately omits verification status: memory must never carry a claim of
 * authenticity, and verification can change without re-indexing.
 */
export function memoryContent(e: Evidence): string {
  const d = e.structuredData;
  const lines = [
    `Title: ${e.title}`,
    `Record type: ${e.type.replace("_", " ")}`,
    e.date ? `Date: ${e.date}` : null,
    e.issuer ? `Issuer: ${e.issuer}` : null,
    d.summary ? `Summary: ${d.summary}` : null,
    d.skills.length ? `Skills: ${d.skills.join("; ")}` : null,
    d.activities.length ? `Activities: ${d.activities.join("; ")}` : null,
    d.equipment.length ? `Equipment: ${d.equipment.join("; ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

const HitMetadata = z.object({
  evidenceId: z.uuid(),
  workerId: z.uuid(),
  evidenceVersion: z.number().int().positive(),
});

/**
 * Read a search hit's metadata. Returns null for anything malformed or that
 * claims a different worker than the namespace we searched.
 */
export function parseHitMetadata(metadata: unknown, searchedWorkerId: string): { evidenceId: string; version: number } | null {
  const parsed = HitMetadata.safeParse(metadata);
  if (!parsed.success || parsed.data.workerId !== searchedWorkerId) return null;
  return { evidenceId: parsed.data.evidenceId, version: parsed.data.evidenceVersion };
}
