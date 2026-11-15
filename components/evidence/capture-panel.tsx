"use client";
import { useState } from "react";
import { UPLOAD_LIMITS, type Evidence, type EvidenceDraft } from "@/lib/types";
import { api, toApiError } from "@/lib/client/api";
import { Icon } from "../ui/icons";
import { Notice } from "../ui/states";
import { ReviewForm } from "./review-form";

type Mode = "pdf" | "text";
const MIN_TEXT = 20;
const MAX_TEXT = 10_000;

/** Step 1 of capture: upload a PDF or describe the work, then Gemini proposes fields. */
export function CapturePanel({ onSaved }: { onSaved: (e: Evidence) => void }) {
  const [mode, setMode] = useState<Mode>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvidenceDraft | null>(null);
  const [saved, setSaved] = useState<Evidence | null>(null);

  function pickFile(f: File | null) {
    setError(null);
    setSaved(null);
    setFile(null);
    if (f && !(UPLOAD_LIMITS.acceptedMimeTypes as readonly string[]).includes(f.type)) {
      return setError("Only PDF files can be uploaded right now.");
    }
    if (f && f.size > UPLOAD_LIMITS.maxBytes) {
      return setError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`);
    }
    setFile(f);
  }

  async function extract() {
    if (busy || (mode === "pdf" ? !file : text.trim().length < MIN_TEXT)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { draft } = mode === "pdf" && file ? await api.extractFile(file) : await api.extractText(text);
      setDraft(draft);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDraft(null);
    setFile(null);
    setText("");
  }

  if (draft) {
    return (
      <ReviewForm
        draft={draft}
        onDiscard={reset}
        onSaved={(e) => {
          reset();
          setSaved(e);
          onSaved(e);
        }}
      />
    );
  }

  const ready = mode === "pdf" ? !!file : text.trim().length >= MIN_TEXT;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold">Add evidence</h2>
          <p className="text-sm text-slate">Gemini reads it and suggests the details. You check them before anything is saved.</p>
        </div>
        <div role="tablist" aria-label="How to add evidence" className="inline-flex rounded-md border border-line bg-paper p-1">
          {(
            [
              ["pdf", "Upload a PDF"],
              ["text", "Describe your work"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              disabled={busy}
              className={`rounded px-3 py-1.5 text-sm font-semibold ${mode === m ? "bg-white text-navy shadow-sm" : "text-slate"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        {mode === "pdf" ? (
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-line bg-paper/60 px-4 py-10 text-center hover:border-navy"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pickFile(e.dataTransfer.files[0] ?? null);
            }}
          >
            <Icon name="upload" className="size-7 text-slate" />
            {file ? (
              <span className="font-semibold">{file.name}</span>
            ) : (
              <>
                <span className="font-semibold">Drop a certificate, work order or checklist here</span>
                <span className="text-sm text-slate">or click to choose a file. PDF only, up to 10 MB.</span>
              </>
            )}
            <input
              type="file"
              accept={UPLOAD_LIMITS.acceptedMimeTypes.join(",")}
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
          </label>
        ) : (
          <label className="block">
            <span className="sr-only">Describe the work you did</span>
            <textarea
              className="field"
              rows={6}
              maxLength={MAX_TEXT}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Today I commissioned a 3-ton heat pump: checked refrigerant charge by subcooling, measured airflow at 400 CFM per ton, tested defrost…"
            />
            <span className="mt-1 block text-xs text-slate">
              {text.trim().length < MIN_TEXT ? `At least ${MIN_TEXT} characters.` : `${text.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()}`}
            </span>
          </label>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <Notice tone="danger" title="Couldn't read that">
            {error}
          </Notice>
        </div>
      )}
      {saved && (
        <div className="mt-4">
          <Notice title={`Saved "${saved.title}"`}>{saved.indexStatus === "failed" ? "Your record is saved, but indexing failed. Use Retry indexing below." : saved.indexStatus === "indexed" ? "Your record is saved and searchable in memory." : "Your record is saved. Memory indexing status updates below."}</Notice>
        </div>
      )}

      <div className="mt-5 flex items-center gap-4">
        <button className="btn btn-primary" onClick={extract} disabled={!ready || busy}>
          {busy ? "Reading with Gemini…" : "Extract details"}
        </button>
        {busy && <span className="text-sm text-slate" role="status">Reading your record. If the service is busy, you can review the details manually.</span>}
      </div>
    </div>
  );
}
