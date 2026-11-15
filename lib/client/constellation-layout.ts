/**
 * Positions Evidence Constellation stars on a real time axis.
 * x is a percentage of the canvas width and stays truthful to the date;
 * records close in time are pushed into separate lanes (rows) instead of
 * being moved sideways, so the axis never lies.
 */
export interface Star {
  x: number;
  lane: number;
}
export interface Tick {
  x: number;
  label: string;
}

export const LANES = 3;
const LABEL_GAP = 32; // % of width a label card (w-36 on a >=680px canvas, incl. edge alignment) needs before another can share its lane
const LEFT = 8;
const RIGHT = 92;
const UNDATED_X = 94;

export function layoutStars(dates: (string | null)[]): { stars: Star[]; ticks: Tick[] } {
  const times = dates.map((d) => (d ? Date.parse(d) : null));
  const known = times.filter((t): t is number => t !== null);
  const hasUndated = known.length < times.length;
  const right = hasUndated ? 84 : RIGHT;
  const min = Math.min(...known);
  const max = Math.max(...known);

  const toX = (t: number) => (max === min ? (LEFT + right) / 2 : LEFT + ((t - min) / (max - min)) * (right - LEFT));
  const xs = times.map((t) => (t === null ? UNDATED_X : toX(t)));

  // Greedy lane assignment in time order.
  const stars: Star[] = xs.map((x) => ({ x, lane: 0 }));
  const laneEnd = Array<number>(LANES).fill(-Infinity);
  [...xs.keys()]
    .sort((a, b) => xs[a] - xs[b])
    .forEach((i) => {
      let lane = laneEnd.findIndex((end) => xs[i] - end >= LABEL_GAP);
      if (lane === -1) lane = laneEnd.indexOf(Math.min(...laneEnd)); // ponytail: >3 records in one month overlap; add zoom if that happens
      stars[i].lane = lane;
      laneEnd[lane] = xs[i];
    });

  const ticks: Tick[] = [];
  if (known.length) {
    const first = new Date(min).getUTCFullYear();
    const last = new Date(max).getUTCFullYear();
    for (let y = first + 1; y <= last; y++) ticks.push({ x: toX(Date.UTC(y, 0, 1)), label: String(y) });
    if (!ticks.length) ticks.push({ x: toX(min), label: String(first) });
  }
  if (hasUndated) ticks.push({ x: UNDATED_X, label: "Undated" });
  return { stars, ticks };
}
