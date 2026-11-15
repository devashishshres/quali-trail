import Link from "next/link";

/** Employer reviewers: a plain read-only frame, separate from the technician and supervisor areas. */
export default function EmployerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="no-print border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-8">
          <Link href="/employer" className="font-display text-xl font-bold">Quali<span className="text-orange">Trail</span></Link>
          <span className="text-sm text-slate">Shared packets (read-only)</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-8">{children}</main>
    </div>
  );
}
