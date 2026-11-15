/**
 * Plans a fictional demo worker without touching Alex Morgan's rows.
 *
 * Every id in the seed data is fixed, so seeding a second worker with the same
 * ids would overwrite Alex's records. This derives a separate, deterministic id
 * for every row from a slug, so a rehearsal worker can be created any number of
 * times (one slug per rehearsal) without deleting or resetting anything.
 * PURE: no I/O, safe to unit test.
 */
import { createHash } from "node:crypto";
import { ALEX_IDENTIFIERS, demoIdentifiers } from "./demo-documents";
import { DEMO_EVIDENCE, DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, DEMO_WORKER, type DemoEvidence } from "./demo-data";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/** Stable UUID (v4 layout) derived from a namespace string and a base id. */
export function derivedId(slug: string, baseId: string): string {
  const h = createHash("sha256").update(`qualitrail-demo:${slug}:${baseId}`).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface DemoPlan {
  worker: { id: string; name: string; trade: string; summary: string | null };
  evidence: DemoEvidence[];
  opportunity: Omit<typeof DEMO_OPPORTUNITY, "id"> & { id: string };
  requirements: (Omit<(typeof DEMO_REQUIREMENTS)[number], "id"> & { id: string })[];
  /** True for the original Alex Morgan rows (fixed ids). */
  isOriginal: boolean;
}

export const DEFAULT_SYNTHETIC_SUMMARY =
  "Fictional demo technician (synthetic data): residential heat-pump installation and startup, with EPA 608 certification.";

function swapIdentifier(n: string | null, ids: { training: string; epa: string }): string | null {
  if (n === ALEX_IDENTIFIERS.training) return ids.training;
  if (n === ALEX_IDENTIFIERS.epa) return ids.epa;
  return n;
}

/** No slug: the original Alex plan, unchanged. A slug: a distinct fictional worker. */
export function planDemoWorker(opts: { slug?: string; name?: string; summary?: string }): DemoPlan {
  if (!opts.slug) {
    return { worker: { ...DEMO_WORKER, summary: null }, evidence: [...DEMO_EVIDENCE], opportunity: DEMO_OPPORTUNITY, requirements: [...DEMO_REQUIREMENTS], isOriginal: true };
  }
  const { slug } = opts;
  if (!SLUG.test(slug)) throw new Error("DEMO_WORKER_SLUG must be 3-40 characters: lowercase letters, digits and hyphens.");
  if (slug === "alex-morgan") throw new Error("alex-morgan is the existing demo worker; choose a different DEMO_WORKER_SLUG.");
  const ids = demoIdentifiers(slug);
  const name = opts.name?.trim();
  if (!name) throw new Error("DEMO_WORKER_NAME is required with DEMO_WORKER_SLUG.");
  const plan: DemoPlan = {
    worker: { id: derivedId(slug, DEMO_WORKER.id), name: name.slice(0, 300), trade: DEMO_WORKER.trade, summary: (opts.summary?.trim() || DEFAULT_SYNTHETIC_SUMMARY).slice(0, 1000) },
    // Certificate numbers are the worker's own, matching the numbers printed on that worker's documents.
    evidence: DEMO_EVIDENCE.map((e) => ({
      ...e,
      id: derivedId(slug, e.id),
      structuredData: { ...e.structuredData, credentialNumber: swapIdentifier(e.structuredData.credentialNumber, ids) },
    })),
    opportunity: { ...DEMO_OPPORTUNITY, id: derivedId(slug, DEMO_OPPORTUNITY.id) },
    requirements: DEMO_REQUIREMENTS.map((r) => ({ ...r, id: derivedId(slug, r.id) })),
    isOriginal: false,
  };
  return plan;
}
