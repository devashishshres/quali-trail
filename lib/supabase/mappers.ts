/**
 * Convert database rows (snake_case) into API contracts (camelCase).
 * Every mapper validates with Zod, so a schema drift fails loudly here
 * instead of silently sending bad data to the UI.
 */
import { Evidence, StructuredEvidenceData, Worker } from "../types";

export interface WorkerRow {
  id: string;
  name: string;
  trade: string;
  is_synthetic: boolean;
  /** Not selected by WORKER_COLUMNS: read separately so sign-in never depends on the optional column. */
  summary?: string | null;
}

export interface EvidenceRow {
  id: string;
  worker_id: string;
  type: string;
  title: string;
  source_date: string | null;
  issuer: string | null;
  structured_data: unknown;
  source_kind: string;
  storage_path: string | null;
  verification_status: string;
  index_status: string;
  index_error: string | null;
  is_synthetic: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Columns to select for an EvidenceRow. Keep in sync with the interface above. */
export const EVIDENCE_COLUMNS =
  "id, worker_id, type, title, source_date, issuer, structured_data, source_kind, storage_path, verification_status, index_status, index_error, is_synthetic, version, created_at, updated_at";

export const WORKER_COLUMNS = "id, name, trade, is_synthetic";

export function toWorker(row: WorkerRow): Worker {
  return Worker.parse({
    id: row.id,
    name: row.name,
    trade: row.trade,
    summary: row.summary ?? null,
    isSynthetic: row.is_synthetic,
  });
}

export function toEvidence(row: EvidenceRow): Evidence {
  return Evidence.parse({
    id: row.id,
    workerId: row.worker_id,
    type: row.type,
    title: row.title,
    date: row.source_date,
    issuer: row.issuer,
    structuredData: StructuredEvidenceData.parse(row.structured_data ?? {}),
    sourceKind: row.source_kind,
    sourceAvailable: row.storage_path !== null,
    verificationStatus: row.verification_status,
    indexStatus: row.index_status,
    indexError: row.index_error,
    isSynthetic: row.is_synthetic,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
