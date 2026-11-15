"use client";
import { useState } from "react";
import type { EvidenceConnection, RequirementResult } from "@/lib/types";
import { layoutStars } from "@/lib/client/constellation-layout";
import { ASSESSMENT_LABEL, TYPE_LABEL, formatDate, formatMonth } from "@/lib/client/labels";
import { openOriginal } from "@/lib/client/api";
import { AssessmentDisc, VerificationTag } from "../ui/status";
import { Icon } from "../ui/icons";

// Canvas geometry (px). x comes from the time axis as a percentage.
const HEIGHT = 460;
const ORIGIN_Y = 118; // bottom edge of the requirement card
const LANE_Y = [220, 296, 372];
const AXIS_Y = 436;

const ASSESSMENT_STROKE = {
  evidence_found: "var(--color-teal)",
  needs_review: "var(--color-orange)",
  no_sufficient_evidence: "#8aa0ad",
  cannot_assess: "#c9d4dc",
} as const;

function edgePath(x: number, y: number) {
  return `M50 ${ORIGIN_Y} C50 ${ORIGIN_Y + 70} ${x} ${y - 80} ${x} ${y}`;
}

function Sky({
  result,
  selected,
  onSelect,
}: {
  result: RequirementResult;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { stars, ticks } = layoutStars(result.connections.map((c) => c.evidenceDate));
  const stroke = ASSESSMENT_STROKE[result.assessment];
  const order = [...stars.keys()].sort((a, b) => stars[a].x - stars[b].x);

  return (
    <div className="overflow-x-auto rounded-t-lg bg-sky">
      <div className="relative min-w-[680px]" style={{ height: HEIGHT }}>
        {/* faint star field: texture only, carries no data */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(1px 1px at 12% 18%, #fff8 50%, transparent), radial-gradient(1px 1px at 78% 12%, #fff6 50%, transparent), radial-gradient(1px 1px at 34% 64%, #fff5 50%, transparent), radial-gradient(1px 1px at 88% 58%, #fff6 50%, transparent), radial-gradient(1px 1px at 58% 82%, #fff4 50%, transparent)",
          }}
          aria-hidden="true"
        />

        <svg className="absolute inset-0 size-full" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="4" x2="96" y1={AXIS_Y} y2={AXIS_Y} stroke="#ffffff30" vectorEffect="non-scaling-stroke" />
          {ticks.map((t) => (
            <line key={t.label} x1={t.x} x2={t.x} y1={AXIS_Y - 6} y2={AXIS_Y + 6} stroke="#ffffff60" vectorEffect="non-scaling-stroke" />
          ))}
          {result.connections.map((c, i) => {
            const s = stars[i];
            const active = selected === c.evidenceId;
            return (
              <g key={c.evidenceId}>
                {/* drop line to the time axis */}
                <line x1={s.x} x2={s.x} y1={LANE_Y[s.lane]} y2={AXIS_Y} stroke="#ffffff18" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
                <path
                  d={edgePath(s.x, LANE_Y[s.lane])}
                  fill="none"
                  stroke={c.role === "direct" ? stroke : "#9fb8c6"}
                  strokeOpacity={active ? 1 : c.role === "direct" ? 0.85 : 0.55}
                  strokeWidth={active ? 3 : c.role === "direct" ? 2.25 : 1.5}
                  strokeDasharray={c.role === "supporting" ? "6 6" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>

        {/* requirement: the fixed point everything connects to */}
        <div className="absolute left-1/2 top-5 w-[min(380px,80%)] -translate-x-1/2 rounded-md border bg-navy-soft/95 px-4 py-3 text-white" style={{ borderColor: stroke }}>
          <p className="flex items-center gap-2 text-xs font-semibold" style={{ color: stroke }}>
            <AssessmentDisc assessment={result.assessment} className="size-3" />
            {ASSESSMENT_LABEL[result.assessment]}
          </p>
          <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{result.originalText}</p>
        </div>

        {result.connections.length === 0 && (
          <p className="absolute inset-x-0 top-[260px] text-center text-white/60">No related records surfaced from memory for this requirement.</p>
        )}

        {result.connections.map((c, i) => {
          const s = stars[i];
          const active = selected === c.evidenceId;
          const align = s.x < 12 ? "left-0" : s.x > 88 ? "right-0" : "left-1/2 -translate-x-1/2";
          return (
            <button
              key={c.evidenceId}
              onClick={() => onSelect(c.evidenceId)}
              aria-pressed={active}
              className="star-in group absolute w-0 outline-none"
              style={{ left: `${s.x}%`, top: LANE_Y[s.lane], animationDelay: `${order.indexOf(i) * 140}ms` }}
            >
              <span
                className={`absolute left-0 top-0 block -translate-x-1/2 -translate-y-1/2 rounded-full bg-star ${c.role === "direct" ? "size-4" : "size-2.5"}`}
                style={{
                  boxShadow: c.memorySimilarity !== null ? `0 0 0 5px #f6e7c822, 0 0 18px 4px #f6e7c866` : undefined,
                  outline: active ? `2px solid ${c.role === "direct" ? stroke : "#9fb8c6"}` : undefined,
                  outlineOffset: 4,
                }}
              />
              <span
                className={`absolute top-4 block w-36 rounded px-2 py-1.5 text-left transition-colors group-focus-visible:ring-2 group-focus-visible:ring-orange ${align} ${
                  active ? "bg-white text-navy" : "bg-sky/80 text-white/85 group-hover:bg-navy-soft"
                }`}
              >
                <span className={`block text-[11px] font-semibold ${active ? "text-slate" : "text-white/55"}`}>
                  {formatMonth(c.evidenceDate)}
                </span>
                <span className="line-clamp-2 block text-xs font-medium leading-snug">{c.evidenceTitle}</span>
              </span>
            </button>
          );
        })}

        {ticks.map((t) => (
          <span key={t.label} className="absolute -translate-x-1/2 text-xs font-semibold text-white/60" style={{ left: `${t.x}%`, top: AXIS_Y + 8 }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Contribution({ c, active, onSelect }: { c: EvidenceConnection; active: boolean; onSelect: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <li className={`border-l-[3px] py-3 pl-4 ${active ? "border-orange bg-paper" : "border-transparent"}`}>
      <button onClick={onSelect} className="text-left font-semibold hover:underline">
        {c.evidenceTitle}
      </button>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate">
        <span>{formatDate(c.evidenceDate)}</span>
        <span>{TYPE_LABEL[c.evidenceType]}</span>
        {c.evidenceIssuer && <span>Issuer: {c.evidenceIssuer}</span>}
        <span className="font-medium text-navy">{c.role === "direct" ? "Could satisfy on its own" : "Related, partial"}</span>
        {c.memorySimilarity !== null && <span>Retrieval similarity: {Math.round(c.memorySimilarity * 100)}%</span>}
      </p>
      <p className="mt-2 text-sm">{c.contribution}</p>
      <p className="mt-1 text-sm text-slate">{c.relevanceExplanation}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <VerificationTag status={c.verificationStatus} />
        <button className="btn-quiet inline-flex items-center gap-1 text-sm font-semibold" onClick={async () => setMessage(await openOriginal(c.evidenceId))}>
          <Icon name="external" className="size-3.5" /> View source
        </button>
      </div>
      {message && <p className="mt-1 text-sm text-danger" role="alert">{message}</p>}
    </li>
  );
}

/** One requirement's constellation: the sky, then what each record contributes and what's missing. */
export function Constellation({ result, runId }: { result: RequirementResult; runId: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  // Fall back to the first record when nothing is picked or the pick isn't in this result.
  const selected = result.connections.some((c) => c.evidenceId === picked) ? picked : (result.connections[0]?.evidenceId ?? null);

  return (
    <div className="sheet overflow-hidden">
      <Sky key={`${runId}:${result.requirementId}`} result={result} selected={selected} onSelect={setPicked} />

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line bg-sky/[0.03] px-5 py-3 text-xs text-slate">
        <span className="flex items-center gap-2">
          <svg width="28" height="6" aria-hidden="true"><line x1="0" x2="28" y1="3" y2="3" stroke="var(--color-navy)" strokeWidth="2.25" /></svg>
          Could satisfy on its own
        </span>
        <span className="flex items-center gap-2">
          <svg width="28" height="6" aria-hidden="true"><line x1="0" x2="28" y1="3" y2="3" stroke="var(--color-slate)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
          Related, partial
        </span>
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-star shadow-[0_0_0_3px_#f6e7c8,0_0_8px_2px_#e9c98a]" aria-hidden="true" />
          Found by memory search
        </span>
      </div>

      <div className="grid gap-8 p-5 sm:p-7 lg:grid-cols-[1fr_minmax(0,18rem)]">
        <div>
          <h3 className="font-display text-xl font-semibold">Why these records may fit together</h3>
          <p className="mt-2 max-w-prose">{result.explanation}</p>
          {result.connections.length > 0 && (
            <ul className="mt-4 divide-y divide-line">
              {result.connections.map((c) => (
                <Contribution key={c.evidenceId} c={c} active={selected === c.evidenceId} onSelect={() => setPicked(c.evidenceId)} />
              ))}
            </ul>
          )}
        </div>
        <aside className="space-y-6">
          <div>
            <h4 className="font-semibold">Still missing</h4>
            {result.missingDocumentation.length ? (
              <ul className="mt-2 space-y-2">
                {result.missingDocumentation.map((m) => (
                  <li key={m} className="rounded-md border border-dashed border-orange-ink/50 bg-orange-wash px-3 py-2 text-sm">
                    {m}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-slate">Nothing flagged for this requirement.</p>
            )}
          </div>
          {result.uncertainties.length > 0 && (
            <div>
              <h4 className="font-semibold">Uncertain</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-slate">
                {result.uncertainties.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-slate">
            Connections are possible evidence, suggested from your records. They are not official verification.
          </p>
        </aside>
      </div>
    </div>
  );
}
