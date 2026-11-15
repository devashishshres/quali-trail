import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy notice for customer acknowledgments", robots: { index: false, follow: false } };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="font-display text-2xl font-bold">Quali<span className="text-orange">Trail</span></p>
      <h1 className="mt-6 font-display text-3xl font-semibold">Privacy notice: customer acknowledgments</h1>
      <div className="mt-4 space-y-4 text-slate">
        <p>A technician using QualiTrail gave us your email address so we can ask you to acknowledge a short description of work.</p>
        <h2 className="font-display text-xl font-semibold text-navy">What we keep, and why</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your email address (and your name, if the technician gave it): to send the invitation and a one-time code. <strong>Removed 90 days after the request closes.</strong></li>
          <li>A scrambled (hashed) form of your address, to apply opt-outs and rate limits. Removed with the address, except as below.</li>
          <li>If you correct or decline: any note you write. <strong>Removed 90 days after the request closes.</strong></li>
          <li>If you acknowledge: the full name you typed, the date, the text you saw and its fingerprint. <strong>These are kept</strong>, because the typed name is the acknowledgment itself and the technician relies on it. The typed name is personal information.</li>
          <li>If you opt out or an email bounces or is reported as unwanted: a hashed form of the address is kept so we do not contact it again.</li>
        </ul>
        <h2 className="font-display text-xl font-semibold text-navy">What an acknowledgment is not</h2>
        <p>It is not a certification, licence or inspection, and QualiTrail does not independently verify your identity or the work. Entering a code shows only that someone with access to the email address the technician provided took part.</p>
        <h2 className="font-display text-xl font-semibold text-navy">Your choices</h2>
        <p>You can ignore the email. On the invitation page you can choose &quot;I don&apos;t want these requests&quot; to stop further messages to your address.</p>
      </div>
    </main>
  );
}
