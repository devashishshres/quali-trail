/**
 * Browser-side API client. Every call returns the exact contract types
 * from `lib/types` — the frontend never invents its own shapes.
 *
 * NEXT_PUBLIC_DATA_MODE=fixtures swaps in labelled sample data
 * (lib/client/fixtures.ts) so the UI works without any backend services.
 * The shell shows a permanent banner while fixtures are on.
 */
import type {
  ApiError,
  ConfirmEvidenceRequest,
  ConfirmEvidenceResponse,
  ExtractResponse,
  GetEvidenceResponse,
  ListEvidenceResponse,
  ListOpportunitiesResponse,
  MatchRunResponse,
  ReindexResponse,
  RunExplanations,
} from "@/lib/types";
import { ApiRequestError, toApiError } from "./errors";
import { fixtureApi } from "./fixtures";

export { ApiRequestError, toApiError };

export const FIXTURE_MODE = process.env.NEXT_PUBLIC_DATA_MODE === "fixtures";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: "no-store" });
  } catch {
    throw new ApiRequestError("internal", 0, "Can't reach the QualiTrail server. Check your connection and try again.");
  }

  const body = await res.json().catch(() => null);
  if (res.ok && body) return body as T;

  if (res.status === 401 && typeof window !== "undefined") {
    // Full navigation on purpose: drops any in-memory state from the expired session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const err = (body as ApiError | null)?.error;
  if (err) throw new ApiRequestError(err.code, res.status, err.message, err.fieldErrors);
  if (res.status === 404) {
    throw new ApiRequestError("not_found", 404, `The server route ${path.split("?")[0]} isn't available yet.`, undefined, true);
  }
  throw new ApiRequestError("internal", res.status, `The server returned an unexpected response (${res.status}).`);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const liveApi = {
  listEvidence: () => request<ListEvidenceResponse>("/api/evidence"),
  getEvidence: (id: string) => request<GetEvidenceResponse>(`/api/evidence/${id}`),
  extractFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ExtractResponse>("/api/evidence/extract", { method: "POST", body: form });
  },
  extractText: (text: string) => request<ExtractResponse>("/api/evidence/extract", json({ text })),
  confirmEvidence: (body: ConfirmEvidenceRequest) =>
    request<ConfirmEvidenceResponse>("/api/evidence/confirm", json(body)),
  reindex: (id: string) => request<ReindexResponse>(`/api/evidence/${id}/reindex`, { method: "POST" }),
  listOpportunities: () => request<ListOpportunitiesResponse>("/api/opportunities"),
  runMatch: (opportunityId: string) => request<MatchRunResponse>("/api/matches/run", json({ opportunityId })),
  getMatch: (id: string) => request<MatchRunResponse>(`/api/matches/${id}`),
  /** Null when no run exists yet for this opportunity. */
  latestMatch: async (opportunityId: string): Promise<MatchRunResponse | null> => {
    try {
      return await request<MatchRunResponse>(`/api/matches/latest?opportunityId=${encodeURIComponent(opportunityId)}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "not_found" && !e.missingEndpoint) return null;
      throw e;
    }
  },
};

export type Api = typeof liveApi;

export const api: Api = FIXTURE_MODE ? fixtureApi : liveApi;

/**
 * Ask for "Related evidence — AI-assisted explanation" for one saved run. A separate layer: it never changes the
 * run's checked results. Not available in fixture mode.
 */
export const explainMatch = (runId: string) => request<{ explanations: RunExplanations }>(`/api/matches/${runId}/explanations`, { method: "POST" });

/**
 * Open an evidence record's original document. The signed URL lives 60 s,
 * so it is fetched on click and never stored. The tab is opened
 * synchronously first so popup blockers allow it.
 */
export async function openOriginal(evidenceId: string): Promise<string | null> {
  const tab = window.open("about:blank", "_blank");
  try {
    const { documentUrl } = await api.getEvidence(evidenceId);
    if (!documentUrl) {
      tab?.close();
      return "No original file is stored for this record.";
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = documentUrl;
    }
    return null;
  } catch (e) {
    tab?.close();
    return toApiError(e).message;
  }
}
