/** Grounding rules for AI-written text: claims must come from records, limitations must survive. Fictional data. */
import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/types";
import { groundingProblem, quoteRecord } from "@/lib/server/explanations/grounding";

let n = 0;
function rec(activities: string[], summary: string | null = null): Evidence {
  n += 1;
  return { id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, workerId: "a0000000-0000-4000-8000-000000000001", type: "work_record", title: "Fictional job record", date: "2025-03-01", issuer: null, structuredData: { skills: [], activities, equipment: [], expirationDate: null, credentialNumber: null, summary }, sourceKind: "seed", sourceAvailable: true, verificationStatus: "self_reported", indexStatus: "indexed", indexError: null, isSynthetic: true, version: 1, createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" };
}
const records = [rec(["Brazed line set"]), rec(["Assisted the lead with evacuation"]), rec(["Startup was done by another crew"]), rec(["Did not pressure test the system"]), rec(["Visited site"], "Charged the system to spec.")];
const REQ = "Proficiency with brazing, pressure testing, evacuation, refrigerant charging, leak testing and system start-up";
const g = (t: string, requirementText = REQ) => groundingProblem(t, records, requirementText);

describe("claims about the worker need grounding, not just a blocked-word list", () => {
  it.each([
    "You satisfy this requirement.",
    "You satisfy it.",
    "This line is satisfied.",
    "These records fulfil what the employer asks.",
    "Your experience is sufficient here.",
    "This is enough for the role.",
    "The records demonstrate the skill.",
    "That covers it.",
    "It matches the listing.",
    "You'd be a good fit.",
    "The employer will find you suitable.",
  ])("fulfilment: %s", (t) => expect(g(t)).toBe("fulfilment_claim"));

  it.each([
    "You have done this work for years.",
    "Your records show brazing and charging.",
    "The technician can handle this job.",
    "They did all of it.",
    "Clearly you know this work.",
    "You are skilled at installs.",
    "You lack pressure testing experience.",
    "You are not qualified for this part.",
    "You are unable to do pressure testing.",
  ])("worker claim or ability judgement: %s", (t) => expect(g(t)).not.toBeNull());
});

describe("AI text cannot contradict the task check", () => {
  it.each([
    ["Evacuation was performed.", "assisted"],
    ["The startup was completed on the job.", "done by others"],
    ["Pressure testing was carried out.", "not done"],
    ["Refrigerant charging is part of the work history.", "summary only"],
    ["Leak testing appears in the work.", "not found"],
  ])("%s (%s) is rejected", (t) => expect(g(t)).toBe("contradicts_records"));

  it.each([
    "Evacuation is listed as assisted only",
    "Startup was done by another crew, according to the record",
    "Pressure testing is not stated",
    "Refrigerant charging is mentioned only in a summary",
    "Leak testing is not mentioned",
    "Brazing appears in the line set record", // documented: no limitation needed
  ])("keeping the limitation is allowed: %s", (t) => expect(g(t)).toBeNull());
});

describe("quoted record descriptions", () => {
  it("quote only the record's own relevant lines, keeping limitation wording; never the summary", () => {
    const r = rec(["Assisted the lead with evacuation", "Replaced thermostat"], "Charged the system; customer Jane Roe");
    expect(quoteRecord(r, "Proficiency with evacuation and refrigerant charging")).toBe('Work performed: "Assisted the lead with evacuation" (self-reported).');
  });
  it("return nothing when no permitted field relates (a record is never linked by its title alone)", () => {
    expect(quoteRecord(rec(["Replaced thermostat"]), "Ability to read blueprints")).toBeNull();
  });
});
