import { describe, expect, it } from "vitest";
import {
  MAX_TARGET_LEAD,
  clampToLead,
  createInitialState,
  stepGame,
  type Vec2,
} from "../game.ts";

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

describe("clampToLead", () => {
  it("leaves a target that is already close enough alone", () => {
    const target = { x: 110, y: 100 };
    expect(clampToLead(target, { x: 100, y: 100 }, 50)).toEqual(target);
  });

  it("pulls a distant target onto the leash circle", () => {
    const clamped = clampToLead({ x: 500, y: 100 }, { x: 100, y: 100 }, 50);
    expect(dist(clamped, { x: 100, y: 100 })).toBeCloseTo(50);
  });

  it("keeps the direction it was pulled from -- leashing must not steer", () => {
    const from = { x: 100, y: 100 };
    const clamped = clampToLead({ x: 400, y: 400 }, from, 50);
    expect(clamped.x - from.x).toBeCloseTo(clamped.y - from.y);
  });

  it("survives a target sitting exactly on the player", () => {
    const from = { x: 100, y: 100 };
    expect(clampToLead({ ...from }, from, 50)).toEqual(from);
  });
});

// The regression this exists for: movement eases toward the target, but the
// player is afterwards clamped to the canvas and pushed out of boulders --
// while the target kept accumulating pointer travel. Blocked players banked
// distance they could never spend, and it discharged as one lurch the instant
// they came free. The contract is that the gap is always bounded, so the
// catch-up step always is too.
describe("the follow target never banks unspendable distance", () => {
  it("stays within the leash even when the pointer is driven far off-map", () => {
    const state = createInitialState(900, 650);
    const target = { x: 5000, y: 5000 };
    for (let i = 0; i < 30; i++) stepGame(state, 1 / 60, target);
    expect(dist(target, state.player.pos)).toBeLessThanOrEqual(MAX_TARGET_LEAD + 1e-6);
  });

  it("bounds the catch-up step after the player is held against a wall", () => {
    const state = createInitialState(900, 650);
    // A boulder dead ahead, and a pointer shoving into it for a full second.
    state.walls = [
      { pos: { x: 520, y: 325 }, radius: 40, clusterId: 0, pathIndex: 0, closed: false },
    ];
    const target = { x: 900, y: 325 };
    for (let i = 0; i < 60; i++) stepGame(state, 1 / 60, target);

    // Now steer away. Without the leash the banked gap made this first step
    // enormous; it must instead be capped by the leash and the ease.
    const before = { ...state.player.pos };
    target.x = state.player.pos.x;
    target.y = state.player.pos.y - 300;
    stepGame(state, 1 / 60, target);
    const step = dist(state.player.pos, before);

    const maxStep = MAX_TARGET_LEAD * (1 - Math.exp(-11 / 60));
    expect(step).toBeLessThanOrEqual(maxStep + 1e-6);
  });
});
