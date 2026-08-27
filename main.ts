// Wires input, the game loop, and rendering together. No game rules live
// here -- they're all in game.ts, which is what spec/crush-rule.test.ts
// exercises directly.

import { createInitialState, stepGame, type GameState, type Vec2 } from "./game.ts";
import { render } from "./render.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const ctx = canvas.getContext("2d")!;

let state: GameState = createInitialState(window.innerWidth, window.innerHeight);
const target: Vec2 = { x: state.player.pos.x, y: state.player.pos.y };

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  // Without this, shrinking the window leaves `target` sitting at its old,
  // now out-of-bounds position -- since movement is delta-based, the player
  // stays pinned to the wall nearest the stale target until enough mouse
  // travel drags it back in, making the controls feel dead for a while.
  target.x = Math.max(0, Math.min(state.width, target.x));
  target.y = Math.max(0, Math.min(state.height, target.y));
}

function setTarget(clientX: number, clientY: number): void {
  target.x = Math.max(0, Math.min(state.width, clientX));
  target.y = Math.max(0, Math.min(state.height, clientY));
}

// Move by mouse DELTA, not absolute screen position -- so wherever the
// cursor happens to be resting (left over from before the page loaded, or
// from the click that just restarted the round) never matters. Snapping
// `target` straight to clientX/clientY would beeline the ball there the
// instant any movement is detected -- a fast multi-frame rush, not just a
// one-frame flick -- toward whatever's at that arbitrary spot, hazard or
// not, without the player ever choosing to go there. A delta only nudges
// `target` by exactly how far the hand actually moved, starting from
// wherever the ball already is -- and a browser's synthetic focus/load
// "resync" pointermove always carries a zero delta (it isn't real hardware
// motion), so it's naturally a no-op with no special-casing needed. Touch is
// exempt: a finger's first contact point IS the deliberate target, there's
// no "resting position" to guard against, and touch-derived movementX/Y
// support is shakier across browsers.
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") {
    setTarget(e.clientX, e.clientY);
    return;
  }
  target.x = Math.max(0, Math.min(state.width, target.x + e.movementX));
  target.y = Math.max(0, Math.min(state.height, target.y + e.movementY));
});

// Delta-based movement has one gap: the real OS cursor can still physically
// hit the edge of the screen, and once it's pinned there, pushing further
// produces no more movement events -- a dead zone right when the player
// wants to keep going. Pointer Lock removes the OS cursor from the picture
// entirely once engaged, so movementX/Y keep flowing no matter how far the
// hand keeps moving. Mouse-only: touch has no such edge to get stuck at.
function isLocked(): boolean {
  return document.pointerLockElement === canvas;
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" && !isLocked()) {
    // Rejects (e.g. the browser's re-lock cooldown right after Escape) are
    // expected and harmless -- the next click just tries again.
    canvas.requestPointerLock().catch(() => {});
  }

  if (state.status === "playing") {
    // Once locked, a click's clientX/clientY no longer tracks anything real
    // (the browser freezes it), so only pre-lock clicks and touch taps still
    // jump the target -- everything after relies on the movement delta.
    if (e.pointerType === "touch" || !isLocked()) {
      setTarget(e.clientX, e.clientY);
    }
    return;
  }
  state = createInitialState(window.innerWidth, window.innerHeight);
  target.x = state.player.pos.x;
  target.y = state.player.pos.y;
});

window.addEventListener("resize", resize);
resize();

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stepGame(state, dt, target);
  render(ctx, state, now / 1000);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
