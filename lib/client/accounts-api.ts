import type { MeResponse, OnboardRequest, ReviewRespondRequest, SupervisorReview, WorkerRelationship, WorkerReview } from "@/lib/types";
import { call, post } from "./signoff-api";

export interface Dashboard {
  enabled: boolean;
  profile: { name: string; organization: string | null; title: string | null };
  connections: { id: string; workerName: string; trade: string; acceptedAt: string }[];
  reviews: { id: string; workerName: string; title: string; date: string | null; status: string; createdAt: string; expiresAt: string }[];
}

export const accountsApi = {
  me: () => call<MeResponse>("/api/me"),
  onboard: (body: OnboardRequest) => call<{ role: string; created: boolean; sampleOpportunity?: boolean }>("/api/onboarding", post(body)),

  // Worker side
  supervisors: () => call<{ enabled: boolean; canSend?: boolean; mode?: string; relationships: WorkerRelationship[] }>("/api/supervisors"),
  inviteSupervisor: (email: string) => call<{ id: string }>("/api/supervisors", post({ email, agreedToContact: true })),
  revokeRelationship: (id: string) => call<{ revoked: boolean }>(`/api/supervisors/${id}/revoke`, post()),
  remindInvite: (id: string) => call<{ reminded: boolean }>(`/api/supervisors/${id}/remind`, post()),
  reviews: (evidenceId: string) => call<{ reviews: WorkerReview[] }>(`/api/reviews?evidenceId=${encodeURIComponent(evidenceId)}`),
  requestReview: (evidenceId: string, relationshipId: string, shareOriginal: boolean) => call<{ id: string; notified: boolean; notice: string | null }>("/api/reviews", post({ evidenceId, relationshipId, shareOriginal })),
  revokeReview: (id: string) => call<{ revoked: boolean }>(`/api/reviews/${id}/revoke`, post()),
  remindReview: (id: string) => call<{ reminded: boolean }>(`/api/reviews/${id}/remind`, post()),

  // Supervisor side
  dashboard: () => call<Dashboard>("/api/supervisor/dashboard"),
  review: (id: string) => call<{ review: SupervisorReview; statements: { observed: string; documents: string } }>(`/api/supervisor/reviews/${id}`),
  reviewDocument: (id: string) => call<{ url: string }>(`/api/supervisor/reviews/${id}/document`),
  respond: (id: string, body: ReviewRespondRequest) => call<{ recorded: boolean; repeated: boolean; status: string }>(`/api/supervisor/reviews/${id}/respond`, post(body)),
  peekInvite: (t: string) => call<{ status: string; workerName: string | null; emailHint: string | null; answered?: boolean }>("/api/supervisor/invite/peek", post(), t),
  answerInvite: (t: string, accept: boolean) => call<{ status: string; repeated: boolean }>("/api/supervisor/invite/answer", post({ accept }), t),
};
