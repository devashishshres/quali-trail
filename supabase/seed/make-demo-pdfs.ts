/**
 * Generates the FICTIONAL demo PDFs (no dependencies, plain text pages).
 *
 *   npx tsx supabase/seed/make-demo-pdfs.ts
 *       Alex Morgan's original documents (top level of files/ and upload/).
 *
 *   DEMO_WORKER_SLUG=rehearsal-3 DEMO_WORKER_NAME="Riley Chen" npx tsx supabase/seed/make-demo-pdfs.ts
 *       That worker's own documents, in files/<slug>/ and upload/<slug>/, naming that worker
 *       and carrying distinct certificate numbers. Never touches another worker's files.
 *
 * Every person, company, issuer and number is invented and labelled as such.
 */
import { join } from "node:path";
import { alexDocumentSet, absolutePathOf, demoDocumentSet, writeDemoDocuments } from "./demo-documents";

const slug = process.env.DEMO_WORKER_SLUG;
const name = process.env.DEMO_WORKER_NAME?.trim();
if (slug && !name) throw new Error("DEMO_WORKER_NAME is required with DEMO_WORKER_SLUG.");

const root = join(process.cwd(), "supabase", "seed");
const set = slug ? demoDocumentSet({ name: name!, slug }) : alexDocumentSet();
writeDemoDocuments(root, set);
for (const d of set.documents) console.log("wrote", absolutePathOf(root, d), d.uploadedLive ? "(upload this one live)" : "");
