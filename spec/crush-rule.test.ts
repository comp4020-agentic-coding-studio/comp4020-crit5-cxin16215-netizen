import { describe, expect, it } from "vitest";
import { CRUSH_RATIO, resolveHazardCollision, type Hazard, type Player } from "../game.ts";

function player(radius: number): Player {
  return { pos: { x: 0, y: 0 }, radius };
}

function hazard(radius: number, distanceFromPlayer: number): Hazard {
  return { pos: { x: distanceFromPlayer, y: 0 }, radius, tier: 0 };
}

// The one spec-mandated focused test: growing into a hazard should crush it
// once you're big enough, and kill you otherwise. This is the rule the whole
// "grow or get squashed" trade-off rests on.
describe("resolveHazardCollision", () => {
  it("does nothing when the circles don't overlap", () => {
    expect(resolveHazardCollision(player(10), hazard(10, 100))).toBe("none");
  });

  it("crushes a hazard once the player is big enough", () => {
    const bigEnough = 10 * CRUSH_RATIO + 0.01;
    expect(resolveHazardCollision(player(bigEnough), hazard(10, 5))).toBe("crush");
  });

  it("kills the player when they're too small", () => {
    const tooSmall = 10 * CRUSH_RATIO - 0.01;
    expect(resolveHazardCollision(player(tooSmall), hazard(10, 5))).toBe("die");
  });

  it("draws the line exactly at the crush ratio", () => {
    const exact = 10 * CRUSH_RATIO;
    expect(resolveHazardCollision(player(exact), hazard(10, 5))).toBe("crush");
  });
});
