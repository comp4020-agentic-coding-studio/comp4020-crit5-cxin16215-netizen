import { describe, expect, it } from "vitest";
import {
  PREDATOR_DETECT_RADIUS,
  PREDATOR_GRACE_S,
  PREDATOR_LOSE_RADIUS,
  TIME_LIMIT_S,
  createInitialState,
  isPlayerHidden,
  nextPredatorState,
  stepGame,
  withInvincibility,
  type GameState,
} from "../game.ts";

function stateWithGrass(playerPos: GameState["player"]["pos"], grass: GameState["grass"]): GameState {
  const state = createInitialState(800, 600);
  state.player.pos = playerPos;
  state.grass = grass;
  return state;
}

describe("isPlayerHidden", () => {
  it("is hidden inside a grass patch", () => {
    const state = stateWithGrass({ x: 100, y: 100 }, [{ pos: { x: 100, y: 100 }, radius: 50 }]);
    expect(isPlayerHidden(state)).toBe(true);
  });

  it("is not hidden outside every patch", () => {
    const state = stateWithGrass({ x: 500, y: 500 }, [{ pos: { x: 100, y: 100 }, radius: 50 }]);
    expect(isPlayerHidden(state)).toBe(false);
  });
});

// The one spec-mandated table for the predator: when does it start hunting,
// when does it give up on a chase, and when does neither apply.
describe("nextPredatorState", () => {
  it("starts chasing once in range and not hidden", () => {
    expect(nextPredatorState("patrol", false, PREDATOR_DETECT_RADIUS - 1)).toBe("chase");
  });

  it("stays patrolling while out of detect range", () => {
    expect(nextPredatorState("patrol", false, PREDATOR_DETECT_RADIUS + 1)).toBe("patrol");
  });

  it("never starts chasing a hidden player, even in range", () => {
    expect(nextPredatorState("patrol", true, 0)).toBe("patrol");
  });

  it("breaks off a chase once the player hides", () => {
    expect(nextPredatorState("chase", true, 0)).toBe("search");
  });

  it("breaks off a chase once the player is far enough away", () => {
    expect(nextPredatorState("chase", false, PREDATOR_LOSE_RADIUS + 1)).toBe("search");
  });

  it("keeps chasing while visible and within the lose radius", () => {
    expect(nextPredatorState("chase", false, PREDATOR_LOSE_RADIUS - 1)).toBe("chase");
  });

  it("leaves search alone -- the give-up-to-patrol edge needs a timer, handled by the caller", () => {
    expect(nextPredatorState("search", true, 0)).toBe("search");
  });

  it("cannot acquire a target during the opening grace", () => {
    expect(nextPredatorState("patrol", false, 0, true)).toBe("patrol");
  });

  it("still breaks off a chase during grace -- grace blocks acquiring, not losing", () => {
    expect(nextPredatorState("chase", true, 0, true)).toBe("search");
  });
});

// The opening has to be survivable. A predator that spawns already inside its
// own detection radius kills the player at t~1s with no agency and no score,
// which is the one outcome a 60-second round can't afford -- so both halves
// of that promise get a test.
describe("a survivable opening", () => {
  it("never spawns a predator already able to see the player", () => {
    // Placement is random, so this is a repeated draw rather than one case.
    for (let i = 0; i < 60; i++) {
      const state = createInitialState(900, 650);
      for (const predator of state.predators) {
        const gap = Math.hypot(
          predator.pos.x - state.player.pos.x,
          predator.pos.y - state.player.pos.y,
        );
        expect(gap).toBeGreaterThan(PREDATOR_DETECT_RADIUS);
      }
    }
  });

  it("holds every predator off the player through the grace window", () => {
    const state = createInitialState(900, 650);
    // Park a predator right on top of the player: even point-blank and in the
    // open, grace must keep it patrolling.
    state.grass = [];
    state.predators[0].pos = { x: state.player.pos.x + 5, y: state.player.pos.y };

    stepGame(state, 0.016, { ...state.player.pos });
    expect(state.predators[0]?.state).toBe("patrol");
  });

  it("lets predators hunt again once grace has expired", () => {
    const state = createInitialState(900, 650);
    state.grass = [];
    state.timeLeft = TIME_LIMIT_S - PREDATOR_GRACE_S - 1;
    state.predators[0].pos = { x: state.player.pos.x + 60, y: state.player.pos.y };

    stepGame(state, 0.016, { ...state.player.pos });
    expect(state.predators[0]?.state).toBe("chase");
  });
});

describe("withInvincibility", () => {
  it("turns a death into a no-op while the shield is active", () => {
    expect(withInvincibility("die", 1)).toBe("none");
  });

  it("still kills once the shield has expired", () => {
    expect(withInvincibility("die", 0)).toBe("die");
  });

  it("never changes a crush or a non-collision", () => {
    expect(withInvincibility("crush", 1)).toBe("crush");
    expect(withInvincibility("none", 1)).toBe("none");
  });
});
