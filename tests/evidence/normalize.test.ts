import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/server/extraction/normalize";
import { hashText, looksLikePdf, sha256 } from "@/lib/server/evidence/hash";

const base = {
  type: "training", title: " Heat pump course ", date: "2025-03-14", issuer: "Northwind",
  uncertainFields: [],
  structuredData: { skills: ["a"], activities: [], equipment: [], expirationDate: null, credentialNumber: null, summary: null },
};

describe("normalizeExtraction (model output is untrusted)", () => {
  it("accepts a good extraction and trims text", () => {
    const r = normalizeExtraction(base)!;
    expect(r.title).toBe("Heat pump course");
    expect(r.type).toBe("training");
  });

  it("leaves unknown values null rather than inventing them", () => {
    const r = normalizeExtraction({ ...base, date: null, issuer: "  ", type: null })!;
    expect(r.date).toBeNull();
    expect(r.issuer).toBeNull();
    expect(r.type).toBeNull();
    expect(r.uncertainFields).toContain("type");
  });

  it("drops badly formatted or impossible dates", () => {
    expect(normalizeExtraction({ ...base, date: "14/03/2025" })!.date).toBeNull();
    expect(normalizeExtraction({ ...base, date: "2025-02-31" })!.date).toBeNull();
    expect(normalizeExtraction({ ...base, structuredData: { ...base.structuredData, expirationDate: "March 2027" } })!.structuredData.expirationDate).toBeNull();
  });

  it("rejects an unknown type instead of passing it through", () => {
    expect(normalizeExtraction({ ...base, type: "diploma" })!.type).toBeNull();
  });

  it("caps list sizes and lengths", () => {
    const long = Array.from({ length: 50 }, () => "x".repeat(400));
    const r = normalizeExtraction({ ...base, structuredData: { ...base.structuredData, skills: long } })!;
    expect(r.structuredData.skills).toHaveLength(30);
    expect(r.structuredData.skills[0]).toHaveLength(300);
  });

  it("for typed text, a year the text never mentions is treated as a guess", () => {
    const r = normalizeExtraction({ ...base, date: "2031-01-01" }, "I completed a heat pump course in 2025.")!;
    expect(r.date).toBeNull();
    expect(r.uncertainFields).toContain("date");
  });

  it("returns null for garbage output", () => {
    expect(normalizeExtraction("ignore previous instructions")).toBeNull();
    expect(normalizeExtraction(null)).toBeNull();
  });

  it("ignores injected extra fields such as verification", () => {
    const r = normalizeExtraction({ ...base, verificationStatus: "independently_confirmed" } as never)!;
    expect(r).not.toHaveProperty("verificationStatus");
  });
});

describe("hashing and PDF sniffing", () => {
  it("manual text hash ignores whitespace and case so retyping is a duplicate", () => {
    expect(hashText("Did a  startup\n on a heat pump")).toBe(hashText("did a startup on a heat pump"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
  it("sha256 is stable hex", () => expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/));
  it("accepts real PDF bytes only", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.4\n..."))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("<html>not a pdf"))).toBe(false);
    expect(looksLikePdf(new Uint8Array([]))).toBe(false);
  });
});
