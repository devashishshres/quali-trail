import { describe, expect, it } from "vitest";
import { layoutStars } from "../lib/client/constellation-layout";

describe("layoutStars", () => {
  it("keeps x in date order and puts records from the same month in different lanes", () => {
    const { stars } = layoutStars(["2025-03-14", "2025-09-17", "2026-06-05", "2026-06-22"]);
    expect(stars.map((s) => s.x)).toEqual([...stars.map((s) => s.x)].sort((a, b) => a - b));
    expect(stars[0].x).toBe(8);
    expect(stars[3].x).toBe(92);
    expect(stars[2].lane).not.toBe(stars[3].lane);
  });

  it("places undated records at the far right with their own tick", () => {
    const { stars, ticks } = layoutStars(["2025-03-14", null]);
    expect(stars[1].x).toBeGreaterThan(stars[0].x);
    expect(ticks.at(-1)?.label).toBe("Undated");
  });

  it("centres a single record and adds a year tick for 2026", () => {
    const { stars, ticks } = layoutStars(["2026-06-05"]);
    expect(stars[0].x).toBe(50);
    expect(ticks).toEqual([{ x: 50, label: "2026" }]);
  });

  it("adds a tick at each new year inside the range", () => {
    const { ticks } = layoutStars(["2025-03-14", "2026-06-22"]);
    expect(ticks.map((t) => t.label)).toEqual(["2026"]);
  });
});
