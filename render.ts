// Canvas drawing only -- no game rules live here, so nothing in this file
// needs a test. game.ts decides what happened; this just paints it.

import {
  chaseThreatDistance,
  comboMultiplier,
  COMBO_WINDOW_S,
  CRUSH_RATIO,
  FOOD_RADIUS,
  INVINCIBLE_DURATION,
  isOutsideSafeZone,
  MAGNET_DURATION,
  safeZoneRadius,
  TIME_LIMIT_S,
  WIN_RADIUS,
  type GameState,
  type Predator,
} from "./game.ts";
import type { FxState } from "./fx.ts";

/**
 * The bits of the HUD that aren't the game's business: a personal best lives
 * in localStorage and the mute flag lives in the audio graph, so both are
 * handed in by main.ts rather than stored on GameState.
 */
export interface HudInfo {
  best: number;
  newBest: boolean;
  muted: boolean;
}

// Digits only, monospaced: the end screen deliberately has no words (see
// drawEndOverlay), and numerals are the one readout that needs no
// translation. Monospace also stops a rising score from jittering its own
// layout as digit widths change.
const NUMERIC_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const PLAYER_COLOR = "#7cf2c0";
const FOOD_COLOR = "#c8ff6e";
const DANGER_COLOR = "#ff2d4d";
// Reserved for score achievement -- a hot combo, a live score past your
// record, a new best on the end screen. Kept distinct from every diegetic
// colour so "you are doing well" never reads as "that is a thing in the
// swamp".
const GOLD_COLOR = "#ffe066";
// Reserved for the magnet power-up's abstract ability glyph -- not a
// diegetic swamp element, so it keeps its own cool, magical tone rather than
// following the bioluminescent-spore palette everything else uses.
const CRYSTAL_COLOR = "#8ad9ff";
// The primordial-swamp glow color: vine-tip spores, food, anything meant to
// read as bioluminescent plant life rather than mineral or magic.
const SPORE_COLOR = "#c8ff6e";

// Two entries -- one per remaining static hazard tier (dragonfly, then
// spiky seed-pod). Tier 2's old slot was retired when the predator took
// over that danger tier.
const HAZARD_GRADIENTS: [string, string][] = [
  ["#d7ff8a", "#4a6b12"],
  ["#ffb37a", "#7a3d10"],
];

const PREDATOR_STATE_STYLE: Record<"patrol" | "chase" | "search", { color: string; glow: string | null }> = {
  patrol: { color: "#5c8a5a", glow: null },
  search: { color: "#e0a840", glow: "#e0a840" },
  chase: { color: "#ff3b30", glow: "#ff3b30" },
};

// Deterministic in [0,1) from a seed -- used everywhere a shape needs to
// look hand-carved (jagged rock edges, scattered fern blades, crystal
// clusters) without literally being random, since anything seeded from
// Math.random() would jitter every frame instead of holding still.
function seededRand(seed: number): number {
  const x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

function localToWorld(cx: number, cy: number, angle: number, pts: [number, number][]): [number, number][] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(([lx, ly]): [number, number] => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
}

function pathFromPoints(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function crystalShardPoints(r: number): [number, number][] {
  return [
    [0, -r],
    [r * 0.4, -r * 0.35],
    [r * 0.55, r * 0.15],
    [0, r],
    [-r * 0.55, r * 0.15],
    [-r * 0.4, -r * 0.35],
  ];
}

function pathStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, innerR: number, points: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI * i) / points;
    const x = cx + Math.cos(angle) * rad;
    const y = cy + Math.sin(angle) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// A giant dragonfly: slender body plus two elongated, swept wing pairs --
// stands in for the old bat now that tier 0 reads as swamp insect life
// rather than cave fauna.
function pathDragonfly(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const pts: [number, number][] = [
    [0, -r * 1.1],
    [r * 0.18, -r * 0.3],
    [r * 1.15, -r * 0.65],
    [r * 0.3, r * 0.05],
    [r * 0.95, r * 0.75],
    [0, r * 0.35],
    [0, r * 1.1],
    [-r * 0.95, r * 0.75],
    [-r * 0.3, r * 0.05],
    [-r * 1.15, -r * 0.65],
    [-r * 0.18, -r * 0.3],
  ];
  pathFromPoints(ctx, pts.map(([x, y]): [number, number] => [cx + x, cy + y]));
}

// An elongated crocodilian silhouette -- long snout forward, tapering tail
// behind -- replacing the old fish/diamond shape for the swamp predator.
function predatorLocalPoints(r: number): [number, number][] {
  return [
    [r * 1.6, 0],
    [r * 0.9, r * 0.3],
    [r * 0.3, r * 0.42],
    [-r * 0.6, r * 0.3],
    [-r * 1.5, r * 0.12],
    [-r * 1.5, -r * 0.12],
    [-r * 0.6, -r * 0.3],
    [r * 0.3, -r * 0.42],
    [r * 0.9, -r * 0.3],
  ];
}

// A CanvasGradient is cheap to reuse but not free to build, and the
// background one spans the whole viewport -- cache it and only rebuild when
// the canvas size actually changes (effectively: on window resize).
let bgGradient: CanvasGradient | null = null;
let bgGradientW = -1;
let bgGradientH = -1;

function getBackgroundGradient(ctx: CanvasRenderingContext2D, width: number, height: number): CanvasGradient {
  if (bgGradient && bgGradientW === width && bgGradientH === height) return bgGradient;
  const g = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
  g.addColorStop(0, "#1c3324");
  g.addColorStop(1, "#030907");
  bgGradient = g;
  bgGradientW = width;
  bgGradientH = height;
  return g;
}

// The shrinking safe zone, drawn as ground rather than fog: a translucent
// murky tint outside the boundary (rect-minus-circle via evenodd fill --
// paints nothing once the zone still covers the whole map, so no branching
// is needed for the early part of a round) plus a pulsing dashed ring so the
// boundary itself is easy to read at a glance.
function drawSafeZone(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  const { width, height } = state;
  const cx = width / 2;
  const cy = height / 2;
  const r = safeZoneRadius(width, height, TIME_LIMIT_S - state.timeLeft);

  // While the zone still reaches every corner it has nothing to tint, but the
  // evenodd fill below was still rasterizing a full-screen path to paint
  // nothing -- which is the entire first third of every round.
  const coversMap = r >= Math.hypot(width, height) / 2;
  if (!coversMap) {
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,45,15,0.55)";
    ctx.fill("evenodd");
  }

  const pulse = 0.5 + Math.sin(clockSeconds * 2) * 0.15;
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = `rgba(140,220,90,${pulse})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  fx: FxState,
  hud: HudInfo,
  clockSeconds: number,
): void {
  const { width, height } = state;
  // No clearRect: the background gradient below is fully opaque and covers
  // the whole canvas, so clearing first was a second full-screen write per
  // frame for no visible effect. At a 1.5x backing store on a 1080p window
  // that alone is ~4.7M redundant pixel writes every frame.
  ctx.fillStyle = getBackgroundGradient(ctx, width, height);
  ctx.fillRect(0, 0, width, height);

  const pulse = 1 + Math.sin(clockSeconds * 6) * 0.06;

  // Only the world shakes. Letting the HUD ride along would make the score
  // and timer unreadable at exactly the moments they matter most.
  ctx.save();
  if (fx.shake > 0) {
    ctx.translate((Math.random() - 0.5) * 2 * fx.shake, (Math.random() - 0.5) * 2 * fx.shake);
  }

  drawSafeZone(ctx, state, clockSeconds);
  drawGrass(ctx, state, clockSeconds);
  drawWalls(ctx, state, clockSeconds);
  drawFood(ctx, state);
  drawPowerUps(ctx, state, clockSeconds);

  for (const hazard of state.hazards) {
    drawHazard(ctx, state, hazard, pulse);
  }
  for (const predator of state.predators) {
    drawPredator(ctx, state, predator, pulse);
  }

  drawPlayer(ctx, state, isOutsideSafeZone(state));
  drawParticles(ctx, fx);
  ctx.restore();

  drawThreatVignette(ctx, state, clockSeconds);
  drawFlash(ctx, fx, width, height);
  // Floating numbers sit above the vignette so a score never gets dimmed by
  // the thing that made it exciting to earn.
  drawFloatingNumbers(ctx, fx);

  drawGrowthMeter(ctx, state);
  drawTimer(ctx, state);
  drawScore(ctx, state, hud, clockSeconds);
  drawComboMeter(ctx, state);
  drawBuffBadge(ctx, state.invincibleTimeLeft, INVINCIBLE_DURATION, 0, PLAYER_COLOR);
  drawBuffBadge(ctx, state.magnetTimeLeft, MAGNET_DURATION, 1, CRYSTAL_COLOR);
  drawMuteGlyph(ctx, state, hud);

  if (state.status !== "playing") {
    drawEndOverlay(ctx, state, hud, pulse);
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, fx: FxState): void {
  for (const p of fx.particles) {
    const t = p.life / p.maxLife;
    ctx.globalAlpha = Math.min(1, t * 1.5);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.radius * (0.35 + t * 0.65), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFloatingNumbers(ctx: CanvasRenderingContext2D, fx: FxState): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of fx.numbers) {
    const t = n.life / n.maxLife;
    ctx.globalAlpha = Math.min(1, t * 1.8);
    ctx.font = `700 ${n.size}px ${NUMERIC_FONT}`;
    // A dark outline instead of a glow. These are the most numerous blurred
    // draws in the game (one per number, dozens mid-combo) and strokeText
    // costs a fraction of a blur layer while reading better over bright
    // particle bursts.
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(4,12,8,0.7)";
    ctx.strokeText(n.text, n.pos.x, n.pos.y);
    ctx.fillStyle = n.color;
    ctx.fillText(n.text, n.pos.x, n.pos.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * Reddens the edges of the screen as danger closes in. Presence was already
 * legible (a chasing predator glows red); what was missing was *proximity* --
 * this makes the last second before the jaws feel different from the first,
 * and it doubles as the warning for the two threats that have no sprite at
 * all: the clock, and standing outside the safe zone.
 */
let vignetteGradient: CanvasGradient | null = null;
let vignetteW = -1;
let vignetteH = -1;

function drawThreatVignette(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  if (state.status !== "playing") return;
  const { width, height } = state;
  const gap = chaseThreatDistance(state);
  const proximity = Number.isFinite(gap) ? Math.max(0, 1 - gap / 300) : 0;
  const clock = state.timeLeft < 10 ? (10 - state.timeLeft) / 10 : 0;
  const zone = isOutsideSafeZone(state) ? 0.85 : 0;
  // Max, not sum: three dangers at once is still one screen's worth of red.
  const intensity = Math.min(0.9, Math.max(proximity * proximity, clock * 0.75, zone));
  if (intensity < 0.02) return;

  // Built at full strength once per canvas size and modulated with
  // globalAlpha, rather than rebuilt every frame just to change one stop's
  // opacity -- this is a full-screen fill, so it was never cheap.
  const pulse = 0.86 + Math.sin(clockSeconds * 7) * 0.14;
  if (!vignetteGradient || vignetteW !== width || vignetteH !== height) {
    vignetteGradient = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.3,
      width / 2,
      height / 2,
      Math.hypot(width, height) / 2,
    );
    vignetteGradient.addColorStop(0, "rgba(255,45,77,0)");
    vignetteGradient.addColorStop(1, "rgba(255,45,77,1)");
    vignetteW = width;
    vignetteH = height;
  }
  ctx.globalAlpha = Math.min(1, intensity * 0.6 * pulse);
  ctx.fillStyle = vignetteGradient;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
}

function drawFlash(ctx: CanvasRenderingContext2D, fx: FxState, width: number, height: number): void {
  if (fx.flash <= 0) return;
  ctx.globalAlpha = fx.flash;
  ctx.fillStyle = fx.flashColor;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// shadowBlur/shadowColor are persistent context state -- they leak onto
// whatever's drawn next unless reset immediately after the call that wants
// them, so every glow below is set right before its fill/stroke and cleared
// right after. Reserved for the small, bounded entity counts (player,
// hazards, predator, power-ups, the gate-gap crystal clusters, the timer
// arc); the ~30 food shards get their glow via a gradient that fades to
// transparent instead, since a real shadowBlur pass on that many shapes
// every frame isn't worth the cost.

// A jagged silhouette around a boulder's circle, offset deterministically
// from its own position -- never Math.random(), or the rock face would
// jitter every frame instead of holding still like actual stone.
function boulderRockPath(ctx: CanvasRenderingContext2D, wall: GameState["walls"][number]): void {
  const { x, y } = wall.pos;
  const r = wall.radius;
  const sides = 10;
  const amp = r * 0.22;
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides;
    const jag = (seededRand(x * 0.31 + y * 0.17 + i * 3.1) - 0.5) * 2 * amp;
    const rr = r + jag;
    const px = x + Math.cos(angle) * rr;
    const py = y + Math.sin(angle) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// Every `shadowBlur` draw makes Skia allocate an offscreen layer, run a
// multi-pass gaussian over it and composite the result -- the per-call setup
// dominates, so the cost is about how *many* you do, not how big they are.
// The scene was issuing 15-25 a frame (up to 8 hazards, both predators, the
// player, the HUD, and one per floating score number, which alone can hit 40
// mid-combo). These stamp a pre-rendered radial glow instead: one cached
// sprite per colour, then a plain blit.
const GLOW_SPRITE_R = 32;
const glowSprites = new Map<string, HTMLCanvasElement>();

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getGlowSprite(color: string): HTMLCanvasElement {
  const cached = glowSprites.get(color);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_R * 2;
  canvas.height = GLOW_SPRITE_R * 2;
  const gctx = canvas.getContext("2d")!;
  const g = gctx.createRadialGradient(
    GLOW_SPRITE_R,
    GLOW_SPRITE_R,
    0,
    GLOW_SPRITE_R,
    GLOW_SPRITE_R,
    GLOW_SPRITE_R,
  );
  g.addColorStop(0, withAlpha(color, 0.62));
  g.addColorStop(0.4, withAlpha(color, 0.3));
  g.addColorStop(1, withAlpha(color, 0));
  gctx.fillStyle = g;
  gctx.fillRect(0, 0, GLOW_SPRITE_R * 2, GLOW_SPRITE_R * 2);
  glowSprites.set(color, canvas);
  return canvas;
}

/** Stamps a soft halo of `color` centred on (x, y), reaching out to `radius`. */
function stampGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number): void {
  ctx.drawImage(getGlowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
}

// A glowing spore tip, drawn once into a tiny canvas and stamped wherever one
// is needed. The sprite is drawn larger than the solid core so it carries the
// falloff the old shadowBlur provided -- hence the scale factor callers apply.
const SPORE_SPRITE_SCALE = 3.2;
let sporeSprite: HTMLCanvasElement | null = null;

function getSporeSprite(): HTMLCanvasElement {
  if (sporeSprite) return sporeSprite;
  const r = 24;
  const canvas = document.createElement("canvas");
  canvas.width = r * 2;
  canvas.height = r * 2;
  const sctx = canvas.getContext("2d")!;
  const g = sctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, "#f2ffd4");
  g.addColorStop(0.28, SPORE_COLOR);
  g.addColorStop(1, "rgba(200,255,110,0)");
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, r * 2, r * 2);
  sporeSprite = canvas;
  return canvas;
}

// A small tangle of curling vine strands reaching from a gap's rock edge into
// the opening -- replaces a flat, two-line-bounded gap marker with something
// that reads as overgrown and irregular. `angle` points from the edge into
// the gap (so vines from the two boulders bounding a gap curl toward each
// other); `spread` is how far along the perpendicular the strands' start
// points scatter. Glowing spore tips keep the bioluminescent language of the
// rest of the swamp without the shape reading as a crystal cluster.
function drawGapVines(
  ctx: CanvasRenderingContext2D,
  ex: number,
  ey: number,
  angle: number,
  spread: number,
  seedBase: number,
  clockSeconds: number,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const seed = seedBase + i * 7.3;
    const along = (seededRand(seed) - 0.5) * spread * 1.8;
    const startX = ex + px * along;
    const startY = ey + py * along;
    const reach = 10 + seededRand(seed + 1) * 14;
    const sway = Math.sin(clockSeconds * 1.3 + seed) * 4;
    const midJitter = (seededRand(seed + 2) - 0.5) * 18;
    const endJitter = (seededRand(seed + 3) - 0.5) * 24;
    const midX = startX + dx * reach * 0.55 + px * (sway + midJitter);
    const midY = startY + dy * reach * 0.55 + py * (sway + midJitter);
    const endX = startX + dx * reach + px * (sway * 0.6 + endJitter);
    const endY = startY + dy * reach + py * (sway * 0.6 + endJitter);

    ctx.strokeStyle = `rgba(110,170,90,${0.5 + seededRand(seed + 4) * 0.3})`;
    ctx.lineWidth = 1.5 + seededRand(seed + 5) * 1.5;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(midX, midY, endX, endY);
    ctx.stroke();

    // Was a shadowBlur'd arc. With one or two gaps per cluster and four
    // strands on each side of every gap, that came to ~100 full gaussian
    // blur passes a frame -- the single most expensive thing in the scene.
    // A pre-rendered glow sprite is the same picture for the cost of a blit.
    const tip = getSporeSprite();
    const tipR = (2 + seededRand(seed + 6) * 1.5) * SPORE_SPRITE_SCALE;
    ctx.drawImage(tip, endX - tipR, endY - tipR, tipR * 2, tipR * 2);
  }
  ctx.lineCap = "butt";
}

// Deliberately NOT cached into an offscreen layer, despite the boulders being
// static for the whole round. That was tried and measured worse: ~105
// boulders of radius 9-15 cover roughly 100k device pixels between them,
// while blitting a prebaked full-canvas layer costs a 4.7M-pixel alpha
// composite -- about 44x more pixels than the thing it was avoiding. Caching
// static geometry only pays when the geometry covers most of the screen.
function drawWalls(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  for (const wall of state.walls) {
    const g = ctx.createRadialGradient(
      wall.pos.x - wall.radius * 0.3,
      wall.pos.y - wall.radius * 0.3,
      0,
      wall.pos.x,
      wall.pos.y,
      wall.radius * 1.3,
    );
    g.addColorStop(0, "#5c6e46");
    g.addColorStop(1, "#12180d");
    ctx.fillStyle = g;
    boulderRockPath(ctx, wall);
    ctx.fill();

    ctx.strokeStyle = "rgba(170,200,120,0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Mark every real gap in each cluster with a tangle of vines -- derived
  // straight from the boulders' own positions, no extra state -- so each
  // opening reads at a glance. Grouped by clusterId and walked in path
  // order (pathIndex), not raw x/y: a cluster's path can now curve, zigzag,
  // or loop, so sorting by position no longer finds true neighbours.
  // Consecutive boulders sit close together by construction, so a much
  // bigger separation than normal placement jitter is a real gap. Closed
  // ("blob" ring) clusters also check the wrap-around pair (last back to
  // first); open clusters' first/last boulders are the two unconnected
  // ends, not a gap, so that pair is skipped for them.
  const byCluster = new Map<number, typeof state.walls>();
  for (const wall of state.walls) {
    const cluster = byCluster.get(wall.clusterId) ?? [];
    cluster.push(wall);
    byCluster.set(wall.clusterId, cluster);
  }
  for (const segments of byCluster.values()) {
    if (segments.length < 2) continue;
    const sorted = [...segments].sort((a, b) => a.pathIndex - b.pathIndex);
    const pairs: [(typeof sorted)[number], (typeof sorted)[number]][] = [];
    for (let i = 0; i < sorted.length - 1; i++) pairs.push([sorted[i], sorted[i + 1]]);
    if (sorted[0].closed) pairs.push([sorted[sorted.length - 1], sorted[0]]);

    for (const [a, b] of pairs) {
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const centerDist = Math.hypot(dx, dy);
      const gapDist = centerDist - a.radius - b.radius;
      if (gapDist < 24) continue;
      const angle = Math.atan2(dy, dx);
      const spread = Math.max(a.radius, b.radius) + 10;
      const seedA = a.pos.x * 0.7 + a.pos.y * 0.31;
      const seedB = b.pos.x * 0.7 + b.pos.y * 0.31;
      drawGapVines(ctx, a.pos.x + Math.cos(angle) * a.radius, a.pos.y + Math.sin(angle) * a.radius, angle, spread, seedA, clockSeconds);
      drawGapVines(ctx, b.pos.x - Math.cos(angle) * b.radius, b.pos.y - Math.sin(angle) * b.radius, angle + Math.PI, spread, seedB, clockSeconds);
    }
  }
}

// Every pellet shares one radius, so it can share one gradient too -- built
// at the origin and moved under the context rather than rebuilt 30 times a
// frame at each pellet's coordinates.
let foodGradient: CanvasGradient | null = null;

function drawFood(ctx: CanvasRenderingContext2D, state: GameState): void {
  const r = FOOD_RADIUS * 1.8;
  if (!foodGradient) {
    foodGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    foodGradient.addColorStop(0, "#f5ffd0");
    foodGradient.addColorStop(0.5, FOOD_COLOR);
    foodGradient.addColorStop(1, "rgba(200,255,110,0)");
  }
  ctx.fillStyle = foodGradient;
  for (const food of state.food) {
    const rotation = seededRand(food.pos.x * 0.11 + food.pos.y * 0.07) * Math.PI * 2;
    ctx.save();
    ctx.translate(food.pos.x, food.pos.y);
    pathFromPoints(ctx, localToWorld(0, 0, rotation, crystalShardPoints(r)));
    ctx.fill();
    ctx.restore();
  }
}

function drawHazard(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  hazard: GameState["hazards"][number],
  pulse: number,
): void {
  const crushable = state.player.radius >= hazard.radius * CRUSH_RATIO;
  const r = crushable ? hazard.radius * pulse : hazard.radius;
  const [core, rim] = HAZARD_GRADIENTS[hazard.tier];

  ctx.globalAlpha = crushable ? 0.85 : 1;
  const g = ctx.createRadialGradient(
    hazard.pos.x - r * 0.3,
    hazard.pos.y - r * 0.3,
    0,
    hazard.pos.x,
    hazard.pos.y,
    r,
  );
  g.addColorStop(0, core);
  g.addColorStop(1, rim);
  ctx.fillStyle = g;

  if (!crushable) stampGlow(ctx, DANGER_COLOR, hazard.pos.x, hazard.pos.y, r * 2.1);
  ctx.fillStyle = g;
  if (hazard.tier === 0) {
    pathDragonfly(ctx, hazard.pos.x, hazard.pos.y, r);
  } else {
    pathStar(ctx, hazard.pos.x, hazard.pos.y, r * 1.1, r * 0.5, 9);
  }
  ctx.fill();
  ctx.globalAlpha = 1;

  if (crushable) {
    ctx.strokeStyle = "rgba(126,255,190,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(hazard.pos.x, hazard.pos.y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPredator(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  predator: Predator,
  pulse: number,
): void {
  const crushable = state.player.radius >= predator.radius * CRUSH_RATIO;
  const r = crushable ? predator.radius * pulse : predator.radius;
  const style = PREDATOR_STATE_STYLE[predator.state];
  const target =
    predator.state === "chase"
      ? state.player.pos
      : predator.state === "search"
        ? predator.lastKnownPlayerPos
        : predator.patrolTarget;
  const angle = Math.atan2(target.y - predator.pos.y, target.x - predator.pos.x);

  ctx.globalAlpha = crushable ? 0.85 : 1;
  const g = ctx.createRadialGradient(
    predator.pos.x - r * 0.3,
    predator.pos.y - r * 0.3,
    0,
    predator.pos.x,
    predator.pos.y,
    r * 1.4,
  );
  g.addColorStop(0, "#dff5d8");
  g.addColorStop(0.5, style.color);
  g.addColorStop(1, "#141d10");
  ctx.fillStyle = g;

  if (!crushable && style.glow) {
    stampGlow(ctx, style.glow, predator.pos.x, predator.pos.y, r * (predator.state === "chase" ? 2.3 : 1.9));
    ctx.fillStyle = g;
  }
  pathFromPoints(ctx, localToWorld(predator.pos.x, predator.pos.y, angle, predatorLocalPoints(r)));
  ctx.fill();
  ctx.globalAlpha = 1;

  if (crushable) {
    ctx.strokeStyle = "rgba(126,255,190,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(predator.pos.x, predator.pos.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGrass(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  for (let gi = 0; gi < state.grass.length; gi++) {
    const { pos, radius } = state.grass[gi];

    const fill = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
    fill.addColorStop(0, "rgba(60,100,50,0.28)");
    fill.addColorStop(1, "rgba(60,100,50,0)");
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, radius, radius * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(150,200,120,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, radius, radius * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const blades = 14;
    ctx.strokeStyle = "rgba(110,170,90,0.6)";
    ctx.lineWidth = 3;
    for (let i = 0; i < blades; i++) {
      const seed = gi * 13.7 + i * 4.1;
      const angle = (Math.PI * 2 * i) / blades + seededRand(seed) * 0.6;
      const bx = pos.x + Math.cos(angle) * radius * 0.75 * seededRand(seed + 1);
      const by = pos.y + Math.sin(angle) * radius * 0.55 * seededRand(seed + 2);
      const sway = Math.sin(clockSeconds * 2 + gi + i) * 6;
      const bladeH = 22 + seededRand(seed + 3) * 18;

      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + sway * 0.5, by - bladeH * 0.6, bx + sway, by - bladeH);
      ctx.stroke();
    }
  }
}

function drawShieldGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.fillStyle = PLAYER_COLOR;
  ctx.shadowColor = PLAYER_COLOR;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r, cy - r * 0.6, cx + r, cy);
  ctx.quadraticCurveTo(cx + r, cy + r * 0.9, cx, cy + r * 1.3);
  ctx.quadraticCurveTo(cx - r, cy + r * 0.9, cx - r, cy);
  ctx.quadraticCurveTo(cx - r, cy - r * 0.6, cx, cy - r);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawMagnetGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.strokeStyle = CRYSTAL_COLOR;
  ctx.shadowColor = CRYSTAL_COLOR;
  ctx.shadowBlur = 12;
  ctx.lineWidth = Math.max(2, r * 0.35);
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.1, r * 0.75, Math.PI * 0.15, Math.PI * 0.85, false);
  ctx.moveTo(cx - r * 0.75, cy + r * 0.1);
  ctx.lineTo(cx - r * 0.75, cy - r * 0.5);
  ctx.moveTo(cx + r * 0.75, cy + r * 0.1);
  ctx.lineTo(cx + r * 0.75, cy - r * 0.5);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawPowerUps(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  const pulse = 1 + Math.sin(clockSeconds * 5) * 0.15;
  for (const p of state.powerUps) {
    if (p.kind === "invincible") drawShieldGlyph(ctx, p.pos.x, p.pos.y, p.radius * pulse);
    else drawMagnetGlyph(ctx, p.pos.x, p.pos.y, p.radius * pulse);
  }
}

function drawBuffBadge(
  ctx: CanvasRenderingContext2D,
  timeLeft: number,
  duration: number,
  slot: number,
  color: string,
): void {
  if (timeLeft <= 0) return;
  const cx = 32 + slot * 36;
  // Sits below the combo meter: the left column reads top-to-bottom as one
  // group -- how big you are, how hot your chain is, what's buffing you.
  const cy = 84;
  const r = 12;
  ctx.strokeStyle = "rgba(18,59,69,0.4)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  const pct = timeLeft / duration;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState, inDanger: boolean): void {
  const { pos, radius } = state.player;
  const glowColor = inDanger ? DANGER_COLOR : PLAYER_COLOR;
  const g = ctx.createRadialGradient(
    pos.x - radius * 0.3,
    pos.y - radius * 0.3,
    0,
    pos.x,
    pos.y,
    radius,
  );
  g.addColorStop(0, inDanger ? "#fff0e8" : "#e8fff5");
  g.addColorStop(0.55, glowColor);
  g.addColorStop(1, inDanger ? "#5a1a12" : "#1a6e54");
  stampGlow(ctx, glowColor, pos.x, pos.y, radius * 2.4);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrowthMeter(ctx: CanvasRenderingContext2D, state: GameState): void {
  const w = 140;
  const h = 8;
  const x = 20;
  const y = 20;
  ctx.fillStyle = "rgba(18,59,69,0.35)";
  ctx.fillRect(x, y, w, h);

  const pct = Math.min(1, state.player.radius / WIN_RADIUS);
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, PLAYER_COLOR);
  g.addColorStop(1, "#e8fff5");
  ctx.fillStyle = g;
  ctx.shadowColor = PLAYER_COLOR;
  ctx.shadowBlur = 6;
  ctx.fillRect(x, y, w * pct, h);
  ctx.shadowBlur = 0;

  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

// A star, not the word "best" -- see drawEndOverlay on why this HUD stays
// wordless. Returns the width it drew so callers can centre star+number as
// one group.
function drawBestBadge(
  ctx: CanvasRenderingContext2D,
  best: number,
  cx: number,
  cy: number,
  size: number,
  // The in-play HUD wants this quiet; the end screen has to stay readable on
  // top of a win burst, so it passes a solid colour and a glow.
  color = "rgba(232,255,245,0.5)",
  glow = false,
): void {
  if (best <= 0) return;
  const label = String(best);
  ctx.font = `600 ${size}px ${NUMERIC_FONT}`;
  const starR = size * 0.42;
  const groupWidth = starR * 2 + 6 + ctx.measureText(label).width;
  const left = cx - groupWidth / 2;

  ctx.fillStyle = color;
  if (glow) {
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 8;
  }
  pathStar(ctx, left + starR, cy, starR, starR * 0.45, 5);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + starR * 2 + 6, cy);
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawScore(ctx: CanvasRenderingContext2D, state: GameState, hud: HudInfo, clockSeconds: number): void {
  const cx = state.width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Passing your own record mid-round is the moment worth selling, so the
  // live score goes gold the instant it happens rather than waiting for the
  // end screen to tell you.
  const beating = hud.best > 0 && state.score > hud.best;
  const color = beating ? GOLD_COLOR : "#e8fff5";
  ctx.font = `700 30px ${NUMERIC_FONT}`;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = beating ? 12 + Math.sin(clockSeconds * 6) * 6 : 8;
  ctx.fillText(String(state.score), cx, 34);
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  drawBestBadge(ctx, hud.best, cx, 60, 13);
}

// The chain's lapse timer, drawn where the eye already is for the growth
// meter. It reads as "spend this now" -- which is the whole point of the
// combo: it should make standing still feel expensive.
function drawComboMeter(ctx: CanvasRenderingContext2D, state: GameState): void {
  if (state.combo < 2 || state.comboTimeLeft <= 0) return;
  const x = 20;
  const w = 140;
  const heat = Math.min(1, (state.combo - 1) / 9);
  const color = heat > 0.55 ? GOLD_COLOR : PLAYER_COLOR;

  ctx.font = `700 14px ${NUMERIC_FONT}`;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.fillText(`×${comboMultiplier(state.combo).toFixed(2)}`, x, 52);
  ctx.shadowBlur = 0;

  const y = 60;
  ctx.fillStyle = "rgba(18,59,69,0.35)";
  ctx.fillRect(x, y, w, 4);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * (state.comboTimeLeft / COMBO_WINDOW_S), 4);
}

// A speaker in the corner, dim: the only hint that sound exists and that a
// key toggles it. Drawing it always (rather than only when muted) is what
// makes the mute discoverable at all.
function drawMuteGlyph(ctx: CanvasRenderingContext2D, state: GameState, hud: HudInfo): void {
  const x = state.width - 30;
  const y = state.height - 26;
  ctx.strokeStyle = hud.muted ? "rgba(255,45,77,0.55)" : "rgba(232,255,245,0.32)";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 1.6;

  ctx.beginPath();
  ctx.moveTo(x - 7, y - 3);
  ctx.lineTo(x - 3, y - 3);
  ctx.lineTo(x + 1, y - 7);
  ctx.lineTo(x + 1, y + 7);
  ctx.lineTo(x - 3, y + 3);
  ctx.lineTo(x - 7, y + 3);
  ctx.closePath();
  ctx.fill();

  if (hud.muted) {
    ctx.beginPath();
    ctx.moveTo(x + 4, y - 5);
    ctx.lineTo(x + 11, y + 5);
    ctx.moveTo(x + 11, y - 5);
    ctx.lineTo(x + 4, y + 5);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x + 2, y, 5, -Math.PI / 3, Math.PI / 3);
    ctx.moveTo(x + 8.5, y - 5);
    ctx.arc(x + 2, y, 8, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }
}

function drawTimer(ctx: CanvasRenderingContext2D, state: GameState): void {
  const cx = state.width - 34;
  const cy = 34;
  const r = 16;
  ctx.strokeStyle = "rgba(18,59,69,0.4)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const danger = state.timeLeft < 10;
  ctx.strokeStyle = danger ? DANGER_COLOR : PLAYER_COLOR;
  ctx.shadowColor = danger ? DANGER_COLOR : PLAYER_COLOR;
  ctx.shadowBlur = 8;
  const pct = state.timeLeft / TIME_LIMIT_S;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// Still no words on a loss or a win -- a play/replay glyph remains the only
// affordance, and tapping anywhere restarts. What's added is the round's
// score and your record, because an end screen that reports nothing gives a
// player no reason to go again and no way to tell a good run from a lucky
// one. Numerals and a star carry that without breaking the wordless rule:
// they need no translation and no reading.
function drawEndOverlay(ctx: CanvasRenderingContext2D, state: GameState, hud: HudInfo, pulse: number): void {
  const { width, height, status } = state;
  const won = status === "won";
  ctx.fillStyle = won ? "rgba(80,255,190,0.18)" : "rgba(255,45,77,0.22)";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const scoreColor = hud.newBest ? GOLD_COLOR : "#f4fffb";

  // A new record gets a pulsing ring rather than a "NEW BEST!" banner --
  // same signal, no language.
  if (hud.newBest) {
    ctx.strokeStyle = `rgba(255,224,102,${0.35 + Math.sin(pulse * 30) * 0.2})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy - 62, 62 * pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 46px ${NUMERIC_FONT}`;
  ctx.fillStyle = scoreColor;
  ctx.shadowColor = scoreColor;
  ctx.shadowBlur = 18;
  ctx.fillText(String(state.score), cx, cy - 62);
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  drawBestBadge(ctx, hud.best, cx, cy - 22, 16, "rgba(244,255,251,0.92)", true);

  const r = 30 * pulse;
  const glyphY = cy + 44;
  ctx.fillStyle = "#f4fffb";
  ctx.shadowColor = won ? PLAYER_COLOR : DANGER_COLOR;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, glyphY - r * 0.75);
  ctx.lineTo(cx - r * 0.5, glyphY + r * 0.75);
  ctx.lineTo(cx + r * 0.75, glyphY);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}
