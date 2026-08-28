// Wires input, the game loop, and rendering together. No game rules live
// here -- they're all in game.ts, which is what spec/crush-rule.test.ts
// exercises directly.

import { isMuted, playEvents, toggleMute, unlockAudio, updateAudio } from "./audio.ts";
import { createInitialState, stepGame, type GameState, type Vec2 } from "./game.ts";
import { createFxState, emitFx, resetFx, stepFx } from "./fx.ts";
import { render } from "./render.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const ctx = canvas.getContext("2d")!;

let state: GameState = createInitialState(window.innerWidth, window.innerHeight);
const target: Vec2 = { x: state.player.pos.x, y: state.player.pos.y };
const fx = createFxState();

// The personal best is the whole reason to play a second time, so it has to
// outlive the tab. localStorage can throw outright (Safari private mode, a
// browser set to block site data) rather than merely returning null, and a
// missing high score is never worth taking the game down over -- so both
// sides are wrapped and a failure just means "no record yet".
const BEST_KEY = "swell.best";

function loadBest(): number {
  try {
    const raw = Number(window.localStorage.getItem(BEST_KEY));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
}

function saveBest(value: number): void {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    /* no persistence available -- the in-memory best still holds for this tab */
  }
}

let best = loadBest();
let newBest = false;
// Guards the one-shot record write: stepGame keeps returning an ended state
// every frame, and without this the end screen would re-bank the same score
// forever.
let scoreBanked = false;

function restart(): void {
  state = createInitialState(window.innerWidth, window.innerHeight);
  target.x = state.player.pos.x;
  target.y = state.player.pos.y;
  resetFx(fx);
  newBest = false;
  scoreBanked = false;
}

// Records the finished round exactly once. Called from the loop rather than
// from the death sites, so it catches every way a round can end -- crushed,
// drained, timed out or won -- without game.ts needing to know storage exists.
function bankScore(): void {
  if (scoreBanked) return;
  scoreBanked = true;
  if (state.score > best) {
    best = state.score;
    newBest = true;
    saveBest(best);
  }
}

// Backing-store resolution is the biggest lever on frame time here, because
// this renderer is fill-rate bound rather than CPU bound. Uncapped, a
// 1920x1080 window on a 2x display renders 3840x2160 -- 8.3M pixels a frame.
// Capping at 1.5 cuts that by 44% for a difference you have to hunt for on
// soft-edged art like this.
const MAX_DPR = 1.5;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
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
  // Browsers refuse to start audio before a gesture, so this is the earliest
  // legitimate moment to build the audio graph.
  unlockAudio();

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
  restart();
});

// Keyboard is a full alternative to the pointer: arrow keys/WASD nudge the
// same `target` the pointer drives, and Enter/Space restarts from the end
// screen -- so play doesn't require a mouse, with no on-screen hint needed
// (the keys either do something on the first try or they don't).
const KEYBOARD_SPEED = 340;
const MOVE_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"]);
const heldKeys = new Set<string>();

window.addEventListener("keydown", (e) => {
  unlockAudio();
  const key = e.key.toLowerCase();
  if (MOVE_KEYS.has(key)) {
    heldKeys.add(key);
    e.preventDefault();
  } else if (key === "m") {
    e.preventDefault();
    toggleMute();
  } else if (state.status !== "playing" && (key === "enter" || key === " ")) {
    e.preventDefault();
    restart();
  }
});
window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));

function applyKeyboardMovement(dt: number): void {
  let dx = 0;
  let dy = 0;
  if (heldKeys.has("arrowup") || heldKeys.has("w")) dy -= 1;
  if (heldKeys.has("arrowdown") || heldKeys.has("s")) dy += 1;
  if (heldKeys.has("arrowleft") || heldKeys.has("a")) dx -= 1;
  if (heldKeys.has("arrowright") || heldKeys.has("d")) dx += 1;
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy);
  target.x = Math.max(0, Math.min(state.width, target.x + (dx / len) * KEYBOARD_SPEED * dt));
  target.y = Math.max(0, Math.min(state.height, target.y + (dy / len) * KEYBOARD_SPEED * dt));
}

window.addEventListener("resize", resize);
resize();

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  applyKeyboardMovement(dt);
  stepGame(state, dt, target);

  // stepGame's events live for exactly this frame, so both consumers read
  // them here, before anything can clear them.
  emitFx(fx, state.events);
  playEvents(state.events);
  updateAudio(state);
  if (state.status !== "playing") bankScore();

  stepFx(fx, dt);
  render(ctx, state, fx, { best, newBest, muted: isMuted() }, now / 1000);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
