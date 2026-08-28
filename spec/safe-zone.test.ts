import { describe, expect, it } from "vitest";
import {
  SAFE_ZONE_MIN_FRACTION,
  SAFE_ZONE_SHRINK_END_S,
  SAFE_ZONE_SHRINK_START_S,
  safeZoneRadius,
} from "../game.ts";

const WIDTH = 800;
const HEIGHT = 600;
const FULL_RADIUS = Math.hypot(WIDTH, HEIGHT) / 2;

// The mid-round escalation mechanic rests entirely on this curve: harmless
// (full-map) before the shrink starts, linear in between, clamped to its
// floor after the shrink ends.
describe("safeZoneRadius", () => {
  it("covers the whole map before the shrink starts", () => {
    expect(safeZoneRadius(WIDTH, HEIGHT, 0)).toBeCloseTo(FULL_RADIUS);
    expect(safeZoneRadius(WIDTH, HEIGHT, SAFE_ZONE_SHRINK_START_S)).toBeCloseTo(FULL_RADIUS);
  });

  it("shrinks linearly halfway through the shrink window", () => {
    const mid = (SAFE_ZONE_SHRINK_START_S + SAFE_ZONE_SHRINK_END_S) / 2;
    const expected = FULL_RADIUS * (1 - 0.5 * (1 - SAFE_ZONE_MIN_FRACTION));
    expect(safeZoneRadius(WIDTH, HEIGHT, mid)).toBeCloseTo(expected);
  });

  it("clamps to the minimum fraction at and beyond the shrink end", () => {
    const min = FULL_RADIUS * SAFE_ZONE_MIN_FRACTION;
    expect(safeZoneRadius(WIDTH, HEIGHT, SAFE_ZONE_SHRINK_END_S)).toBeCloseTo(min);
    expect(safeZoneRadius(WIDTH, HEIGHT, SAFE_ZONE_SHRINK_END_S + 100)).toBeCloseTo(min);
  });
});
