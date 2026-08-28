// Presentation-only feedback: the particles, floating numbers, screen shake
// and colour flashes that give a moment weight. Driven entirely by the
// GameEvent list stepGame produces, so game.ts never learns that any of this
// exists -- which is also why none of it can change the outcome of a round.
//
// Math.random() is fine here in a way it wouldn't be in game.ts: a spark's
// scatter is decoration, not a rule, so nothing in spec/ needs it to be
// reproducible.

import type { GameEvent, Vec2 } from "./game.ts";

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
  radius: number;
  color: string;
  /** Per-second velocity retention -- lower means it stops sooner. */
  drag: number;
}

export interface FloatingNumber {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  size: number;
}

export interface FxState {
  particles: Particle[];
  numbers: FloatingNumber[];
  /** Current screen-shake amplitude in pixels; decays on its own. */
  shake: number;
  /** Full-screen flash strength, 0-1. */
  flash: number;
  flashColor: string;
}

// A hard ceiling so a long combo streak can't grow the particle list without
// bound -- oldest sparks are dropped first, which is invisible in practice
// because they're also the faintest.
const MAX_PARTICLES = 420;
const MAX_NUMBERS = 40;

const SPORE = "#c8ff6e";
const MINT = "#7cf2c0";
const CRYSTAL = "#8ad9ff";
const DANGER = "#ff2d4d";
const EMBER = "#ffb347";
const GOLD = "#ffe066";

export function createFxState(): FxState {
  return { particles: [], numbers: [], shake: 0, flash: 0, flashColor: DANGER };
}

/** Wipes every effect -- called on restart so sparks don't survive the round that made them. */
export function resetFx(fx: FxState): void {
  fx.particles.length = 0;
  fx.numbers.length = 0;
  fx.shake = 0;
  fx.flash = 0;
}

function burst(
  fx: FxState,
  pos: Vec2,
  count: number,
  opts: { speed: number; life: number; radius: number; color: string; drag?: number },
): void {
  for (let i = 0; i < count; i++) {
    // Angle is jittered off an even spoke rather than fully random, so a
    // burst reads as radial instead of clumping on one side by chance.
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.9;
    const speed = opts.speed * (0.45 + Math.random() * 0.75);
    const life = opts.life * (0.6 + Math.random() * 0.7);
    fx.particles.push({
      pos: { x: pos.x, y: pos.y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      life,
      maxLife: life,
      radius: opts.radius * (0.5 + Math.random()),
      color: opts.color,
      drag: opts.drag ?? 0.08,
    });
  }
  if (fx.particles.length > MAX_PARTICLES) {
    fx.particles.splice(0, fx.particles.length - MAX_PARTICLES);
  }
}

function popNumber(fx: FxState, pos: Vec2, text: string, color: string, size: number): void {
  fx.numbers.push({
    pos: { x: pos.x, y: pos.y },
    vel: { x: (Math.random() - 0.5) * 18, y: -46 },
    life: 0.85,
    maxLife: 0.85,
    text,
    color,
    size,
  });
  if (fx.numbers.length > MAX_NUMBERS) {
    fx.numbers.splice(0, fx.numbers.length - MAX_NUMBERS);
  }
}

function flash(fx: FxState, strength: number, color: string): void {
  // Strongest flash wins rather than accumulating -- two events on one frame
  // shouldn't white out the screen.
  if (strength <= fx.flash) return;
  fx.flash = strength;
  fx.flashColor = color;
}

/**
 * Turns one frame's game events into things to look at. Shake and flash take
 * the max rather than the sum for the same reason: several events landing
 * together should read as one big hit, not as a seizure.
 */
export function emitFx(fx: FxState, events: readonly GameEvent[]): void {
  for (const e of events) {
    switch (e.kind) {
      case "eat": {
        // Bursts get slightly hotter and faster deep into a chain, so the
        // screen escalates alongside the multiplier.
        const heat = Math.min(1, e.combo / 10);
        burst(fx, e.pos, 7, {
          speed: 60 + heat * 90,
          life: 0.4,
          radius: 2 + heat * 1.6,
          color: heat > 0.55 ? GOLD : SPORE,
        });
        popNumber(fx, e.pos, `+${e.points}`, heat > 0.55 ? GOLD : SPORE, 12 + heat * 7);
        break;
      }
      case "crush": {
        burst(fx, e.pos, 22, {
          speed: 150,
          life: 0.7,
          radius: 2.5 + e.radius * 0.06,
          color: EMBER,
        });
        burst(fx, e.pos, 10, { speed: 90, life: 0.5, radius: 3, color: MINT });
        popNumber(fx, e.pos, `+${e.points}`, GOLD, 22);
        fx.shake = Math.max(fx.shake, 5 + e.radius * 0.22);
        flash(fx, 0.14, EMBER);
        break;
      }
      case "powerup":
        burst(fx, e.pos, 16, { speed: 110, life: 0.6, radius: 2.5, color: CRYSTAL });
        flash(fx, 0.1, CRYSTAL);
        break;
      case "spawn":
        burst(fx, e.pos, 20, { speed: 130, life: 0.8, radius: 3.5, color: DANGER });
        fx.shake = Math.max(fx.shake, 9);
        flash(fx, 0.2, DANGER);
        break;
      case "death":
        burst(fx, e.pos, 34, {
          speed: 210,
          life: 1.1,
          radius: 3 + e.radius * 0.09,
          color: DANGER,
          drag: 0.05,
        });
        fx.shake = Math.max(fx.shake, 26);
        flash(fx, 0.5, DANGER);
        break;
      case "win":
        burst(fx, e.pos, 46, { speed: 240, life: 1.3, radius: 3.5, color: MINT, drag: 0.04 });
        burst(fx, e.pos, 24, { speed: 150, life: 1.1, radius: 3, color: GOLD, drag: 0.04 });
        fx.shake = Math.max(fx.shake, 12);
        flash(fx, 0.34, MINT);
        break;
    }
  }
}

/** Advances every live effect and retires the finished ones. */
export function stepFx(fx: FxState, dt: number): void {
  for (let i = fx.particles.length - 1; i >= 0; i--) {
    const p = fx.particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      fx.particles.splice(i, 1);
      continue;
    }
    // Frame-rate-independent exponential drag: the same decay per second
    // whether the browser is serving 30fps or 144.
    const keep = Math.pow(p.drag, dt);
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.vel.x *= keep;
    p.vel.y *= keep;
  }

  for (let i = fx.numbers.length - 1; i >= 0; i--) {
    const n = fx.numbers[i];
    n.life -= dt;
    if (n.life <= 0) {
      fx.numbers.splice(i, 1);
      continue;
    }
    n.pos.x += n.vel.x * dt;
    n.pos.y += n.vel.y * dt;
    n.vel.y += 42 * dt; // arcs over and settles rather than rising forever
  }

  fx.shake *= Math.pow(0.0008, dt);
  if (fx.shake < 0.2) fx.shake = 0;
  fx.flash *= Math.pow(0.0015, dt);
  if (fx.flash < 0.004) fx.flash = 0;
}
