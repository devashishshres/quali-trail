import { z } from "zod";
import { EvidenceAssessment, EvidenceType, RequirementPriority, VerificationStatus } from "./contracts";

export const PACKET_FORMAT = "employer-packet-v1";

/** A completed confirmation as it may appear to an employer. Never a customer's name, address, signature or comment. */
export const PacketConfirmation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("customer"),
    decidedAt: z.string().nullable(),
    /** Development test mode: no real email reached anyone. */
    simulated: z.boolean(),
  }),
  z.object({
    kind: z.literal("supervisor"),
    basis: z.enum(["observed", "documents"]),
    observedTasks: z.array(z.string()),
    decidedAt: z.string().nullable(),
    /** Self-entered and unverified. Present ONLY when the reviewer explicitly agreed to employer sharing. */
    reviewer: z.object({ name: z.string(), organization: z.string().nullable(), title: z.string().nullable() }).nullable(),
  }),
]);
export type PacketConfirmation = z.infer<typeof PacketConfirmation>;

export const PacketRecord = z.object({
  id: z.string(),
  /** "R1", "R2", … used to link requirement rows to records. */
  ref: z.string(),
  version: z.number().int(),
  type: EvidenceType,
  title: z.string(),
  date: z.string().nullable(),
  issuer: z.string().nullable(),
  expirationDate: z.string().nullable(),
  verificationStatus: VerificationStatus,
  activities: z.array(z.string()),
  equipment: z.array(z.string()),
  skills: z.array(z.string()),
  originalShared: z.boolean(),
  confirmations: z.array(PacketConfirmation),
});
export type PacketRecord = z.infer<typeof PacketRecord>;

export const EmployerPacket = z.object({
  format: z.literal(PACKET_FORMAT),
  generatedAt: z.string(),
  isSynthetic: z.boolean(),
  technician: z.object({ name: z.string(), trade: z.string() }),
  opportunity: z.object({
    title: z.string(),
    employer: z.string(),
    location: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    sourceKind: z.enum(["listing_url", "pasted_text", "other"]),
  }),
  report: z.object({ reference: z.string(), createdAt: z.string(), status: z.enum(["completed", "stale"]) }),
  counts: z.record(EvidenceAssessment, z.number().int()),
  requirements: z.array(z.object({
    text: z.string(),
    priority: RequirementPriority.nullable(),
    mandatory: z.boolean(),
    assessment: EvidenceAssessment,
    records: z.array(z.object({ ref: z.string(), role: z.enum(["direct", "supporting"]) })),
    /** Records the report linked to this requirement that the technician chose not to share. */
    notSharedCount: z.number().int().nonnegative(),
  })),
  records: z.array(PacketRecord),
  includesConfirmations: z.boolean(),
});
export type EmployerPacket = z.infer<typeof EmployerPacket>;

export const ShareSelection = z.object({
  opportunityId: z.uuid(),
  recordIds: z.array(z.uuid()).max(100),
  originalIds: z.array(z.uuid()).max(100).default([]),
  includeConfirmations: z.boolean().default(true),
});
export type ShareSelection = z.infer<typeof ShareSelection>;

export const CreateShareRequest = ShareSelection.extend({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  validDays: z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(7),
  reviewed: z.literal(true, { error: "Confirm you've reviewed exactly what will be shared." }),
});

export const ShareStatus = z.enum(["pending", "active", "revoked", "expired"]);
export type ShareStatus = z.infer<typeof ShareStatus>;

export const WorkerShare = z.object({
  id: z.string(),
  status: ShareStatus,
  emailHint: z.string().nullable(),
  opportunityId: z.string(),
  jobTitle: z.string().nullable(),
  recordCount: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  views: z.number().int(),
  originalsOpened: z.number().int(),
  lastViewedAt: z.string().nullable(),
});
export type WorkerShare = z.infer<typeof WorkerShare>;

export const ReviewerShare = z.object({
  id: z.string(),
  status: ShareStatus,
  technician: z.string().nullable(),
  jobTitle: z.string().nullable(),
  sharedAt: z.string(),
  expiresAt: z.string(),
});
export type ReviewerShare = z.infer<typeof ReviewerShare>;

/** A frozen packet as read back (by the reviewer or the technician). */
export const SharedPacket = z.object({
  id: z.string(),
  packet: EmployerPacket,
  packetHash: z.string(),
  sharedAt: z.string(),
  expiresAt: z.string(),
  changedRecordIds: z.array(z.string()),
  status: ShareStatus.optional(),
});
export type SharedPacket = z.infer<typeof SharedPacket>;
