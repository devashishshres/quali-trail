import { describe, expect, it } from "vitest";
import { ListOpportunitiesResponse } from "@/lib/types";
import { toOpportunity, type OpportunityRow, type RequirementRow } from "@/lib/server/opportunities/mappers";
import { DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, REQUIREMENT_SOURCE } from "@/supabase/seed/demo-data";

const oppRow: OpportunityRow = {
  id: DEMO_OPPORTUNITY.id,
  worker_id: "a0000000-0000-4000-8000-000000000001",
  title: DEMO_OPPORTUNITY.title,
  employer: DEMO_OPPORTUNITY.employer,
  description: DEMO_OPPORTUNITY.description,
  source_url: null,
  is_synthetic: true,
};

const reqRows: RequirementRow[] = DEMO_REQUIREMENTS.map((r) => ({
  id: r.id,
  opportunity_id: DEMO_OPPORTUNITY.id,
  position: r.position,
  original_text: r.originalText,
  criteria_json: r.criteria,
  mandatory: r.mandatory,
  source: REQUIREMENT_SOURCE,
}));

describe("toOpportunity", () => {
  it("maps seeded rows to a valid ListOpportunitiesResponse", () => {
    const body = { opportunities: [toOpportunity(oppRow, reqRows)] };
    expect(ListOpportunitiesResponse.safeParse(body).success).toBe(true);
  });

  it("orders requirements by position and keeps the original wording and source", () => {
    const opp = toOpportunity(oppRow, [...reqRows].reverse());
    expect(opp.requirements.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(opp.requirements[0].originalText).toBe(DEMO_REQUIREMENTS[0].originalText);
    expect(opp.requirements[0].source).toBe(REQUIREMENT_SOURCE);
    expect(opp.isSynthetic).toBe(true);
  });

  it("fails loudly on malformed criteria_json", () => {
    const bad = [{ ...reqRows[0], criteria_json: { keywords: [] } }];
    expect(() => toOpportunity(oppRow, bad)).toThrow();
  });
});
