/**
 * Attribution consistency for a planned demo worker. PURE.
 * Before anything is written, every document and every seeded field must name the
 * right person and carry the right numbers. Returns a list of problems (empty = consistent).
 */
import { DEMO_WORKER } from "./demo-data";
import { ALEX_IDENTIFIERS, pdfText, type DemoDocumentSet } from "./demo-documents";
import type { DemoPlan } from "./synthetic-worker";

export function attributionProblems(plan: DemoPlan, set: DemoDocumentSet): string[] {
  const problems: string[] = [];
  const isAlex = plan.isOriginal;
  const forbiddenNames = isAlex ? [] : [DEMO_WORKER.name, DEMO_WORKER.name.split(" ")[0]];

  if (set.workerName !== plan.worker.name) problems.push(`documents are written for "${set.workerName}" but the worker is "${plan.worker.name}"`);

  const texts = new Map<string, string>();
  for (const d of set.documents) {
    const text = pdfText(d.bytes);
    texts.set(d.key, text);
    if (d.key !== "training" && !text.includes(plan.worker.name)) problems.push(`${d.fileName} does not name ${plan.worker.name}`);
    if (d.key === "training" && !text.includes(`certifies that ${plan.worker.name} `)) problems.push(`${d.fileName} does not name ${plan.worker.name}`);
    for (const n of forbiddenNames) if (new RegExp(`\\b${n}\\b`).test(text)) problems.push(`${d.fileName} mentions ${n}`);
    if (!isAlex) for (const id of Object.values(ALEX_IDENTIFIERS)) if (text.includes(id)) problems.push(`${d.fileName} reuses Alex's identifier ${id}`);
  }

  const metadata = JSON.stringify({ worker: plan.worker, evidence: plan.evidence, opportunity: plan.opportunity, requirements: plan.requirements });
  for (const n of forbiddenNames) if (new RegExp(`\\b${n}\\b`).test(metadata)) problems.push(`seeded metadata mentions ${n}`);
  if (!isAlex) for (const id of Object.values(ALEX_IDENTIFIERS)) if (metadata.includes(id)) problems.push(`seeded metadata reuses Alex's identifier ${id}`);

  // The credential number stored for a record must be the one printed on its document.
  for (const e of plan.evidence) {
    const doc = set.documents.find((d) => d.fileName === e.fileName);
    if (!doc) continue;
    const number = e.structuredData.credentialNumber;
    if (number && !texts.get(doc.key)?.includes(number)) problems.push(`"${e.title}" stores credential number ${number}, which is not printed on ${doc.fileName}`);
  }
  return problems;
}
