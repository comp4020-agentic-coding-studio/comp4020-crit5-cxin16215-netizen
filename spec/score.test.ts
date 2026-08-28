import { describe, expect, it } from "vitest";
import {
  COMBO_MAX_CHAIN,
  COMBO_STEP,
  COMBO_WINDOW_S,
  comboMultiplier,
  createInitialState,
  crushPoints,
  FOOD_POINTS,
  foodPoints,
  stepGame,
} from "../game.ts";

// The combo is what turns "avoid everything" into a real decision, so the
// shape of its curve is a contract, not an implementation detail: a lone bite
// must be worth face value, a chain must pay more, and the payoff must stop
// climbing so one lucky food cluster can't decide the round.
describe("comboMultiplier", () => {
  it("pays face value for a bite that isn't part of a chain", () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(1)).toBe(1);
  });

  it("climbs one step per chained bite", () => {
    expect(comboMultiplier(2)).toBeCloseTo(1 + COMBO_STEP);
    expect(comboMultiplier(4)).toBeCloseTo(1 + 3 * COMBO_STEP);
  });

  it("stops climbing at the cap", () => {
    const capped = 1 + COMBO_MAX_CHAIN * COMBO_STEP;
    expect(comboMultiplier(COMBO_MAX_CHAIN + 1)).toBeCloseTo(capped);
    expect(comboMultiplier(999)).toBeCloseTo(capped);
  });
});

describe("scoring", () => {
  it("pays a single pellet its base value", () => {
    expect(foodPoints(1)).toBe(FOOD_POINTS);
  });

  it("pays a chained pellet more than a lone one", () => {
    expect(foodPoints(5)).toBeGreaterThan(foodPoints(1));
  });

  // Crushes scale with what you crushed, so the things that spent the round
  // able to kill you stay the most valuable targets right to the end.
  it("pays more for crushing something bigger", () => {
    expect(crushPoints(34, 1)).toBeGreaterThan(crushPoints(13, 1));
  });

  it("is worth more to crush than to eat a pellet", () => {
    expect(crushPoints(13, 1)).toBeGreaterThan(foodPoints(1));
  });
});

// The lapse timer is the pressure: a chain that never expired would make
// standing still free, which is exactly the behaviour the combo exists to
// discourage.
describe("combo decay", () => {
  it("clears the chain once the window lapses", () => {
    const state = createInitialState(800, 600);
    state.combo = 5;
    state.comboTimeLeft = COMBO_WINDOW_S;

    stepGame(state, COMBO_WINDOW_S / 2, { ...state.player.pos });
    expect(state.combo).toBe(5);

    stepGame(state, COMBO_WINDOW_S, { ...state.player.pos });
    expect(state.combo).toBe(0);
  });
});

// fx.ts and audio.ts both read this list once per frame and neither clears
// it, so stepGame owning its lifetime is what stops a death sting from
// replaying on every frame of the end screen.
describe("event list", () => {
  it("is emptied at the start of every step", () => {
    const state = createInitialState(800, 600);
    state.events.push({ kind: "eat", pos: { x: 0, y: 0 }, radius: 1, points: 1, combo: 1 });
    stepGame(state, 0.016, { ...state.player.pos });
    expect(state.events.some((e) => e.points === 1 && e.radius === 1)).toBe(false);
  });

  it("stays empty once the round is over", () => {
    const state = createInitialState(800, 600);
    state.status = "lost";
    state.events.push({ kind: "death", pos: { x: 0, y: 0 }, radius: 9, points: 0, combo: 0 });
    stepGame(state, 0.016, { ...state.player.pos });
    expect(state.events).toHaveLength(0);
  });
});
