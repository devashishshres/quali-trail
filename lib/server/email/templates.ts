/**
 * Every outgoing message, in plain text and HTML. Content is deliberately minimal: names, a link or a code,
 * and what to do. No job details travel by email (customers see those only after verifying).
 * Simulated (mock) messages carry a SIMULATED marker in the subject and body.
 */
export type EmailKind =
  | "customer_invitation"
  | "customer_code"
  | "customer_receipt"
  | "supervisor_invitation"
  | "review_notification"
  | "decision_notice"
  | "reminder"
  | "employer_share_invitation";

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Block {
  p?: string;
  link?: { href: string; label: string };
  code?: string;
  small?: string;
}

function render(subject: string, blocks: Block[], opts: { base: string; mock: boolean }): Rendered {
  const sim = "SIMULATED MESSAGE. This is a development test; no real email was sent.";
  const footer = `Privacy notice: ${opts.base}/signoff/privacy`;
  const text = [
    ...(opts.mock ? [sim, ""] : []),
    ...blocks.flatMap((b) => [b.p, b.link && `${b.link.label}: ${b.link.href}`, b.code && `Code: ${b.code}`, b.small].filter(Boolean) as string[]),
    "",
    footer,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1b2a3a;max-width:560px;margin:0 auto;padding:24px">
${opts.mock ? `<p style="border:2px dashed #c2410c;padding:8px;font-weight:bold;color:#9a3412">${esc(sim)}</p>` : ""}
<p style="font-size:20px;font-weight:bold">QualiTrail</p>
${blocks
  .map((b) =>
    [
      b.p && `<p>${esc(b.p)}</p>`,
      b.link && `<p><a href="${esc(b.link.href)}" style="display:inline-block;background:#1b2a3a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(b.link.label)}</a></p>`,
      b.code && `<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${esc(b.code)}</p>`,
      b.small && `<p style="font-size:12px;color:#5b6b7b">${esc(b.small)}</p>`,
    ]
      .filter(Boolean)
      .join("\n"),
  )
  .join("\n")}
<p style="font-size:12px;color:#5b6b7b"><a href="${esc(opts.base)}/signoff/privacy">Privacy notice</a></p>
</body></html>`;
  return { subject: `${opts.mock ? "[SIMULATED] " : ""}${subject}`, text, html };
}

type Ctx = { base: string; mock: boolean };

export const templates = {
  customerInvitation: (c: Ctx & { workerName: string; link: string; validDays: number }) =>
    render(`${c.workerName} asked you to acknowledge a description of work`, [
      { p: `${c.workerName} asked you to review a short description of work they did and say whether it is accurate.` },
      { link: { href: c.link, label: "Continue" } },
      { small: `This link opens a sign-in step only. You will get a separate one-time code by email before any details are shown. It expires in ${c.validDays} days. If you weren't expecting this, ignore it, or choose "I don't want these requests" on that page.` },
    ], c),

  customerCode: (c: Ctx & { workerName: string; code: string }) =>
    render("Your QualiTrail verification code", [
      { p: `Your code for the acknowledgment requested by ${c.workerName}:` },
      { code: c.code },
      { small: "It works once and expires in 10 minutes. If you didn't ask for it, ignore this email." },
    ], c),

  customerReceipt: (c: Ctx & { workerName: string; decisionLabel: string }) =>
    render("Your response was recorded", [
      { p: `Thank you. Your response to ${c.workerName}'s request was recorded: ${c.decisionLabel}.` },
      { small: "No further action is needed. If you didn't do this, reply is not monitored; contact the technician directly." },
    ], c),

  supervisorInvitation: (c: Ctx & { workerName: string; link: string; validDays: number }) =>
    render(`${c.workerName} invited you to review their completed jobs`, [
      { p: `${c.workerName} uses QualiTrail to keep a record of their work and would like you, as someone who supervises or has seen their work, to be able to review job records they send you.` },
      { link: { href: c.link, label: "Review the invitation" } },
      { small: `You will need to sign in or create an account with this email address. Accepting confirms only that you control this address and agree to receive review requests; it does not verify employment or credentials. The invitation expires in ${c.validDays} days.` },
    ], c),

  reviewNotification: (c: Ctx & { workerName: string; link: string }) =>
    render(`${c.workerName} sent you a job to review`, [
      { p: `${c.workerName} asked you to review a completed job record.` },
      { link: { href: c.link, label: "Open in QualiTrail" } },
      { small: "Opening this link does not approve anything. You decide after signing in." },
    ], c),

  decisionNotice: (c: Ctx & { who: "customer" | "supervisor"; title: string; decisionLabel: string; link: string }) =>
    render(`A ${c.who} responded to your request`, [
      { p: `A ${c.who} responded to your request about "${c.title}": ${c.decisionLabel}.` },
      { link: { href: c.link, label: "See it in QualiTrail" } },
    ], c),

  employerShareInvitation: (c: Ctx & { workerName: string; link: string; validDays: number }) =>
    render(`${c.workerName} shared records with you`, [
      { p: `${c.workerName} uses QualiTrail to keep records of their training and work, and chose to share read-only copies of selected confirmed work and certifications with this email address.` },
      { link: { href: c.link, label: "View the shared records" } },
      { small: `Sign in or create an account with this email address to open it. Signing in shows only that you control this address; it does not verify your identity or employer, or any of the records. Access ends in ${c.validDays} days, or sooner if ${c.workerName} withdraws it.` },
    ], c),

  reminder: (c: Ctx & { workerName: string; link: string; what: "customer" | "supervisor" }) =>
    render(`Reminder: ${c.workerName} is waiting for your response`, [
      { p: `${c.workerName} is still waiting for your response.` },
      { link: { href: c.link, label: c.what === "customer" ? "Continue" : "Open in QualiTrail" } },
      { small: c.what === "customer" ? "Any earlier link from this request no longer works." : "Opening this link does not approve anything." },
    ], c),
};
