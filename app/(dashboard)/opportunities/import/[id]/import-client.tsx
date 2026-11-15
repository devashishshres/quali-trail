"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RequirementPriority } from "@/lib/types";
import type { ImportView, SaveImportReviewRequest } from "@/lib/types/imports";
import { api, toApiError } from "@/lib/client/api";
import { importsApi } from "@/lib/client/imports-api";
import { useLoad } from "@/lib/client/use-load";
import { PRIORITY_LABEL, formatStamp } from "@/lib/client/labels";
import { ErrorNotice, Loading, Notice, PageHeader } from "@/components/ui/states";
import { Icon } from "@/components/ui/icons";

type Edit = SaveImportReviewRequest;

function toEdit(v: ImportView): Edit | null {
  const d = v.draft;
  if (!d) return null;
  return {
    version: v.version,
    title: d.title,
    employer: d.employer,
    location: d.location,
    lines: d.lines.map((l) => ({ key: l.key, priority: l.priority, displayText: l.displayText, removed: l.removed, manualReview: l.manualReview })),
  };
}

export function ImportReviewClient() {
  const { id } = useParams<{ id: string }>();
  const view = useLoad(() => importsApi.get(id), id);
  const v = view.data;

  // A draft still being prepared by another request: check again shortly (no provider call is made by reading).
  useEffect(() => {
    if (!v || (v.status !== "fetching" && v.status !== "drafting")) return;
    const t = setTimeout(view.reload, 3000);
    return () => clearTimeout(t);
  }, [v, view.reload]);

  return (
    <>
      <PageHeader title="Review the imported job" lede="Check each requirement against the listing before QualiTrail compares it with your records. Nothing is saved as a job until you confirm.">
        <Link href="/opportunities" className="btn btn-secondary">
          Back to Opportunities
        </Link>
      </PageHeader>
      {view.status === "loading" && !v && <Loading label="Loading the draft…" />}
      {view.error && <ErrorNotice error={view.error} onRetry={view.reload} />}
      {v && (v.status === "fetching" || v.status === "fetched" || v.status === "drafting") && <Loading label="Still reading the listing…" />}
      {v && v.status === "failed" && <Failed view={v} onChange={view.setData} />}
      {v && v.status === "expired" && (
        <Notice tone="warning" title="This draft expired">
          Drafts are kept for 7 days. Import the listing again from Opportunities.
        </Notice>
      )}
      {v && v.status === "confirmed" && v.opportunityId && (
        <Notice title="Already confirmed" action={<Link href={`/opportunities?job=${v.opportunityId}`} className="btn btn-primary">Open the job</Link>}>
          This draft was confirmed and saved as a job.
        </Notice>
      )}
      {v && v.status === "drafted" && v.draft && <Review key={v.version} view={v} onChange={view.setData} />}
    </>
  );
}

function Failed({ view, onChange }: { view: ImportView; onChange: (v: ImportView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canRedraft = view.error?.code.startsWith("draft_");
  return (
    <Notice
      tone="danger"
      title="The import didn't finish"
      action={
        canRedraft ? (
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                onChange(await importsApi.redraft(view.id));
              } catch (e) {
                setErr(toApiError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="refresh" className="size-4" /> {busy ? "Reading the listing…" : "Try reading it again"}
          </button>
        ) : (
          <Link href="/opportunities" className="btn btn-secondary">
            {view.error?.retryable ? "Try again" : "Paste the listing text instead"}
          </Link>
        )
      }
    >
      {view.error?.message} {err}
    </Notice>
  );
}

function Review({ view, onChange }: { view: ImportView; onChange: (v: ImportView) => void }) {
  const router = useRouter();
  const draft = view.draft!;
  const [edit, setEdit] = useState<Edit>(() => toEdit(view)!);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "confirm">(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(edit) !== JSON.stringify(toEdit(view));
  const kept = edit.lines.filter((l) => !l.removed).length;
  const setLine = (key: string, patch: Partial<Edit["lines"][number]>) => setEdit((e) => ({ ...e, lines: e.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  async function save(): Promise<ImportView | null> {
    setBusy("save");
    setError(null);
    try {
      const next = await importsApi.save(view.id, edit);
      onChange(next);
      return next;
    } catch (e) {
      setError(toApiError(e).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function confirmAndCompare() {
    setError(null);
    let current = view;
    if (dirty) {
      const saved = await save();
      if (!saved) return;
      current = saved;
    }
    setBusy("confirm");
    try {
      const { opportunityId } = await importsApi.confirm(view.id, current.version, ack);
      // Compare straight away. If matching can't run now, the job is still saved and can be matched from its page.
      await api.runMatch(opportunityId).catch(() => null);
      router.push(`/opportunities?job=${opportunityId}`);
    } catch (e) {
      setError(toApiError(e).message);
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="sheet p-5 sm:p-7">
        <p className="text-sm text-slate">
          {view.sourceKind === "listing_url" ? (
            <>
              Retrieved {view.retrievedAt ? formatStamp(view.retrievedAt) : ""} from{" "}
              <a href={view.submittedUrl ?? "#"} target="_blank" rel="noreferrer noopener" className="underline">
                {view.submittedUrl}
              </a>
              {view.finalUrl && view.finalUrl !== view.submittedUrl && <> (final page: {view.finalUrl})</>}
            </>
          ) : (
            "Listing text supplied by you, not retrieved from the employer."
          )}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block font-semibold">Job title</span>
            <input className="field" value={edit.title} maxLength={300} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-semibold">Employer</span>
            <input className="field" value={edit.employer} maxLength={300} onChange={(e) => setEdit({ ...edit, employer: e.target.value })} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-semibold">Location</span>
            <input className="field" value={edit.location ?? ""} maxLength={300} onChange={(e) => setEdit({ ...edit, location: e.target.value || null })} />
          </label>
        </div>
      </section>

      {view.warnings.length > 0 && (
        <Notice tone="warning" title="Check this listing carefully before confirming">
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {view.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section>
        <h2 className="font-display text-2xl font-semibold">Requirements ({kept} of {draft.lines.length} kept)</h2>
        <p className="mt-1 max-w-prose text-sm text-slate">
          Each line is quoted word-for-word from the listing. Matching always uses this wording. You can reword a line for display (it will be labelled as yours), change its priority, mark it for manual review, or remove it.
        </p>
        {draft.lines.length === 0 && <p className="mt-4 text-slate">No requirement lines were found in this listing.</p>}
        <ol className="mt-4 space-y-3">
          {draft.lines.map((l) => {
            const e = edit.lines.find((x) => x.key === l.key)!;
            const preview = view.previews[l.key];
            return (
              <li key={l.key} className={`rounded-md border bg-white p-4 ${e.removed ? "border-dashed border-line opacity-60" : "border-line"}`}>
                <blockquote className="border-l-4 border-navy pl-3 font-medium">{l.originalText}</blockquote>
                <p className="mt-1 text-xs text-slate">Employer&apos;s wording. {l.sourceExcerpt && l.sourceExcerpt !== l.originalText && <>From: &ldquo;{l.sourceExcerpt}&rdquo;</>}</p>
                <p className="mt-2 text-sm">
                  {e.manualReview ? (
                    <span className="text-navy">Won&apos;t be assessed automatically: you marked it for manual review.</span>
                  ) : preview?.kind === "supported" ? (
                    <span>
                      <span className="font-semibold">QualiTrail will check:</span> {preview.conditions.join("; and ")}
                    </span>
                  ) : (
                    <span>
                      <span className="font-semibold">Can&apos;t assess automatically.</span> {preview?.kind === "review_only" ? preview.reasonText.join(" ") : ""}
                    </span>
                  )}
                </p>
                {!e.removed && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[12rem_1fr]">
                    <label className="text-sm">
                      <span className="mb-1 block font-semibold">Priority</span>
                      <select className="field" value={e.priority} onChange={(ev) => setLine(l.key, { priority: ev.target.value as RequirementPriority })}>
                        {(["required", "preferred", "unspecified"] as const).map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-xs text-slate">Listing: {PRIORITY_LABEL[l.originalPriority]}</span>
                    </label>
                    <label className="text-sm">
                      <span className="mb-1 block font-semibold">Your wording (optional, display only)</span>
                      <input className="field" maxLength={1000} value={e.displayText ?? ""} placeholder="Leave blank to show the employer's wording" onChange={(ev) => setLine(l.key, { displayText: ev.target.value || null })} />
                      <span className="mt-1 block text-xs text-slate">Shown labelled as yours. It doesn&apos;t change how this line is assessed.</span>
                    </label>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-4 text-sm">
                  {!e.removed && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={e.manualReview} onChange={(ev) => setLine(l.key, { manualReview: ev.target.checked })} />
                      Mark for manual review
                    </label>
                  )}
                  <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setLine(l.key, { removed: !e.removed })}>
                    {e.removed ? "Keep this line" : "Remove this line"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="sheet space-y-3 p-5 sm:p-7">
        {view.warnings.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I&apos;ve read the warnings above and compared this list with the listing.</span>
          </label>
        )}
        {error && (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button className="btn btn-primary" onClick={confirmAndCompare} disabled={!!busy || kept === 0 || (view.warnings.length > 0 && !ack)}>
            <Icon name="star" className="size-4" /> {busy === "confirm" ? "Saving and comparing…" : "Confirm and compare"}
          </button>
          <button className="btn btn-secondary" onClick={save} disabled={!!busy || !dirty}>
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        </div>
        <p className="text-xs text-slate">Draft kept until {formatStamp(view.expiresAt)}. Comparing uses only records you&apos;ve saved in QualiTrail.</p>
      </section>
    </div>
  );
}
