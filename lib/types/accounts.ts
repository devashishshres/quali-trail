import { z } from "zod";

export const EmploymentArrangement = z.enum(["employee", "contractor", "self_employed", "apprentice", "other"]);
export type EmploymentArrangement = z.infer<typeof EmploymentArrangement>;

export const SignupRequest = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  next: z.string().max(500).optional(),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const RecoverRequest = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()) });
export const ResetPasswordRequest = z.object({ password: z.string().min(10, "Use at least 10 characters.").max(200) });

export const OnboardWorkerRequest = z.object({
  role: z.literal("worker"),
  name: z.string().trim().min(1).max(200),
  trade: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(1000).nullable().optional(),
  employmentArrangement: EmploymentArrangement.nullable().optional(),
  addSampleOpportunity: z.boolean().optional(),
});
export const OnboardSupervisorRequest = z.object({
  role: z.literal("supervisor"),
  name: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
});
export const OnboardRequest = z.discriminatedUnion("role", [OnboardWorkerRequest, OnboardSupervisorRequest]);
export type OnboardRequest = z.infer<typeof OnboardRequest>;

export const MeResponse = z.object({
  email: z.string().nullable(),
  emailConfirmed: z.boolean(),
  worker: z.object({ id: z.string(), name: z.string() }).nullable(),
  supervisor: z.object({ name: z.string(), organization: z.string().nullable(), title: z.string().nullable() }).nullable(),
  /** May this account create a worker / supervisor profile now. */
  canOnboard: z.boolean(),
  /** A technician profile is possible only under the sign-up policy (never by invitation alone). */
  canOnboardWorker: z.boolean(),
  canOnboardSupervisor: z.boolean(),
  features: z.object({ customerSignoff: z.boolean(), supervisorReview: z.boolean(), jobImport: z.boolean().default(false), aiExplanations: z.boolean().default(false) }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const RelationshipStatus = z.enum(["pending", "accepted", "declined", "revoked", "expired"]);
export const WorkerRelationship = z.object({
  id: z.string(),
  status: RelationshipStatus,
  emailHint: z.string().nullable(),
  supervisorName: z.string().nullable(),
  supervisorOrganization: z.string().nullable(),
  supervisorTitle: z.string().nullable(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type WorkerRelationship = z.infer<typeof WorkerRelationship>;

export const InviteSupervisorRequest = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  agreedToContact: z.literal(true, { error: "Confirm this person agreed to be contacted." }),
});

export const ReviewStatus = z.enum(["pending", "confirmed_observed", "confirmed_documents", "correction_requested", "declined", "revoked", "superseded", "expired"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;
export const ReviewDecision = z.enum(["confirm_observed", "confirm_documents_reviewed", "request_correction", "decline"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const ReviewSnapshot = z.object({
  workerName: z.string(),
  type: z.string(),
  title: z.string(),
  date: z.string().nullable(),
  issuer: z.string().nullable(),
  skills: z.array(z.string()),
  activities: z.array(z.string()),
  equipment: z.array(z.string()),
  summary: z.string().nullable(),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshot>;

export const SupervisorReview = z.object({
  id: z.string(),
  status: ReviewStatus,
  snapshot: ReviewSnapshot,
  hasOriginal: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  response: z.object({ decision: ReviewDecision, observedTasks: z.array(z.string()), comment: z.string().nullable(), createdAt: z.string() }).nullable(),
});
export type SupervisorReview = z.infer<typeof SupervisorReview>;

export const ReviewRespondRequest = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirm_observed"), observedTasks: z.array(z.string().max(500)).min(1).max(50), comment: z.string().trim().max(2000).nullable().optional(), agreed: z.literal(true) }),
  z.object({ decision: z.literal("confirm_documents_reviewed"), comment: z.string().trim().max(2000).nullable().optional(), agreed: z.literal(true) }),
  z.object({ decision: z.literal("request_correction"), comment: z.string().trim().min(1).max(2000) }),
  z.object({ decision: z.literal("decline"), comment: z.string().trim().max(2000).nullable().optional() }),
]);
export type ReviewRespondRequest = z.infer<typeof ReviewRespondRequest>;

/** What the worker sees about a supervisor review of one of their records. */
export const WorkerReview = z.object({
  id: z.string(),
  evidenceId: z.string(),
  evidenceVersion: z.number().int(),
  relationshipId: z.string(),
  status: ReviewStatus,
  supervisorName: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decision: ReviewDecision.nullable(),
  observedTasks: z.array(z.string()),
  comment: z.string().nullable(),
  reviewerName: z.string().nullable(),
  reviewerOrganization: z.string().nullable(),
  reviewerTitle: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type WorkerReview = z.infer<typeof WorkerReview>;

/** shareOriginal: the worker's explicit choice to let the supervisor open the original document (default: not shared). */
export const CreateReviewRequest = z.object({ evidenceId: z.uuid(), relationshipId: z.uuid(), shareOriginal: z.boolean().default(false) });

/** POST /api/jobs — log a completed job (no supporting document). Reuses the work_record/checklist record types. */
export const LogJobRequest = z.object({
  type: z.enum(["work_record", "checklist"]),
  title: z.string().trim().min(1).max(300),
  date: z.iso.date(),
  issuer: z.string().trim().max(300).nullable(),
  activities: z.array(z.string().trim().min(1).max(300)).min(1, "List at least one task you did.").max(30),
  equipment: z.array(z.string().trim().min(1).max(300)).max(30),
  skills: z.array(z.string().trim().min(1).max(300)).max(30),
  summary: z.string().trim().max(2000).nullable(),
});
export type LogJobRequest = z.infer<typeof LogJobRequest>;

/** Packet-safe summary: no customer address, typed signature or free-text comment. */
export const AttestationSummary = z.object({
  customer: z.array(z.object({
    id: z.string(), status: z.string(), deliveryMode: z.enum(["resend", "mock"]), evidenceVersion: z.number().int(), decidedAt: z.string().nullable(),
  })),
  supervisor: z.array(z.object({
    id: z.string(), status: z.string(), evidenceVersion: z.number().int(), decidedAt: z.string().nullable(), observedTasks: z.array(z.string()),
    reviewerName: z.string().nullable(), reviewerOrganization: z.string().nullable(), reviewerTitle: z.string().nullable(),
  })),
});
export type AttestationSummary = z.infer<typeof AttestationSummary>;
export type AttestationsResponse = { items: Record<string, AttestationSummary> };
