import type { ApiRequestError } from "@/lib/client/errors";
import { Icon } from "./icons";

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-slate" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-line border-t-navy" aria-hidden="true" />
      {label}
    </div>
  );
}

type Tone = "warning" | "danger" | "info";
const TONE: Record<Tone, string> = {
  warning: "border-orange bg-orange-wash text-navy",
  danger: "border-danger/50 bg-danger-wash text-navy",
  info: "border-line bg-white text-navy",
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-md border-l-4 border-y border-r px-4 py-3 ${TONE[tone]}`} role={tone === "info" ? "note" : "alert"}>
      <Icon name={tone === "info" ? "clock" : "alert"} className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="text-sm text-slate">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: ApiRequestError; onRetry?: () => void }) {
  return (
    <Notice
      tone="danger"
      title={error.missingEndpoint ? "This part of InstallerOS isn't connected yet" : "Couldn't load this"}
      action={
        onRetry && (
          <button className="btn btn-secondary" onClick={onRetry}>
            <Icon name="refresh" className="size-4" /> Try again
          </button>
        )
      }
    >
      {error.message}
    </Notice>
  );
}

export function PageHeader({ title, lede, children }: { title: string; lede?: string; children?: React.ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
        {lede && <p className="mt-2 text-lg text-slate">{lede}</p>}
      </div>
      {children}
    </header>
  );
}
