/**
 * Logging that cannot leak sign-off secrets. Anything that looks like a token, a code,
 * an email address, or a signoff URL fragment is replaced before a line is written.
 */
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_FRAGMENT = /#t=[A-Za-z0-9_-]+/g;
const LONG_SECRET = /\b[A-Za-z0-9_-]{32,}\b/g;
const CODE = /\b\d{6}\b/g;

export function redact(text: string): string {
  return text.replace(TOKEN_FRAGMENT, "#t=[redacted]").replace(EMAIL, "[email]").replace(LONG_SECRET, "[redacted]").replace(CODE, "[code]");
}

/** Log an error without its message body being trusted: fixed event name + redacted, truncated message. */
export function logSignoffError(event: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown";
  console.error(`signoff:${event}`, { message: redact(message).slice(0, 200) });
}
