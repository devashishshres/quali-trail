import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { attributionProblems } from "@/supabase/seed/attribution";
import { ALEX_IDENTIFIERS, alexDocumentSet, demoDocumentSet, demoIdentifiers, pdfText, writeDemoDocuments } from "@/supabase/seed/demo-documents";
import { planDemoWorker } from "@/supabase/seed/synthetic-worker";

const SEED_ROOT = join(process.cwd(), "supabase", "seed");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const jordan = () => demoDocumentSet({ name: "Jordan Rivera", slug: "rehearsal-1" });
const sam = () => demoDocumentSet({ name: "Sam Okafor", slug: "rehearsal-2" });
const allText = (set: ReturnType<typeof jordan>) => set.documents.map((d) => pdfText(d.bytes)).join("\n");

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "qualitrail-docs-"));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listFiles(join(dir, n)) : [join(dir, n)]));
}

describe("Alex Morgan's original documents are preserved", () => {
  it("regenerating them reproduces the committed files byte for byte", () => {
    for (const d of alexDocumentSet().documents) {
      expect(readFileSync(join(SEED_ROOT, d.relativePath)).equals(d.bytes), d.relativePath).toBe(true);
    }
  });

  it("keeps their original paths and numbers", () => {
    const set = alexDocumentSet();
    expect(set.documents.map((d) => d.relativePath)).toEqual(["files/e1-manufacturer-training.pdf", "files/e3-epa-608-card.pdf", "upload/demo-commissioning-checklist.pdf"]);
    expect(set.identifiers).toEqual(ALEX_IDENTIFIERS);
  });
});

describe("rehearsal workers' documents", () => {
  it("name the right worker on every page and never mention Alex Morgan", () => {
    for (const [set, name] of [[jordan(), "Jordan Rivera"], [sam(), "Sam Okafor"]] as const) {
      for (const d of set.documents) {
        const text = pdfText(d.bytes);
        expect(text, `${name} ${d.fileName}`).toContain(name);
        expect(text).not.toMatch(/Alex|Morgan/);
      }
    }
  });

  it("read back through real PDF bytes, including escaped parentheses", () => {
    expect(allText(jordan())).toContain("(fictional manufacturer)");
    expect(jordan().documents.every((d) => d.bytes.subarray(0, 5).toString() === "%PDF-")).toBe(true);
  });

  it("carry distinct certificate numbers, none of them Alex's", () => {
    const a = demoIdentifiers("rehearsal-1");
    const b = demoIdentifiers("rehearsal-2");
    const numbers = [a.training, a.epa, b.training, b.epa, ALEX_IDENTIFIERS.training, ALEX_IDENTIFIERS.epa];
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(demoIdentifiers("rehearsal-1")).toEqual(a);
    expect(allText(jordan())).toContain(a.training);
    expect(allText(jordan())).toContain(a.epa);
    expect(allText(jordan())).not.toContain(ALEX_IDENTIFIERS.training);
    expect(allText(jordan())).not.toContain(ALEX_IDENTIFIERS.epa);
    expect(allText(sam())).toContain(b.epa);
  });

  it("have different bytes (and so different file hashes) from every other worker's documents", () => {
    const hashes = [...alexDocumentSet().documents, ...jordan().documents, ...sam().documents].map((d) => sha(d.bytes));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("use their own directories, separate from Alex and from each other", () => {
    const paths = [...alexDocumentSet().documents, ...jordan().documents, ...sam().documents].map((d) => d.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const d of jordan().documents) expect(d.relativePath).toContain("/rehearsal-1/");
    for (const d of sam().documents) expect(d.relativePath).toContain("/rehearsal-2/");
  });

  it("the live-upload checklist is the one for that worker", () => {
    const c = jordan().documents.find((d) => d.uploadedLive)!;
    expect(c.relativePath).toBe("upload/rehearsal-1/demo-commissioning-checklist.pdf");
    expect(pdfText(c.bytes)).toContain("Technician: Jordan Rivera");
    expect(pdfText(c.bytes)).toContain("Commissioning completed by: Jordan Rivera");
  });
});

describe("writing documents cannot overwrite another worker's files", () => {
  it("writing Jordan then Sam leaves Alex's and Jordan's files untouched", () => {
    const root = scratch();
    writeDemoDocuments(root, alexDocumentSet());
    writeDemoDocuments(root, jordan());
    const before = Object.fromEntries(listFiles(root).map((f) => [f, sha(readFileSync(f))]));
    writeDemoDocuments(root, sam());
    const after = Object.fromEntries(listFiles(root).map((f) => [f, sha(readFileSync(f))]));
    for (const [f, h] of Object.entries(before)) expect(after[f], f).toBe(h);
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length + 3);
  });

  it("a slug that tries to leave its directory or collide with Alex is rejected", () => {
    expect(() => demoDocumentSet({ name: "X", slug: "../evil" })).toThrow(/DEMO_WORKER_SLUG/);
    expect(() => demoDocumentSet({ name: "X", slug: "a/b" })).toThrow(/DEMO_WORKER_SLUG/);
    expect(() => demoDocumentSet({ name: "X", slug: "alex-morgan" })).toThrow(/existing demo worker/);
  });

  it("refuses to write a rehearsal file outside the seed directory or its own slug directory", () => {
    const root = scratch();
    const set = jordan();
    set.documents[0].relativePath = "../escape.pdf";
    expect(() => writeDemoDocuments(root, set)).toThrow(/outside/);
    const set2 = jordan();
    set2.documents[0].relativePath = "files/e1-manufacturer-training.pdf"; // Alex's path
    expect(() => writeDemoDocuments(root, set2)).toThrow(/own directory/);
  });
});

describe("attribution consistency (names, identifiers, stored metadata vs printed text)", () => {
  it("is clean for Alex and for each rehearsal worker", () => {
    expect(attributionProblems(planDemoWorker({}), alexDocumentSet())).toEqual([]);
    expect(attributionProblems(planDemoWorker({ slug: "rehearsal-1", name: "Jordan Rivera" }), jordan())).toEqual([]);
    expect(attributionProblems(planDemoWorker({ slug: "rehearsal-2", name: "Sam Okafor" }), sam())).toEqual([]);
  });

  it("stored credential numbers are the ones printed on that worker's own documents", () => {
    const plan = planDemoWorker({ slug: "rehearsal-1", name: "Jordan Rivera" });
    const ids = demoIdentifiers("rehearsal-1");
    const numbers = plan.evidence.map((e) => e.structuredData.credentialNumber).filter(Boolean);
    expect(numbers).toEqual([ids.training, ids.epa]);
  });

  it("catches documents that name the wrong person", () => {
    const plan = planDemoWorker({ slug: "rehearsal-1", name: "Jordan Rivera" });
    const problems = attributionProblems(plan, alexDocumentSet());
    expect(problems.join("\n")).toMatch(/Alex Morgan|mentions Alex|reuses Alex/);
  });

  it("catches seeded metadata that still names Alex or reuses his numbers", () => {
    const plan = planDemoWorker({ slug: "rehearsal-1", name: "Jordan Rivera" });
    plan.evidence[0].structuredData.credentialNumber = ALEX_IDENTIFIERS.training;
    plan.evidence[1].structuredData.summary = "Alex Morgan performed this startup.";
    const problems = attributionProblems(plan, jordan()).join("\n");
    expect(problems).toContain("reuses Alex's identifier");
    expect(problems).toContain("metadata mentions Alex");
  });
});
