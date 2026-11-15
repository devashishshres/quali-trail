/** Regression: returning to a window fired focus AND visibilitychange, so pages fetched twice and the employer
 * packet logged two views per return. One return must trigger one refresh. */
import { describe, expect, it } from "vitest";
import { onReturnToPage } from "@/lib/client/on-return";

function setup(gapMs = 1000) {
  let t = 0;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let calls = 0;
  const off = onReturnToPage(win, doc, () => { calls++; }, { gapMs, now: () => t });
  const back = () => { win.dispatchEvent(new Event("focus")); doc.dispatchEvent(new Event("visibilitychange")); };
  return { win, doc, back, off, tick: (ms: number) => { t += ms; }, calls: () => calls };
}

describe("onReturnToPage", () => {
  it("coalesces focus + visibilitychange from one return into one refresh", () => {
    const s = setup();
    s.back();
    expect(s.calls()).toBe(1);
  });
  it("separate returns each refresh once", () => {
    const s = setup();
    s.back(); s.tick(5000); s.back(); s.tick(5000); s.back();
    expect(s.calls()).toBe(3);
  });
  it("does nothing while hidden, and nothing after unsubscribing", () => {
    const s = setup();
    s.doc.visibilityState = "hidden";
    s.back();
    expect(s.calls()).toBe(0);
    s.doc.visibilityState = "visible";
    s.off();
    s.tick(5000); s.back();
    expect(s.calls()).toBe(0);
  });
});
