/**
 * Fictional demo PDFs, generated per worker. PURE except for writeDemoDocuments.
 *
 * Alex Morgan's three documents are byte-for-byte what the original generator
 * produced (files/ and upload/ at the top level). A rehearsal worker (identified
 * by a slug) gets its OWN directory, its own name on every page and its own
 * certificate/record identifiers, so no rehearsal document ever names another
 * person or reuses another worker's numbers.
 *
 *   supabase/seed/files/<slug>/   historical originals uploaded by seed-demo.ts
 *   supabase/seed/upload/<slug>/  the checklist to upload live during the demo
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DEMO_WORKER } from "./demo-data";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

export const ALEX_IDENTIFIERS = { training: "NW-TRN-2025-0314-DEMO", epa: "DEMO-608-000123" } as const;

const digest = (slug: string, purpose: string) => createHash("sha256").update(`qualitrail-demo-docs:${slug}:${purpose}`).digest("hex");

export interface DemoIdentifiers {
  /** Manufacturer training certificate number. */
  training: string;
  /** EPA Section 608 certificate number (fictional). */
  epa: string;
}

/** Alex keeps the original numbers; every slug gets distinct, deterministic ones. */
export function demoIdentifiers(slug?: string): DemoIdentifiers {
  if (!slug) return { ...ALEX_IDENTIFIERS };
  const tag = digest(slug, "training").slice(0, 6).toUpperCase();
  const n = (parseInt(digest(slug, "epa").slice(0, 8), 16) % 900000) + 100000;
  return { training: `NW-TRN-2025-0314-${tag}`, epa: `DEMO-608-${String(n)}` };
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Minimal single-page text PDF, no dependencies. */
export function buildPdf(lines: string[]): Buffer {
  const content = ["BT", "/F1 11 Tf", "14 TL", "56 780 Td", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Text of a PDF made by buildPdf, read back from the actual bytes (for verification). */
export function pdfText(bytes: Buffer | Uint8Array): string {
  const src = Buffer.from(bytes).toString("latin1");
  return [...src.matchAll(/\(((?:\\.|[^\\)])*)\) '/g)].map((m) => m[1].replace(/\\([\\()])/g, "$1")).join("\n");
}

const NOTICE = "FICTIONAL DOCUMENT FOR A SOFTWARE DEMONSTRATION. All names, companies and numbers are invented.";

export type DemoDocumentKey = "training" | "epa" | "checklist";

export interface DemoDocument {
  key: DemoDocumentKey;
  /** Base name; matches DemoEvidence.fileName for the historical records. */
  fileName: string;
  /** Path relative to supabase/seed. */
  relativePath: string;
  /** True for the checklist that is uploaded live, not seeded. */
  uploadedLive: boolean;
  bytes: Buffer;
}

export interface DemoDocumentSet {
  workerName: string;
  slug: string | null;
  identifiers: DemoIdentifiers;
  documents: DemoDocument[];
}

function linesFor(key: DemoDocumentKey, name: string, ids: DemoIdentifiers): string[] {
  switch (key) {
    case "training":
      return [
        NOTICE, "",
        "NORTHWIND CLIMATE SYSTEMS TRAINING CENTER (fictional manufacturer)",
        "CERTIFICATE OF COMPLETION", "",
        "Heat-Pump Installation & Startup Training", "",
        `This certifies that ${name} completed the 16-hour manufacturer`,
        "installation course for the Northwind NX-series air-source heat pump.",
        "Topics: heat-pump installation, refrigerant line-set brazing,",
        "manufacturer startup procedure.", "",
        "Date of completion: 2025-03-14",
        `Certificate number: ${ids.training}`,
        "Issued by: Northwind Climate Systems Training Center (fictional manufacturer)",
      ];
    case "epa":
      return [
        NOTICE, "",
        "SAMPLE CERTIFYING ORGANIZATION (fictional, demo only)",
        "EPA SECTION 608 TECHNICIAN CERTIFICATION", "",
        `Technician: ${name}`,
        "Certification type: Universal",
        `Certificate number: ${ids.epa}`,
        "Date certified: 2026-06-05",
        "Issued by: Sample Certifying Organization (fictional, demo only)",
        "Expiration: none stated",
      ];
    case "checklist":
      return [
        NOTICE, "",
        "DESERT AIR MECHANICAL (fictional employer)",
        "HEAT-PUMP COMMISSIONING CHECKLIST - RESIDENTIAL INSTALL", "",
        `Technician: ${name}`,
        "Date: 2026-11-12",
        "Equipment: 3-ton ducted air-source heat pump (fictional model)", "",
        "[x] Refrigerant charge verified by subcooling",
        "[x] Total external static pressure measured",
        "[x] Supply airflow confirmed at 400 CFM per ton",
        "[x] Defrost cycle tested",
        "[x] Auxiliary heat tested",
        "[x] Condensate drain checked", "",
        `Commissioning completed by: ${name}, 2026-11-12`,
        "Employer: Desert Air Mechanical (fictional employer)",
      ];
  }
}

const FILE_NAMES: Record<DemoDocumentKey, string> = {
  training: "e1-manufacturer-training.pdf",
  epa: "e3-epa-608-card.pdf",
  checklist: "demo-commissioning-checklist.pdf",
};

/** No slug: Alex's original documents. A slug: that fictional worker's own set. */
export function demoDocumentSet(opts: { name: string; slug?: string }): DemoDocumentSet {
  const { slug } = opts;
  if (slug !== undefined) {
    if (!SLUG.test(slug)) throw new Error("DEMO_WORKER_SLUG must be 3-40 characters: lowercase letters, digits and hyphens.");
    if (slug === "alex-morgan") throw new Error("alex-morgan is the existing demo worker; choose a different DEMO_WORKER_SLUG.");
  }
  const identifiers = demoIdentifiers(slug);
  const keys: DemoDocumentKey[] = ["training", "epa", "checklist"];
  const documents = keys.map((key): DemoDocument => {
    const uploadedLive = key === "checklist";
    const dir = uploadedLive ? "upload" : "files";
    const fileName = FILE_NAMES[key];
    return {
      key,
      fileName,
      relativePath: slug ? `${dir}/${slug}/${fileName}` : `${dir}/${fileName}`,
      uploadedLive,
      bytes: buildPdf(linesFor(key, opts.name, identifiers)),
    };
  });
  return { workerName: opts.name, slug: slug ?? null, identifiers, documents };
}

/** The Alex set, using his name from the seed data. */
export const alexDocumentSet = () => demoDocumentSet({ name: DEMO_WORKER.name });

/**
 * Write a set under `seedRoot`. Every path is checked to stay inside it, and a
 * rehearsal set can only be written inside its own slug directories, so one
 * worker's generator can never replace another worker's (or Alex's) files.
 */
export function writeDemoDocuments(seedRoot: string, set: DemoDocumentSet): string[] {
  const root = resolve(seedRoot);
  const written: string[] = [];
  for (const d of set.documents) {
    const target = resolve(root, d.relativePath);
    if (!target.startsWith(root + sep)) throw new Error(`Refusing to write outside the seed directory: ${d.relativePath}`);
    if (set.slug && !target.split(sep).includes(set.slug)) throw new Error(`Refusing to write ${d.relativePath}: not inside the worker's own directory.`);
    if (!set.slug && /\/(?:files|upload)\/[^/]+\//.test(d.relativePath)) throw new Error("Alex's documents live at the top level.");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, d.bytes);
    written.push(target);
  }
  return written;
}

export const absolutePathOf = (seedRoot: string, d: DemoDocument) => join(resolve(seedRoot), d.relativePath);
