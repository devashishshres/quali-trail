import { z } from "zod";
import { ConfirmedEvidenceFields } from "./contracts";

/** Customer sign-off contracts (Phase 1: work records and checklists, customer role only). */

export const SignoffStatus = z.enum([
  "pending", "acknowledged", "correction_requested", "declined", "expired", "revoked", "superseded", "locked",
]);
export type SignoffStatus = z.infer<typeof SignoffStatus>;

export const SignoffDecision = z.enum(["confirm", "request_correction", "decline"]);
export type SignoffDecision = z.infer<typeof SignoffDecision>;

export const SignoffConfig = z.object({
  enabled: z.boolean(),
  mode: z.enum(["off", "mock", "resend"]),
  /** True only when requests can actually be sent in the current mode. */
  ready: z.boolean(),
});
export type SignoffConfig = z.infer<typeof SignoffConfig>;

export const CreateSignoffRequest = z.object({
  evidenceId: z.uuid(),
  customerEmail: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  customerName: z.string().trim().max(200).nullable().optional(),
  /** The worker states the customer agreed to be contacted. */
  customerAgreedToContact: z.literal(true, { error: "Confirm the customer agreed to be contacted." }),
});
export type CreateSignoffRequest = z.infer<typeof CreateSignoffRequest>;

export const WorkerSignoff = z.object({
  id: z.uuid(),
  evidenceId: z.uuid(),
  evidenceVersion: z.number().int(),
  status: SignoffStatus,
  /** Masked (c***@host); null once the retention purge has run. */
  emailHint: z.string().nullable(),
  deliveryMode: z.enum(["resend", "mock"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  emailVerifiedAt: z.string().nullable(),
  decision: SignoffDecision.nullable(),
  decidedAt: z.string().nullable(),
  typedName: z.string().nullable(),
  comment: z.string().nullable(),
});
export type WorkerSignoff = z.infer<typeof WorkerSignoff>;

export const ListSignoffsResponse = z.object({ requests: z.array(WorkerSignoff) });
export type ListSignoffsResponse = z.infer<typeof ListSignoffsResponse>;

export const GateResponse = z.object({
  status: SignoffStatus,
  workerName: z.string(),
  emailHint: z.string().nullable(),
  deliveryMode: z.enum(["resend", "mock"]),
});
export type GateResponse = z.infer<typeof GateResponse>;

export const SnapshotResponse = z.object({
  status: SignoffStatus,
  deliveryMode: z.enum(["resend", "mock"]),
  snapshot: z.object({
    workerName: z.string(),
    type: z.string(),
    title: z.string(),
    date: z.string().nullable(),
    issuer: z.string().nullable(),
    skills: z.array(z.string()),
    activities: z.array(z.string()),
    equipment: z.array(z.string()),
    summary: z.string().nullable(),
  }),
  statement: z.string(),
  response: z.object({ decision: SignoffDecision, createdAt: z.string() }).nullable(),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;

export const RespondRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirm"), typedName: z.string().trim().min(2).max(200), agreed: z.literal(true) }),
  z.object({ decision: z.literal("request_correction"), comment: z.string().trim().min(1).max(1000) }),
  z.object({ decision: z.literal("decline") }),
]);
export type RespondRequest = z.infer<typeof RespondRequest>;

/** PATCH /api/evidence/:id (Phase 1: work records and checklists, not independently confirmed). */
export const EditEvidenceRequest = z.object({ fields: ConfirmedEvidenceFields });
export type EditEvidenceRequest = z.infer<typeof EditEvidenceRequest>;
