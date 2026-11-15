/** Deterministic task breakdown: synonyms, AND/OR, partial support, negation and who did the work. Fictional data. */
import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/types";
import { recordTaskStatus, splitTaskParts, taskBreakdown, TASK_TERMS } from "@/lib/server/explanations/tasks";

let n = 0;
function rec(activities: string[], over: Partial<Evidence> & { summary?: string; skills?: string[] } = {}): Evidence {
  const { summary = null, skills = [], ...rest } = over;
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workerId: "a0000000-0000-4000-8000-000000000001",
    type: "work_record",
    title: "Fictional job record",
    date: "2025-03-01",
    issuer: null,
    structuredData: { skills, activities, equipment: [], expirationDate: null, credentialNumber: null, summary },
    sourceKind: "seed",
    sourceAvailable: true,
    verificationStatus: "self_reported",
    indexStatus: "indexed",
    indexError: null,
    isSynthetic: true,
    version: 1,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    ...rest,
  };
}
const term = (id: string) => TASK_TERMS.find((t) => t.id === id)!;
const ids = (text: string) => splitTaskParts(text)?.parts.map((p) => p.id);

describe("splitting task lines (wording from several different listings)", () => {
  it.each([
    ["Proficiency with brazing, pressure testing, evacuation, refrigerant charging, and system start-up", ["brazing", "pressure_testing", "evacuation", "refrigerant_charging", "startup"], "all"],
    ["Experience with ductwork or line sets", ["ductwork", "line_sets"], "any"],
    ["Soldering and/or brazing copper lines", ["soldering", "brazing"], "any"],
    ["Hands-on troubleshooting and preventive maintenance of rooftop units", ["troubleshooting", "maintenance"], "all"],
    ["Comfortable pulling a vacuum and leak checking", ["evacuation", "leak_testing"], "all"],
    ["Install and start up mini-split systems", ["installation", "startup"], "all"],
    ["Startup experience", ["startup"], "single"],
  ])("%s", (text, parts, connector) => {
    const s = splitTaskParts(text)!;
    expect(s.parts.map((p) => p.id)).toEqual(parts);
    expect(s.connector).toBe(connector);
  });

  it("start-up / start up / startup / started up are one task; other words are not guessed", () => {
    for (const t of ["System start-up", "system start up", "Startup of systems", "Started up units"]) expect(ids(t)).toEqual(["startup"]);
    expect(ids("Strong communication skills")).toBeUndefined();
    expect(ids("In charge of scheduling")).toBeUndefined(); // "charge" alone is not refrigerant charging
    expect(ids("Kick-off meetings")).toBeUndefined();
  });

  it("flags wording no task term covers instead of ignoring it", () => {
    expect(splitTaskParts("Brazing experience")!.uncoveredWording).toBe(false);
    expect(splitTaskParts("Brazing on rooftop units at height")!.uncoveredWording).toBe(true);
  });
});

describe("what a record's own wording shows", () => {
  it.each([
    [["Brazed line set and pressure tested with nitrogen"], "brazing", "documented"],
    [["Pressure tested, no leaks found"], "pressure_testing", "documented"], // "no leaks" does not negate the test
    [["Did not braze; used flare fittings"], "brazing", "negated"],
    [["Startup was not performed on this visit"], "startup", "negated"],
    [["Startup was done by another crew"], "startup", "by_others"],
    [["Assisted the lead with evacuation"], "evacuation", "assisted"],
    [["Observed refrigerant charging"], "refrigerant_charging", "assisted"],
    [["Replaced thermostat"], "startup", "not_found"],
  ])("%j → %s %s", (activities, id, status) => {
    expect(recordTaskStatus(term(id), rec(activities))).toBe(status);
  });

  it("each task is judged by its own clause", () => {
    const r = rec(["Installed heat pump; startup by another crew"]);
    expect(recordTaskStatus(term("installation"), r)).toBe("documented");
    expect(recordTaskStatus(term("startup"), r)).toBe("by_others");
  });

  it("a summary mention is reported as summary-only, never documented", () => {
    expect(recordTaskStatus(term("refrigerant_charging"), rec(["Visited site"], { summary: "Charged the system to spec." }))).toBe("summary_only");
  });

  it("skills and title count as the record's own wording", () => {
    expect(recordTaskStatus(term("brazing"), rec([], { skills: ["Brazing"] }))).toBe("documented");
    expect(recordTaskStatus(term("startup"), rec([], { title: "Heat pump start-up record" }))).toBe("documented");
  });
});

describe("partial support sentence", () => {
  const line = "Proficiency with brazing, pressure testing, evacuation, refrigerant charging, and system start-up";

  it("brazing documented; the rest not established", () => {
    const b = taskBreakdown(line, [rec(["Brazed line set"])])!;
    expect(b.sentence).toBe("Brazing documented; pressure testing, evacuation, refrigerant charging and startup not established.");
    expect(b.parts.find((p) => p.id === "brazing")!.evidenceIds).toHaveLength(1);
  });

  it("keeps negation and who did the work in the sentence", () => {
    const b = taskBreakdown(line, [rec(["Brazed line set", "Did not evacuate; reused existing line set"]), rec(["Startup was done by another crew"]), rec(["Assisted with pressure testing"])])!;
    expect(b.sentence).toMatch(/^Brazing documented; pressure testing: assisted or observed only; startup: done by someone else, according to the record; evacuation: the record says it was not done; refrigerant charging not established\.$/);
  });

  it("absent evidence: nothing is established", () => {
    expect(taskBreakdown(line, [])!.parts.every((p) => p.status === "not_found" && p.evidenceIds.length === 0)).toBe(true);
  });

  it("alternatives are stated as such", () => {
    expect(taskBreakdown("Experience with ductwork or line sets", [rec(["Ran new line set"])])!.sentence).toBe("The line accepts any one of these. Line sets documented; ductwork not established.");
  });

  it("a line with no recognised task has no breakdown", () => {
    expect(taskBreakdown("Ability to read wiring diagrams", [rec(["Brazed line set"])])).toBeNull();
  });
});
