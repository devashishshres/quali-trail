"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Notice, Loading } from "@/components/ui/states";
import { accountsApi } from "@/lib/client/accounts-api";
import { toApiError } from "@/lib/client/errors";
import { useLoad } from "@/lib/client/use-load";
import { createBrowserSupabase } from "@/lib/supabase/browser";

const ARRANGEMENTS = [
  ["employee", "Employee"],
  ["contractor", "Contractor"],
  ["self_employed", "Self-employed"],
  ["apprentice", "Apprentice"],
  ["other", "Other"],
] as const;

/** Only same-site relative destinations. */
const safe = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/");

function Onboarding() {
  const params = useSearchParams();
  const wanted = params.get("role");
  const next = safe(params.get("next"));
  const me = useLoad(accountsApi.me);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  if (me.status === "loading") return <Loading label="Loading your account…" />;
  if (me.error) return <Notice tone="danger" title="Couldn't load your account">{me.error.message}</Notice>;
  const m = me.data!;

  async function submit(role: "worker" | "supervisor", e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim() || null;
    setBusy(role);
    setError(null);
    setFieldErrors({});
    try {
      await accountsApi.onboard(
        role === "worker"
          ? { role, name: s("name") ?? "", trade: s("trade") ?? "", summary: s("summary"), employmentArrangement: (s("arrangement") as never) ?? null, addSampleOpportunity: f.get("sample") === "on" }
          : { role, name: s("name") ?? "", organization: s("organization"), title: s("title") },
      );
      window.location.assign(next);
    } catch (x) {
      const a = toApiError(x);
      setError(a.message);
      setFieldErrors(a.fieldErrors ?? {});
    } finally {
      setBusy(null);
    }
  }
  const err = (k: string) => fieldErrors[k] && <span className="mt-1 block text-xs text-danger">{fieldErrors[k].join(" ")}</span>;

  if (!m.emailConfirmed) return <Notice title="Confirm your email">Open the link we emailed you, then come back here.</Notice>;
  if (!m.canOnboard) {
    return (
      <Notice title="Not on the preview list yet" action={<button className="btn btn-secondary" onClick={async () => {
        await createBrowserSupabase().auth.signOut();
        // Full navigation on purpose: drops any state from the signed-in session.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/sign-in");
      }}>Sign out</button>}>
        This account ({m.email}) isn&apos;t approved for the preview. If someone invited you to review their work, open the link in their invitation email.
      </Notice>
    );
  }

  const done = m.worker && m.supervisor;
  return (
    <div className="space-y-8">
      {done && (
        <Notice title="You're all set" action={<Link className="btn btn-primary" href={next}>Continue</Link>}>
          You have both a technician profile and a reviewer profile.
        </Notice>
      )}
      {error && <Notice tone="danger" title="Couldn't save your profile">{error}</Notice>}

      {!m.worker && wanted !== "supervisor" && (
        <form onSubmit={(e) => submit("worker", e)} className="sheet space-y-4 p-5 sm:p-7">
          <h2 className="font-display text-2xl font-semibold">I&apos;m a technician</h2>
          <p className="text-sm text-slate">Keep your work records and certificates and build qualification packets. You start with an empty record; nothing is added for you.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-sm font-semibold">Your name</span><input name="name" className="field" required maxLength={200} autoComplete="name" />{err("name")}</label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">Trade</span><input name="trade" className="field" required maxLength={200} placeholder="e.g. HVAC / heat pumps" />{err("trade")}</label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">How you work (optional)</span>
              <select name="arrangement" className="field" defaultValue=""><option value="">Prefer not to say</option>{ARRANGEMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
          </div>
          <label className="block"><span className="mb-1 block text-sm font-semibold">Short summary (optional)</span><textarea name="summary" className="field" rows={3} maxLength={1000} /><span className="mt-1 block text-xs text-slate">Shown as your own words, not verified.</span></label>
          <label className="flex gap-2 text-sm"><input type="checkbox" name="sample" /> Add a sample job posting (clearly marked fictional) so I can try matching</label>
          <button className="btn btn-primary" disabled={busy !== null}>{busy === "worker" ? "Saving…" : "Create technician profile"}</button>
        </form>
      )}

      {!m.supervisor && wanted !== "worker" && (
        <form onSubmit={(e) => submit("supervisor", e)} className="sheet space-y-4 p-5 sm:p-7">
          <h2 className="font-display text-2xl font-semibold">I review technicians&apos; work</h2>
          <p className="text-sm text-slate">For supervisors, leads and others a technician invites. A reviewer profile on its own gives you access to no one&apos;s records; a technician has to invite you and you have to accept.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block"><span className="mb-1 block text-sm font-semibold">Your name</span><input name="name" className="field" required maxLength={200} autoComplete="name" />{err("name")}</label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">Organization (optional)</span><input name="organization" className="field" maxLength={200} /></label>
            <label className="block"><span className="mb-1 block text-sm font-semibold">Title (optional)</span><input name="title" className="field" maxLength={200} /></label>
          </div>
          <p className="text-xs text-slate">These details are shown with your reviews as you entered them. QualiTrail doesn&apos;t verify them.</p>
          <button className="btn btn-primary" disabled={busy !== null}>{busy === "supervisor" ? "Saving…" : "Create reviewer profile"}</button>
        </form>
      )}

      {(m.worker || m.supervisor) && !done && (
        <p className="text-sm text-slate">
          {m.worker ? <Link className="underline" href="/passport">Go to your passport</Link> : <Link className="underline" href="/supervisor">Go to your reviews</Link>}
          {wanted && " · "}
          {wanted && <Link className="underline" href="/onboarding">Show all options</Link>}
        </p>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Set up your account</h1>
      <p className="mt-2 text-slate">Choose one or both. You can add the other later.</p>
      <div className="mt-8"><Suspense fallback={null}><Onboarding /></Suspense></div>
    </main>
  );
}
