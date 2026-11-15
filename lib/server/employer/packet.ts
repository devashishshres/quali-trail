import { EmployerPacket, PACKET_FORMAT, ShareCandidates, type PacketConfirmation, type ShareSelection } from "@/lib/types/employer";
import type { VerificationStatus } from "@/lib/types";

/**
 * Raw candidates from `employer_share_candidates` (service role, this worker only). The database already limits
 * confirmations to those explicitly permitted for external sharing, for the record's current version, and leaves the
 * supervisor's details out unless naming was permitted. The builder re-applies every rule anyway.
 */
export interface Candidates {
  worker: { name: string; trade: string; isSynthetic: boolean };
  work: {
    id: string; version: number; type: string; title: string; date: string | null;
    supervisor: { requestId: string; basis: string; observedTasks: unknown; decidedAt: string | null; reviewer: { name: string; organization: string | null; title: string | null } | null }[];
    customer: { requestId: string; decidedAt: string | null; simulated: boolean; acknowledgedActivities: unknown }[];
    withheldCount: number;
  }[];
  certifications: {
    id: string; version: number; title: string; issuer: string | null; date: string | null; expirationDate: string | null; verificationStatus: VerificationStatus;
  }[];
}

export class PacketSelectionError extends Error {
  constructor(public readonly reason: "no_items" | "not_eligible" | "no_original") {
    super(reason);
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function confirmationsOf(w: Candidates["work"][number]): PacketConfirmation[] {
  const out: PacketConfirmation[] = [];
  for (const c of w.customer) out.push({ kind: "customer", decidedAt: c.decidedAt, acknowledgedActivities: strings(c.acknowledgedActivities), simulated: c.simulated === true });
  for (const s of w.supervisor) {
    const basis = s.basis === "observed" ? "observed" : "documents";
    out.push({
      kind: "supervisor", basis, observedTasks: basis === "observed" ? strings(s.observedTasks) : [], decidedAt: s.decidedAt,
      reviewer: s.reviewer && s.reviewer.name ? { name: s.reviewer.name, organization: s.reviewer.organization ?? null, title: s.reviewer.title ?? null } : null,
    });
  }
  return out;
}

/** What the technician may choose from, with honest counts of confirmations that can't be shared. */
export function listCandidates(c: Candidates): ShareCandidates {
  return ShareCandidates.parse({
    work: c.work.map((w) => {
      const n = confirmationsOf(w).length;
      return { id: w.id, title: w.title, date: w.date, eligible: n > 0, shareableCount: n, withheldCount: Number(w.withheldCount) || 0 };
    }),
    certifications: c.certifications.map((x) => ({ id: x.id, title: x.title, issuer: x.issuer, verificationStatus: x.verificationStatus })),
  });
}

/**
 * The ONE function that decides what an employer sees. The technician's preview and the stored packet both come
 * from here. Only selected, eligible items; strict schema, so no other field can be added by mistake.
 */
export function buildPacket(c: Candidates, selection: ShareSelection, now: Date): EmployerPacket {
  const workIds = new Set(selection.workIds);
  const certIds = new Set(selection.certificationIds);
  if (!workIds.size && !certIds.size) throw new PacketSelectionError("no_items");
  const workById = new Map(c.work.map((w) => [w.id, w]));
  const certById = new Map(c.certifications.map((x) => [x.id, x]));
  for (const id of workIds) {
    const w = workById.get(id);
    if (!w || !["work_record", "checklist"].includes(w.type) || confirmationsOf(w).length === 0) throw new PacketSelectionError("not_eligible");
  }
  for (const id of certIds) if (!certById.has(id)) throw new PacketSelectionError("not_eligible");
  // Originals: certifications only, each separately selected. Never a work document.
  for (const id of selection.originalIds) if (!certIds.has(id)) throw new PacketSelectionError("no_original");
  const originals = new Set(selection.originalIds);

  return EmployerPacket.parse({
    format: PACKET_FORMAT,
    generatedAt: now.toISOString(),
    isSynthetic: c.worker.isSynthetic,
    technician: { name: c.worker.name, trade: c.worker.trade },
    work: c.work.filter((w) => workIds.has(w.id)).map((w) => ({
      id: w.id, version: w.version, type: w.type, title: w.title, date: w.date, confirmations: confirmationsOf(w),
    })),
    certifications: c.certifications.filter((x) => certIds.has(x.id)).map((x) => ({
      id: x.id, version: x.version, title: x.title, issuer: x.issuer, date: x.date, expirationDate: x.expirationDate ?? null,
      verificationStatus: x.verificationStatus, originalShared: originals.has(x.id),
    })),
  });
}
