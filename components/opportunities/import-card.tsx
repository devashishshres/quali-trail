"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { importsApi } from "@/lib/client/imports-api";
import { toApiError } from "@/lib/client/api";
import { Icon } from "../ui/icons";

/**
 * "See how your experience fits a job." The technician pastes a public listing link (QualiTrail retrieves that page
 * only) or the listing text. Nothing about the technician is sent anywhere; nothing is saved as a job until they
 * review and confirm.
 */
export function ImportCard() {
  const router = useRouter();
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const view = mode === "url" ? await importsApi.startFromUrl(url) : await importsApi.startFromText(text);
      router.push(`/opportunities/import/${view.id}`);
    } catch (err) {
      setError(toApiError(err).message);
      setBusy(false);
    }
  }

  return (
    <section className="sheet mb-6 p-5 sm:p-7" aria-labelledby="import-title">
      <h2 id="import-title" className="font-display text-2xl font-semibold">See how your experience fits a job</h2>
      <p className="mt-1 max-w-prose text-sm text-slate">
        {mode === "url"
          ? "Paste the link to a public job listing. QualiTrail retrieves that page only. Your profile and records are never sent to the job site or the retrieval service."
          : "Paste the listing text. It will be labelled as supplied by you, not retrieved from the employer."}
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        {mode === "url" ? (
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">Job listing link</span>
            <input
              name="url"
              type="url"
              inputMode="url"
              required
              className="field"
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={!!error}
            />
          </label>
        ) : (
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">Listing text</span>
            <textarea name="text" required minLength={40} maxLength={30000} rows={8} className="field" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!error} />
          </label>
        )}
        {error && (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={busy}>
            <Icon name="briefcase" className="size-4" />
            {busy ? (mode === "url" ? "Retrieving and reading the listing…" : "Reading the listing…") : "Import job"}
          </button>
          <button type="button" className="text-sm font-semibold underline underline-offset-2" onClick={() => (setMode(mode === "url" ? "text" : "url"), setError(null))}>
            {mode === "url" ? "Paste the listing text instead" : "Use a link instead"}
          </button>
        </div>
        {busy && <p className="text-sm text-slate" role="status">This can take up to a minute or two.</p>}
      </form>
    </section>
  );
}
