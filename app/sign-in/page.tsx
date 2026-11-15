"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FIXTURE_MODE } from "@/lib/client/api";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Notice } from "@/components/ui/states";

export default function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { error } = await createBrowserSupabase().auth.signInWithPassword({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (error) return setError("Sign-in failed. Check your email and password and try again.");
      const next = new URLSearchParams(window.location.search).get("next");
      const destination = next ? new URL(next, window.location.origin) : null;
      // "/" lets the server route by role (worker, supervisor, or onboarding).
      window.location.assign(destination?.origin === window.location.origin ? destination.pathname + destination.search + destination.hash : "/");
    } catch {
      setError("Couldn't connect to sign-in. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,40%)]">
      <section className="relative hidden overflow-hidden bg-navy p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <p className="font-display text-3xl font-bold">
          Quali<span className="text-orange">Trail</span>
        </p>
        <div className="max-w-md">
          <p className="font-display text-6xl font-semibold leading-[0.95] tracking-tight">
            Your experience.
            <br />
            Recognized.
            <br />
            Portable.
          </p>
          <p className="mt-6 text-lg text-white/70">
            Keep your certificates, training and work records in one place, and bring the right ones to every job you apply for.
          </p>
        </div>
        <div className="hazard h-1.5 w-24" aria-hidden="true" />
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-4xl font-semibold">Sign in</h1>
          <Suspense fallback={null}>
            <ConfirmNotice />
          </Suspense>
          {FIXTURE_MODE ? (
            <div className="mt-6 space-y-4">
              <Notice title="Fixture mode is on">Sign-in isn&apos;t needed while the app is showing sample data.</Notice>
              <Link href="/passport" className="btn btn-primary w-full">
                Open Passport
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-semibold">Email</span>
                <input name="email" type="email" required autoComplete="email" className="field" />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold">Password</span>
                <input name="password" type="password" required autoComplete="current-password" className="field" />
              </label>
              {error && <Notice tone="danger" title="Sign-in failed">{error}</Notice>}
              <button className="btn btn-primary w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <p className="flex justify-between gap-4 text-sm text-slate">
                <span>New here? <SignUpLink /></span>
                <Link href="/forgot-password" className="font-semibold underline">Forgot password?</Link>
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function ConfirmNotice() {
  const notice = useSearchParams().get("notice");
  if (notice === "expired") {
    return (
      <div className="mt-4">
        <Notice title="That email link has expired or was already used">If you already confirmed your address, sign in below. Otherwise sign up again to get a new link.</Notice>
      </div>
    );
  }
  if (notice !== "confirm") return null;
  return (
    <div className="mt-4">
      <Notice title="Email link opened">If your email address is now confirmed, sign in below. If the link had expired, sign up again to get a new one.</Notice>
    </div>
  );
}

function SignUpLink() {
  return (
    <Suspense fallback={<Link href="/sign-up" className="font-semibold underline">Create an account</Link>}>
      <SignUpLinkInner />
    </Suspense>
  );
}
function SignUpLinkInner() {
  const next = useSearchParams().get("next");
  return (
    <Link href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"} className="font-semibold underline">
      Create an account
    </Link>
  );
}
