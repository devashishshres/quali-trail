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
}

export interface RequirementRow {
  id: string;
  opportunity_id: string;
  position: number;
  original_text: string;
  criteria_json: unknown;
  mandatory: boolean;
  source: string;
}

export const OPPORTUNITY_COLUMNS = "id, worker_id, title, employer, description, source_url, is_synthetic";
export const REQUIREMENT_COLUMNS = "id, opportunity_id, position, original_text, criteria_json, mandatory, source";

export function toRequirement(row: RequirementRow): Requirement {
  return Requirement.parse({
    id: row.id,
    opportunityId: row.opportunity_id,
    position: row.position,
    originalText: row.original_text,
    mandatory: row.mandatory,
    criteria: row.criteria_json,
    source: row.source,
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
  });
}
