import { describe, expect, it } from "vitest";
import { analyzeRequirement, normalizeLine } from "@/lib/server/opportunities/requirement-rules";
import { RequirementCriteria } from "@/lib/types";

const ids = (t: string) => {
  const r = analyzeRequirement(t).rule;
  return r.kind === "supported" ? r.conditions.map((c) => c.id) : null;
};
const reasons = (t: string) => {
  const r = analyzeRequirement(t).rule;
  return r.kind === "review_only" ? r.reasons : [];
};

describe("supported catalog wording", () => {
  it.each([
    ["EPA 608 certification", ["epa608"]],
    ["Must hold a valid EPA Section 608 certification.", ["epa608"]],
    ["EPA 608 Universal certification required", ["epa608_universal"]],
    ["EPA Universal certification", ["epa608_universal"]],
    ["EPA Section 608 Type II certification", ["epa608_type2"]],
    ["Must hold an EPA Section 608 certification (Type II or Universal).", ["epa608_type2"]],
    ["NATE certification preferred", ["nate"]],
    ["North American Technician Excellence (NATE) certified", ["nate"]],
    ["OSHA 10-Hour card", ["osha10"]],
    ["OSHA 30", ["osha30"]],
    ["Experience installing heat pumps", ["hp_install"]],
    ["Hands-on experience with heat pump installation", ["hp_install"]],
    ["Documented hands-on experience installing and starting up residential heat-pump systems.", ["hp_install", "hp_startup"]],
    ["Heat pump installation and commissioning experience", ["hp_install", "hp_commissioning"]],
    ["Brazing experience", ["brazing"]],
    ["Commissioning experience", ["commissioning"]],
    ["EPA 608 Universal and NATE certification", ["epa608_universal", "nate"]],
    ["EPA 608 certification, OSHA 10 card and brazing experience", ["epa608", "osha10", "brazing"]],
  ])("%s", (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });

  it("criteria always validate against the contract", () => {
    for (const t of ["EPA 608 certification", "Valid driver's license", "Some unknown thing", "Brazing experience"]) {
      expect(RequirementCriteria.safeParse(analyzeRequirement(t).criteria).success).toBe(true);
    }
  });

  it("scoped EPA conditions require the scope term, Universal accepted for a type", () => {
    const r = analyzeRequirement("EPA 608 Type II").rule;
    expect(r.kind === "supported" && r.conditions[0].termGroups).toEqual([["608"], ["type ii", "type 2", "universal"]]);
  });

  it("residential qualifiers become a stated-term requirement, not silently ignored", () => {
    const r = analyzeRequirement("Experience installing residential heat pumps").rule;
    expect(r.kind === "supported" && r.conditions[0].termGroups.length).toBe(3);
  });
});

describe("conservative: these go to cannot_assess", () => {
  it.each([
    ["3+ years of HVAC experience", "duration"],
    ["Minimum of two years installing heat pumps", "duration"],
    ["At least one completed commissioning checklist", "duration"],
    ["Valid driver's license and clean driving record", "driving"],
    ["Must be authorized to work in the US", "work_authorization"],
    ["Able to lift 50 lbs and climb ladders", "physical"],
    ["Must pass a background check and drug screen", "background_check"],
    ["High school diploma or GED", "education"],
    ["Available for on-call weekends", "schedule"],
    ["EPA 608 or equivalent", "alternatives"],
    ["EPA 608 Type I/II", "alternatives"],
    ["NATE or HVAC Excellence certification", "alternatives"],
    ["EPA 608 Type I or Type III", "alternatives"],
    ["No EPA 608 certification needed", "negation"],
    ["EPA certification", "unsupported_wording"],
    ["Strong customer service skills", "unsupported_wording"],
    ["EPA 608 certification with NATE preferred", "unsupported_wording"],
    ["NATE certified in heat pump installation", "unsupported_wording"],
    ["OSHA 10 construction", "unsupported_wording"],
    ["Experience installing commercial rooftop units", "unsupported_wording"],
    ["Brazing and soldering experience", "unsupported_wording"],
    ["EPA 608 Type I and Type II", "unsupported_wording"],
    ["EPA 608 core", "unsupported_wording"],
  ])("%s -> %s", (text, reason) => {
    expect(ids(text)).toBeNull();
    expect(reasons(text)).toContain(reason);
  });

  it("splitting on 'and' alone is not enough: unknown halves stay unassessed", () => {
    expect(ids("EPA 608 certification and troubleshooting skills")).toBeNull();
  });

  it("priority words are filler only for a single phrase", () => {
    expect(ids("EPA 608 Universal preferred")).toEqual(["epa608_universal"]);
    expect(ids("EPA 608 Universal, NATE preferred")).toBeNull();
  });

  it("technician's manual-review mark always wins", () => {
    expect(reasons("EPA 608 certification").length).toBe(0);
    const r = analyzeRequirement("EPA 608 certification", { manualReview: true }).rule;
    expect(r.kind).toBe("review_only");
    expect(r.kind === "review_only" && r.reasons).toContain("marked_by_technician");
    expect(r.kind === "review_only" && r.partial.map((c) => c.id)).toEqual(["epa608"]);
  });

  it("partial conditions are kept for context only", () => {
    const r = analyzeRequirement("EPA 608 Universal and 2 years experience").rule;
    expect(r.kind).toBe("review_only");
    expect(r.kind === "review_only" && r.partial.map((c) => c.id)).toEqual(["epa608_universal"]);
  });
});

it("normalizes punctuation without inventing words", () => {
  expect(normalizeLine("Driver’s License, EPA-608 (Type II)")).toBe("drivers license , epa 608 type ii");
});
