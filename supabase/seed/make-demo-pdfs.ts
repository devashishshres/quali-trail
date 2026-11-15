/**
 * Generates the FICTIONAL demo PDFs (no dependencies, plain text pages).
 *   npx tsx supabase/seed/make-demo-pdfs.ts
 * Every person, company, issuer and number is invented and labelled as such.
 *   supabase/seed/files/   -> uploaded by seed-demo.ts as originals of historical records
 *   supabase/seed/upload/  -> NOT seeded: the checklist you upload live during the demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function pdf(lines: string[]): Buffer {
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

const NOTICE = "FICTIONAL DOCUMENT FOR A SOFTWARE DEMONSTRATION. All names, companies and numbers are invented.";

const docs: Record<string, string[]> = {
  "files/e1-manufacturer-training.pdf": [
    NOTICE, "",
    "NORTHWIND CLIMATE SYSTEMS TRAINING CENTER (fictional manufacturer)",
    "CERTIFICATE OF COMPLETION", "",
    "Heat-Pump Installation & Startup Training", "",
    "This certifies that Alex Morgan completed the 16-hour manufacturer",
    "installation course for the Northwind NX-series air-source heat pump.",
    "Topics: heat-pump installation, refrigerant line-set brazing,",
    "manufacturer startup procedure.", "",
    "Date of completion: 2025-03-14",
    "Certificate number: NW-TRN-2025-0314-DEMO",
    "Issued by: Northwind Climate Systems Training Center (fictional manufacturer)",
  ],
  "files/e3-epa-608-card.pdf": [
    NOTICE, "",
    "SAMPLE CERTIFYING ORGANIZATION (fictional, demo only)",
    "EPA SECTION 608 TECHNICIAN CERTIFICATION", "",
    "Technician: Alex Morgan",
    "Certification type: Universal",
    "Certificate number: DEMO-608-000123",
    "Date certified: 2026-06-05",
    "Issued by: Sample Certifying Organization (fictional, demo only)",
    "Expiration: none stated",
  ],
  "upload/demo-commissioning-checklist.pdf": [
    NOTICE, "",
    "DESERT AIR MECHANICAL (fictional employer)",
    "HEAT-PUMP COMMISSIONING CHECKLIST - RESIDENTIAL INSTALL", "",
    "Technician: Alex Morgan",
    "Date: 2026-11-12",
    "Equipment: 3-ton ducted air-source heat pump (fictional model)", "",
    "[x] Refrigerant charge verified by subcooling",
    "[x] Total external static pressure measured",
    "[x] Supply airflow confirmed at 400 CFM per ton",
    "[x] Defrost cycle tested",
    "[x] Auxiliary heat tested",
    "[x] Condensate drain checked", "",
    "Commissioning completed by: Alex Morgan, 2026-11-12",
    "Employer: Desert Air Mechanical (fictional employer)",
  ],
};

const root = join(process.cwd(), "supabase", "seed");
for (const [path, lines] of Object.entries(docs)) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), pdf(lines));
  console.log("wrote", path);
}
