import type { EmployerPacket, ReviewerShare, SharedPacket, ShareSelection, WorkerShare } from "@/lib/types/employer";
import { call, post } from "./signoff-api";

/** Technician side (signed in). */
export const shareApi = {
  list: () => call<{ enabled: boolean; canSend: boolean; mode?: string; shares: WorkerShare[] }>("/api/employer-shares"),
  preview: (s: ShareSelection) => call<{ packet: EmployerPacket }>("/api/employer-shares/preview", post(s)),
  create: (s: ShareSelection & { email: string; validDays: 3 | 7 | 14 | 30; reviewed: true }) => call<{ id: string }>("/api/employer-shares", post(s)),
  get: (id: string) => call<SharedPacket>(`/api/employer-shares/${id}`),
  revoke: (id: string) => call<{ status: string }>(`/api/employer-shares/${id}`, { method: "DELETE" }),
};

/** Employer-reviewer side. The invitation token travels in a header, never in a URL a server sees. */
export const reviewerApi = {
  peek: (t: string) => call<{ status: string; workerName: string | null; emailHint: string | null; expiresAt: string | null; answered: boolean }>("/api/employer/invite/peek", post(), t),
  accept: (t: string) => call<{ id: string; repeated: boolean }>("/api/employer/invite/accept", post(), t),
  list: () => call<{ shares: ReviewerShare[] }>("/api/employer/shares"),
  get: (id: string) => call<SharedPacket>(`/api/employer/shares/${id}`),
  document: (id: string, record: string) => call<{ url: string }>(`/api/employer/shares/${id}/document?record=${encodeURIComponent(record)}`),
};
