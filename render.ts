// Canvas drawing only -- no game rules live here, so nothing in this file
// needs a test. game.ts decides what happened; this just paints it.

import {
  CRUSH_RATIO,
  INVINCIBLE_DURATION,
  MAGNET_DURATION,
  TIME_LIMIT_S,
  WIN_RADIUS,
  type GameState,
} from "./game.ts";

const PLAYER_COLOR = "#7cf2c0";
const FOOD_COLOR = "#ffe98a";
const DANGER_COLOR = "#ff2d4d";
const CRYSTAL_COLOR = "#8ad9ff";

// Two entries -- one per remaining static hazard tier (bat, then urchin).
// Tier 2's old slot was retired when the predator took over that danger tier.
const HAZARD_GRADIENTS: [string, string][] = [
  ["#ffd27a", "#a85e00"],
  ["#ff8f6b", "#8f2415"],
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

function pathBat(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const pts: [number, number][] = [
    [0, -r * 0.5],
    [r, -r * 0.1],
    [r * 0.35, r * 0.05],
    [r * 0.75, r * 0.55],
    [0, r * 0.35],
    [-r * 0.75, r * 0.55],
    [-r * 0.35, r * 0.05],
    [-r, -r * 0.1],
  ];
  pathFromPoints(ctx, pts.map(([x, y]): [number, number] => [cx + x, cy + y]));
}

function predatorLocalPoints(r: number): [number, number][] {
  return [
    [r * 1.3, 0],
    [r * 0.6, r * 0.35],
    [r * 0.1, r * 0.6],
    [-r * 1.1, r * 0.25],
    [-r * 1.1, -r * 0.25],
    [r * 0.1, -r * 0.6],
    [r * 0.6, -r * 0.35],
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
  g.addColorStop(0, "#2a2118");
  g.addColorStop(1, "#08060a");
  bgGradient = g;
  bgGradientW = width;
  bgGradientH = height;
  return g;
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  const { width, height } = state;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getBackgroundGradient(ctx, width, height);
  ctx.fillRect(0, 0, width, height);

  drawGrass(ctx, state, clockSeconds);
  drawWalls(ctx, state, clockSeconds);
  drawFood(ctx, state);
  drawPowerUps(ctx, state, clockSeconds);

  const pulse = 1 + Math.sin(clockSeconds * 6) * 0.06;
  for (const hazard of state.hazards) {
    drawHazard(ctx, state, hazard, pulse);
  }
  if (state.predator) {
    drawPredator(ctx, state, state.predator, pulse);
  }

  drawPlayer(ctx, state);
  drawGrowthMeter(ctx, state);
  drawTimer(ctx, state);
  drawBuffBadge(ctx, state.invincibleTimeLeft, INVINCIBLE_DURATION, 0, PLAYER_COLOR);
  drawBuffBadge(ctx, state.magnetTimeLeft, MAGNET_DURATION, 1, CRYSTAL_COLOR);

  if (state.status !== "playing") {
    drawEndOverlay(ctx, state, pulse);
  }
}

// shadowBlur/shadowColor are persistent context state -- they leak onto
// whatever's drawn next unless reset immediately after the call that wants
// them, so every glow below is set right before its fill/stroke and cleared
// right after. Reserved for the small, bounded entity counts (player,
// hazards, predator, power-ups, the gate-gap crystal clusters, the timer
// arc); the ~30 food shards get their glow via a gradient that fades to
// transparent instead, since a real shadowBlur pass on that many shapes
// every frame isn't worth the cost.

// A jagged silhouette along a wall's top and bottom edges, offset
// deterministically from its own x/y/w/h -- never Math.random(), or the rock
// face would jitter every frame instead of holding still like actual stone.
// The left/right (end) edges stay a clean straight cut: jagging them too
// reads fine when a cluster has exactly one far-apart gap, but once a
// cluster can hold a second, closer gap (see makeClusterSpan in game.ts),
// two jagged ends a short segment apart -- each already carrying its own
// vine cluster -- crowd into spiky, overlapping-looking clutter instead of
// an opening.
function rockRidgePath(ctx: CanvasRenderingContext2D, wall: GameState["walls"][number]): void {
  const { x, y, w, h } = wall;
  const ampH = 6;
  const nH = Math.max(2, Math.round(w / 16));
  const topJag = (i: number) => (seededRand(x * 0.17 + y * 0.31 + i * 2.7) - 0.5) * 2 * ampH;
  const botJag = (i: number) => (seededRand(x * 0.53 + y * 0.11 + i * 4.3 + 99) - 0.5) * 2 * ampH;

  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let i = 1; i <= nH; i++) ctx.lineTo(x + (w * i) / nH, y + topJag(i));
  ctx.lineTo(x + w, y + h);
  for (let i = nH - 1; i >= 0; i--) ctx.lineTo(x + (w * i) / nH, y + h + botJag(i));
  ctx.closePath();
}

// A small tangle of curling vine strands reaching from a gap's rock edge into
// the opening -- replaces a flat, two-line-bounded gap marker with something
// that reads as overgrown and irregular. `dir` is which way the strand curls:
// +1 for the edge on the gap's left (curling right), -1 for the right (curling
// left). Glowing berry tips keep the same crystal-glow language as the rest
// of the cave without the shape reading as another crystal cluster.
function drawGapVines(
  ctx: CanvasRenderingContext2D,
  ex: number,
  cy: number,
  halfHeight: number,
  dir: 1 | -1,
  seedBase: number,
  clockSeconds: number,
): void {
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const seed = seedBase + i * 7.3;
    const startY = cy + (seededRand(seed) - 0.5) * halfHeight * 1.8;
    const reach = (10 + seededRand(seed + 1) * 14) * dir;
    const sway = Math.sin(clockSeconds * 1.3 + seed) * 4;
    const midX = ex + reach * 0.55 + sway;
    const midY = startY + (seededRand(seed + 2) - 0.5) * 18;
    const endX = ex + reach + sway * 0.6;
    const endY = startY + (seededRand(seed + 3) - 0.5) * 24;

    ctx.strokeStyle = `rgba(110,170,90,${0.5 + seededRand(seed + 4) * 0.3})`;
    ctx.lineWidth = 1.5 + seededRand(seed + 5) * 1.5;
    ctx.beginPath();
    ctx.moveTo(ex, startY);
    ctx.quadraticCurveTo(midX, midY, endX, endY);
    ctx.stroke();

    ctx.fillStyle = CRYSTAL_COLOR;
    ctx.shadowColor = CRYSTAL_COLOR;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(endX, endY, 2 + seededRand(seed + 6) * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.lineCap = "butt";
}

function drawWalls(ctx: CanvasRenderingContext2D, state: GameState, clockSeconds: number): void {
  for (const wall of state.walls) {
    const g = ctx.createLinearGradient(0, wall.y, 0, wall.y + wall.h);
    g.addColorStop(0, "#4a3b2a");
    g.addColorStop(1, "#1a140d");
    ctx.fillStyle = g;
    rockRidgePath(ctx, wall);
    ctx.fill();

    ctx.strokeStyle = "rgba(200,160,110,0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Mark the inner edges of every gap in each cluster -- derived straight
  // from the wall rects, no extra state -- so each opening reads at a
  // glance. Grouped by clusterId rather than exact y: boulders within a
  // cluster are y-jittered so it reads as an uneven pile, not a straight
  // bar, so segments in the same cluster no longer share one y. A cluster
  // can hold more than one gap, so this walks consecutive segments left to
  // right instead of assuming exactly two, and each gap edge's vertical
  // center comes from that segment's own y/h rather than a shared row y.
  const byCluster = new Map<number, typeof state.walls>();
  for (const wall of state.walls) {
    const cluster = byCluster.get(wall.clusterId) ?? [];
    cluster.push(wall);
    byCluster.set(wall.clusterId, cluster);
  }
  for (const segments of byCluster.values()) {
    if (segments.length < 2) continue;
    const sorted = [...segments].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length - 1; i++) {
      const left = sorted[i];
      const right = sorted[i + 1];
      const leftCy = left.y + left.h / 2;
      const rightCy = right.y + right.h / 2;
      const halfHeight = left.h / 2 + 14;
      drawGapVines(ctx, left.x + left.w, leftCy, halfHeight, 1, (left.x + left.w) * 0.7 + leftCy * 0.31, clockSeconds);
      drawGapVines(ctx, right.x, rightCy, halfHeight, -1, right.x * 0.7 + rightCy * 0.31, clockSeconds);
    }
  }
}

function drawFood(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const food of state.food) {
    const r = food.radius * 1.8;
    const g = ctx.createRadialGradient(food.pos.x, food.pos.y, 0, food.pos.x, food.pos.y, r);
    g.addColorStop(0, "#fff6d0");
    g.addColorStop(0.5, FOOD_COLOR);
    g.addColorStop(1, "rgba(255,233,138,0)");
    ctx.fillStyle = g;
    const rotation = seededRand(food.pos.x * 0.11 + food.pos.y * 0.07) * Math.PI * 2;
    pathFromPoints(ctx, localToWorld(food.pos.x, food.pos.y, rotation, crystalShardPoints(r)));
    ctx.fill();
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

  if (!crushable) {
    ctx.shadowColor = "rgba(255,45,77,0.85)";
    ctx.shadowBlur = 16;
  }
  if (hazard.tier === 0) {
    pathBat(ctx, hazard.pos.x, hazard.pos.y, r);
  } else {
    pathStar(ctx, hazard.pos.x, hazard.pos.y, r * 1.1, r * 0.5, 9);
  }
  ctx.fill();
  ctx.shadowBlur = 0;
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
  predator: NonNullable<GameState["predator"]>,
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
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = predator.state === "chase" ? 20 : 12;
  }
  pathFromPoints(ctx, localToWorld(predator.pos.x, predator.pos.y, angle, predatorLocalPoints(r)));
  ctx.fill();
  ctx.shadowBlur = 0;
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

    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(150,200,120,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, radius, radius * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const blades = 9;
    ctx.strokeStyle = "rgba(110,170,90,0.55)";
    ctx.lineWidth = 3;
    for (let i = 0; i < blades; i++) {
      const seed = gi * 13.7 + i * 4.1;
      const angle = (Math.PI * 2 * i) / blades + seededRand(seed) * 0.6;
      const bx = pos.x + Math.cos(angle) * radius * 0.7 * seededRand(seed + 1);
      const by = pos.y + Math.sin(angle) * radius * 0.5 * seededRand(seed + 2);
      const sway = Math.sin(clockSeconds * 2 + gi + i) * 6;
      const bladeH = 18 + seededRand(seed + 3) * 14;

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
  const cy = 50;
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

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState): void {
  const { pos, radius } = state.player;
  const g = ctx.createRadialGradient(
    pos.x - radius * 0.3,
    pos.y - radius * 0.3,
    0,
    pos.x,
    pos.y,
    radius,
  );
  g.addColorStop(0, "#e8fff5");
  g.addColorStop(0.55, PLAYER_COLOR);
  g.addColorStop(1, "#1a6e54");
  ctx.fillStyle = g;
  ctx.shadowColor = PLAYER_COLOR;
  ctx.shadowBlur = 24;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
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

// No words on a loss or a win -- a play/replay glyph is the only affordance,
// and tapping anywhere on it restarts.
function drawEndOverlay(ctx: CanvasRenderingContext2D, state: GameState, pulse: number): void {
  const { width, height, status } = state;
  const won = status === "won";
  ctx.fillStyle = won ? "rgba(80,255,190,0.18)" : "rgba(255,45,77,0.22)";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const r = 34 * pulse;
  ctx.fillStyle = "#f4fffb";
  ctx.shadowColor = won ? PLAYER_COLOR : DANGER_COLOR;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, cy - r * 0.75);
  ctx.lineTo(cx - r * 0.5, cy + r * 0.75);
  ctx.lineTo(cx + r * 0.75, cy);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}
