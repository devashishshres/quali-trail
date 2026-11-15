import type { ConfirmEvidenceResponse, ConfirmedEvidenceFields, GateResponse, ListSignoffsResponse, SignoffConfig, SnapshotResponse, CreateSignoffRequest, RespondRequest } from "@/lib/types";
import { ApiRequestError } from "./errors";

async function call<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(token ? { "x-signoff-token": token } : {}) },
  }).catch(() => null);
  const body = await res?.json().catch(() => null);
  if (res?.ok && body) return body as T;
  throw new ApiRequestError(body?.error?.code ?? "internal", res?.status ?? 0, body?.error?.message ?? "Can't reach the server. Please try again.", body?.error?.fieldErrors);
}
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Worker-side calls (signed-in). */
export const signoffApi = {
  config: () => call<SignoffConfig>("/api/signoff/config"),
  list: (evidenceId: string) => call<ListSignoffsResponse>(`/api/signoff/requests?evidenceId=${encodeURIComponent(evidenceId)}`),
  create: (body: CreateSignoffRequest) => call<{ id: string; mode: string }>("/api/signoff/requests", post(body)),
  revoke: (id: string) => call<{ revoked: boolean }>(`/api/signoff/requests/${id}/revoke`, post()),
  resend: (id: string) => call<{ resent: boolean }>(`/api/signoff/requests/${id}/resend`, post()),
  editEvidence: (id: string, fields: ConfirmedEvidenceFields) =>
    call<ConfirmEvidenceResponse>(`/api/evidence/${id}`, { method: "PATCH", body: JSON.stringify({ fields }) }),
  outbox: () => call<{ simulated: true; messages: { at: string; kind: string; subject: string; text: string }[] }>("/api/signoff/outbox"),
};

/** Customer-side calls (no account; the link token travels in a header, never in a URL). */
export const customerApi = {
  gate: (t: string) => call<GateResponse>("/api/signoff/gate", post(), t),
  sendCode: (t: string) => call<{ sent: boolean; simulated: boolean }>("/api/signoff/code", post(), t),
  verify: (t: string, code: string) => call<{ verified: boolean }>("/api/signoff/verify", post({ code }), t),
  snapshot: (t: string) => call<SnapshotResponse>("/api/signoff/snapshot", post(), t),
  respond: (t: string, body: RespondRequest) => call<{ recorded: boolean; repeated: boolean }>("/api/signoff/respond", post(body), t),
  optOut: (t: string) => call<{ optedOut: boolean }>("/api/signoff/opt-out", post(), t),
};
