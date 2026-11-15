/**
 * Database rows -> Opportunity contracts. Validates with Zod so a schema
 * drift (or a malformed criteria_json) fails loudly instead of reaching the UI.
 * No "server-only" import: pure, so unit tests can use it.
 */
import { Opportunity, Requirement } from "@/lib/types";

export interface OpportunityRow {
  id: string;
  worker_id: string;
  title: string;
  employer: string;
  description: string;
  source_url: string | null;
  is_synthetic: boolean;
  /* Job-import columns (20261118100000). Absent before that migration, so all optional. */
  import_id?: string | null;
  source_kind?: "listing_url" | "pasted_text" | null;
  location?: string | null;
  retrieved_at?: string | null;
  final_url?: string | null;
  import_warnings?: string[] | null;
  removed_count?: number | null;
  edited_count?: number | null;
}

export interface RequirementRow {
  id: string;
  opportunity_id: string;
  position: number;
  original_text: string;
  criteria_json: unknown;
  mandatory: boolean;
  source: string;
  priority?: string | null;
  original_priority?: string | null;
  display_text?: string | null;
  category?: string | null;
}

/**
 * "*" on purpose: the app keeps working whether or not the additive job-import migration has been applied
 * (the optional columns simply come back absent). Only the fields mapped below ever leave the server.
 */
export const OPPORTUNITY_COLUMNS = "*";
export const REQUIREMENT_COLUMNS = "*";

export function toRequirement(row: RequirementRow): Requirement {
  return Requirement.parse({
    id: row.id,
    opportunityId: row.opportunity_id,
    position: row.position,
    originalText: row.original_text,
    mandatory: row.mandatory,
    criteria: row.criteria_json,
    source: row.source,
    priority: row.priority ?? null,
    originalPriority: row.original_priority ?? null,
    displayText: row.display_text ?? null,
    category: row.category ?? null,
  });
}

export function toOpportunity(row: OpportunityRow, requirements: RequirementRow[]): Opportunity {
  return Opportunity.parse({
    id: row.id,
    title: row.title,
    employer: row.employer,
    description: row.description,
    sourceUrl: row.source_url,
    isSynthetic: row.is_synthetic,
    requirements: [...requirements].sort((a, b) => a.position - b.position).map(toRequirement),
    importInfo:
      row.import_id && row.source_kind
        ? {
            importId: row.import_id,
            sourceKind: row.source_kind,
            location: row.location ?? null,
            retrievedAt: row.retrieved_at ? new Date(row.retrieved_at).toISOString() : null,
            finalUrl: row.final_url ?? null,
            warnings: row.import_warnings ?? [],
            removedCount: row.removed_count ?? 0,
            editedCount: row.edited_count ?? 0,
          }
        : null,
  });
}
