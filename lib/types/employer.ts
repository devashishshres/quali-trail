import { z } from "zod";
import { VerificationStatus } from "./contracts";

export const PACKET_FORMAT = "employer-packet-v2";

/**
 * A confirmation as an employer may see it. Only confirmations whose confirmer explicitly allowed external sharing
 * ever get here. Never a customer's name, address, signature or comment; never a supervisor's comment or address.
 */
export const PacketConfirmation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("customer"),
    decidedAt: z.string().nullable(),
    /** The tasks listed in the description the customer acknowledged. */
    acknowledgedActivities: z.array(z.string()),
    /** Development test mode: no real email reached anyone. */
    simulated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("supervisor"),
    basis: z.enum(["observed", "documents"]),
    observedTasks: z.array(z.string()),
    decidedAt: z.string().nullable(),
    /** Self-entered and unverified. Null unless the supervisor ALSO allowed their name to be shown. */
    reviewer: z.strictObject({ name: z.string(), organization: z.string().nullable(), title: z.string().nullable() }).nullable(),
  }),
]);
export type PacketConfirmation = z.infer<typeof PacketConfirmation>;

/** Minimal work details + what was confirmed. No issuer, summary, equipment, documents or comments. */
export const PacketWork = z.strictObject({
  id: z.string(),
  version: z.number().int(),
  type: z.enum(["work_record", "checklist"]),
  title: z.string(),
  date: z.string().nullable(),
  confirmations: z.array(PacketConfirmation).min(1),
});
export type PacketWork = z.infer<typeof PacketWork>;

export const PacketCertification = z.strictObject({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  issuer: z.string().nullable(),
  date: z.string().nullable(),
  expirationDate: z.string().nullable(),
  /** "document_supplied" means the technician uploaded it and nobody has checked it. */
  verificationStatus: VerificationStatus,
  originalShared: z.boolean(),
});
export type PacketCertification = z.infer<typeof PacketCertification>;

export const EmployerPacket = z.strictObject({
  format: z.literal(PACKET_FORMAT),
  generatedAt: z.string(),
  isSynthetic: z.boolean(),
  technician: z.strictObject({ name: z.string(), trade: z.string() }),
  work: z.array(PacketWork),
  certifications: z.array(PacketCertification),
});
export type EmployerPacket = z.infer<typeof EmployerPacket>;

export const ShareSelection = z.object({
  workIds: z.array(z.uuid()).max(100).default([]),
  certificationIds: z.array(z.uuid()).max(100).default([]),
  /** Certification originals the technician separately authorized. Off unless listed. */
  originalIds: z.array(z.uuid()).max(100).default([]),
});
export type ShareSelection = z.infer<typeof ShareSelection>;

export const CreateShareRequest = ShareSelection.extend({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  validDays: z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(7),
  reviewed: z.literal(true, { error: "Confirm you've reviewed exactly what will be shared." }),
});

/** What the technician can choose from (their own data; the share page). */
export const ShareCandidates = z.object({
  work: z.array(z.object({ id: z.string(), title: z.string(), date: z.string().nullable(), eligible: z.boolean(), shareableCount: z.number().int(), withheldCount: z.number().int() })),
  certifications: z.array(z.object({ id: z.string(), title: z.string(), issuer: z.string().nullable(), verificationStatus: VerificationStatus })),
});
export type ShareCandidates = z.infer<typeof ShareCandidates>;

export const ShareStatus = z.enum(["pending", "active", "revoked", "expired"]);
export type ShareStatus = z.infer<typeof ShareStatus>;

export const WorkerShare = z.object({
  id: z.string(),
  status: ShareStatus,
  emailHint: z.string().nullable(),
  workCount: z.number().int(),
  certificationCount: z.number().int(),
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
  sharedAt: z.string(),
  expiresAt: z.string(),
});
export type ReviewerShare = z.infer<typeof ReviewerShare>;

/** A frozen packet as read back (by the reviewer or the technician). Parsed strictly: unknown fields are refused. */
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
