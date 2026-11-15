import { describe, expect, it } from "vitest";
import { toEvidence, type EvidenceRow } from "../lib/supabase/mappers";
import {
  ConfirmEvidenceRequest,
  ExtractedEvidence,
  RequirementCriteria,
  StructuredEvidenceData,
} from "../lib/types";
import { DEMO_EVIDENCE, DEMO_REQUIREMENTS } from "../supabase/seed/demo-data";

const baseRow: EvidenceRow = {
  id: DEMO_EVIDENCE[0].id,
  worker_id: "a0000000-0000-4000-8000-000000000001",
  type: "training",
  title: "Training",
  source_date: "2025-03-14",
  issuer: "Issuer",
  structured_data: {},
  source_kind: "seed",
  storage_path: null,
  verification_status: "document_supplied",
  index_status: "pending",
  index_error: null,
  is_synthetic: true,
  version: 1,
  // Exactly what PostgREST returns for timestamptz (microseconds + offset).
  created_at: "2026-11-14T17:00:00.123456+00:00",
  updated_at: "2026-11-14T17:00:00.123456+00:00",
};

describe("demo data matches the contracts", () => {
  it.each(DEMO_EVIDENCE)("evidence $title is valid", (e) => {
    expect(() => StructuredEvidenceData.parse(e.structuredData)).not.toThrow();
    expect(() =>
      toEvidence({ ...baseRow, id: e.id, type: e.type, title: e.title, structured_data: e.structuredData }),
    ).not.toThrow();
  });

  it.each(DEMO_REQUIREMENTS)("requirement $position criteria are valid", (r) => {
    expect(() => RequirementCriteria.parse(r.criteria)).not.toThrow();
  });

  it("the EPA 608 record has no generic expiry date", () => {
    const epa = DEMO_EVIDENCE.find((e) => e.title.includes("608"));
    expect(epa?.structuredData.expirationDate).toBeNull();
  });
});

describe("mappers", () => {
  it("maps a database row to the Evidence contract", () => {
    const evidence = toEvidence(baseRow);
    expect(evidence.date).toBe("2025-03-14");
    expect(evidence.sourceAvailable).toBe(false);
    expect(evidence.structuredData.skills).toEqual([]); // defaults filled in
  });

  it("reports sourceAvailable only when a stored file exists", () => {
    expect(toEvidence({ ...baseRow, storage_path: "u/e.pdf" }).sourceAvailable).toBe(true);
  });

  it("rejects an unknown verification status from the database", () => {
    expect(() => toEvidence({ ...baseRow, verification_status: "verified_by_ai" })).toThrow();
  });
});

describe("request validation", () => {
  it("Gemini output may leave every field null (no invented values)", () => {
    const parsed = ExtractedEvidence.parse({
      type: null,
      title: null,
      date: null,
      issuer: null,
      structuredData: {},
    });
    expect(parsed.uncertainFields).toEqual([]);
  });

  it("rejects badly formatted dates from Gemini", () => {
    expect(() =>
      ExtractedEvidence.parse({ type: null, title: null, date: "June 2026", issuer: null, structuredData: {} }),
    ).toThrow();
  });

  it("confirm requests cannot smuggle in a verification status", () => {
    const parsed = ConfirmEvidenceRequest.parse({
      draftId: "d0000000-0000-4000-8000-000000000001",
      fields: {
        type: "checklist",
        title: "Commissioning checklist",
        date: "2026-11-14",
        issuer: null,
        structuredData: {},
        verificationStatus: "independently_confirmed",
      },
    });
    expect(parsed.fields).not.toHaveProperty("verificationStatus");
  });
});
