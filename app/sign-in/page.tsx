"use client";
import Link from "next/link";
import { useState } from "react";
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
    const { error } = await createBrowserSupabase().auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError(error.message);
    const next = new URLSearchParams(window.location.search).get("next");
    // Only same-site paths: never redirect to another origin.
    window.location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/passport");
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
              <p className="text-sm text-slate">
                Demo account: <span className="font-medium text-navy">alex.morgan@demo.qualitrail.dev</span>. The password is
                DEMO_USER_PASSWORD from your seed environment.
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
