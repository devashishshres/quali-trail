import type { ConfirmImportResponse, ImportView, SaveImportReviewRequest } from "@/lib/types/imports";
import { call, post } from "./signoff-api";

/** Job import (feature-flagged). The draft lives on the server; the browser only displays and edits it. */
export const importsApi = {
  startFromUrl: (url: string) => call<ImportView>("/api/imports", post({ url })),
  startFromText: (text: string) => call<ImportView>("/api/imports", post({ text })),
  get: (id: string) => call<ImportView>(`/api/imports/${encodeURIComponent(id)}`),
  save: (id: string, body: SaveImportReviewRequest) => call<ImportView>(`/api/imports/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  redraft: (id: string) => call<ImportView>(`/api/imports/${encodeURIComponent(id)}/draft`, post()),
  confirm: (id: string, version: number, acknowledgeWarnings: boolean) =>
    call<ConfirmImportResponse>(`/api/imports/${encodeURIComponent(id)}/confirm`, post({ version, acknowledgeWarnings })),
};
