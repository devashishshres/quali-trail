/**
 * Calls `cb` when the user comes back to the page. Returning to a window usually fires BOTH `focus` and
 * `visibilitychange`; those are coalesced into one call (within `gapMs`) so a page refreshes once, not twice.
 * Returns an unsubscribe function. Pure apart from the targets passed in, so it can be tested without a browser.
 */
export function onReturnToPage(
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: string },
  cb: () => void,
  opts: { gapMs?: number; now?: () => number } = {},
): () => void {
  const gapMs = opts.gapMs ?? 1000;
  const now = opts.now ?? (() => Date.now());
  let last = -Infinity;
  const fire = () => {
    if (doc.visibilityState !== "visible") return;
    const t = now();
    if (t - last < gapMs) return;
    last = t;
    cb();
  };
  win.addEventListener("focus", fire);
  doc.addEventListener("visibilitychange", fire);
  return () => {
    win.removeEventListener("focus", fire);
    doc.removeEventListener("visibilitychange", fire);
  };
}
