// Pure game logic: no DOM, no canvas. Everything here is deterministic given
// its inputs, which is what makes resolveHazardCollision testable on its own
// in spec/crush-rule.test.ts.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Player {
  pos: Vec2;
  radius: number;
}

export interface Food {
  pos: Vec2;
  radius: number;
}

export interface Hazard {
  pos: Vec2;
  radius: number;
  tier: number;
}

export interface WallRect {
  x: number;
  y: number;
  w: number;
  h: number;
  // Which scattered rock cluster this segment belongs to -- render.ts groups
  // by this (not by exact y) to find each cluster's internal gap(s), since
  // boulders within one cluster are no longer pinned to a shared y (see
  // makeCluster's jitter, below).
  clusterId: number;
}

export type PredatorState = "patrol" | "chase" | "search";

export interface Predator {
  pos: Vec2;
  radius: number;
  state: PredatorState;
  patrolTarget: Vec2;
  lastKnownPlayerPos: Vec2;
  searchTimeLeft: number;
  homeBand: YRange;
}

export interface Grass {
  pos: Vec2;
  radius: number;
}

export type PowerUpKind = "invincible" | "magnet";

export interface PowerUp {
  pos: Vec2;
  radius: number;
  kind: PowerUpKind;
}

export type GameStatus = "playing" | "won" | "lost";

export interface GameState {
  width: number;
  height: number;
  player: Player;
  food: Food[];
  hazards: Hazard[];
  walls: WallRect[];
  dangerBands: [number, number];
  predator: Predator | null;
  grass: Grass[];
  powerUps: PowerUp[];
  invincibleTimeLeft: number;
  magnetTimeLeft: number;
  invincibleSpawnCooldown: number;
  magnetSpawnCooldown: number;
  timeLeft: number;
  status: GameStatus;
}

export const START_RADIUS = 9;
export const WIN_RADIUS = 46;
export const TIME_LIMIT_S = 60;
// How much bigger than a hazard the player must be to crush it instead of
// dying to it. Tune this by playing: raise it and small hazards stay
// dangerous longer; lower it and growth pays off sooner.
export const CRUSH_RATIO = 1.15;
export const FOOD_RADIUS = 4;
export const FOOD_GROWTH = 1.3;
export const FOOD_COUNT = 30;
export const FOLLOW_EASE = 7;
export const GATE_GAP = 80;
export const GATE_THICKNESS = 16;
export const HAZARDS_PER_TIER = 4;

// Tier 2 (the old biggest/deadliest static hazard) is now the predator
// below -- only the two weaker, static tiers stay here.
export const HAZARD_TIERS: { radius: number; color: string }[] = [
  { radius: 10, color: "#f5a623" },
  { radius: 20, color: "#e8543f" },
];

export const PREDATOR_RADIUS = 34;
export const PREDATOR_DETECT_RADIUS = 220;
export const PREDATOR_LOSE_RADIUS = 320;
export const PREDATOR_PATROL_SPEED = 60;
export const PREDATOR_CHASE_SPEED = 130;
export const PREDATOR_SEARCH_TIME = 3;

export const GRASS_COUNT = 7;
export const GRASS_RADIUS = 55;

export const POWERUP_RADIUS = 8;
export const INVINCIBLE_DURATION = 6;
export const MAGNET_DURATION = 7;
export const MAGNET_RADIUS = 140;
export const MAGNET_PULL_SPEED = 220;
export const POWERUP_RESPAWN_COOLDOWN = 12;
// Give the opening seconds a "just you and the map" feel before any pickup
// exists to chase.
export const POWERUP_INITIAL_DELAY = 8;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Constant-speed steering used by both the predator (toward its current
// target) and magnetized food (toward the player) -- moves at most `speed *
// dt` toward `target`, never overshooting it.
function moveToward(pos: Vec2, target: Vec2, speed: number, dt: number): void {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return;
  const step = Math.min(d, speed * dt);
  pos.x += (dx / d) * step;
  pos.y += (dy / d) * step;
}

export interface YRange {
  minY: number;
  maxY: number;
}

function randomPoint(width: number, height: number, margin: number, yRange?: YRange): Vec2 {
  const minY = yRange ? Math.max(yRange.minY, margin) : margin;
  const maxY = yRange ? Math.min(yRange.maxY, height - margin) : height - margin;
  return {
    x: margin + Math.random() * Math.max(1, width - margin * 2),
    y: minY + Math.random() * Math.max(1, maxY - minY),
  };
}

function farEnough(pos: Vec2, others: { pos: Vec2; radius: number }[], minGap: number): boolean {
  return others.every((o) => dist(pos, o.pos) > o.radius + minGap);
}

function insideAnyWall(pos: Vec2, radius: number, walls: WallRect[]): boolean {
  return walls.some(
    (w) => pos.x + radius > w.x && pos.x - radius < w.x + w.w && pos.y + radius > w.y && pos.y - radius < w.y + w.h,
  );
}

function placeAvoiding(
  width: number,
  height: number,
  radius: number,
  avoid: { pos: Vec2; radius: number }[],
  minGap: number,
  attempts = 40,
  yRange?: YRange,
  walls: WallRect[] = [],
): Vec2 {
  for (let i = 0; i < attempts; i++) {
    const p = randomPoint(width, height, radius + 10, yRange);
    if (farEnough(p, avoid, minGap) && !insideAnyWall(p, radius, walls)) return p;
  }
  return randomPoint(width, height, radius + 10, yRange);
}

const CLUSTER_COUNT = 7;
const CLUSTER_MIN_SPAN = 220;
const CLUSTER_MAX_SPAN = 380;
// The minimum wall chunk width -- at a cluster's outer edges and between two
// gaps in the same cluster -- scales with the cluster's own span rather than
// a flat constant: reusing one fixed margin at both a 220px and a 380px span
// would either starve the small end of any room or (worse) make a second gap
// on the small end nearly impossible to find via rejection sampling, quietly
// killing the "sometimes two gaps" variety this exists to offer.
const CLUSTER_MIN_SEGMENT_FLOOR = 25;
const CLUSTER_MIN_SEGMENT_RATIO = 0.1;
// Boulders within one cluster are offset from a shared centerline by up to
// this much so the cluster reads as an uneven rock pile, not a short
// straight bar -- the ask that "obstacles shouldn't be confined to straight
// lines" applies at the single-cluster scale too, not just to how clusters
// are scattered across the map.
const CLUSTER_BOULDER_Y_JITTER = 14;

// One cluster's wall segments along a local [0, span] axis, not yet placed
// in the world. Usually a single gap, but sometimes two -- two gaps in the
// same cluster give the player an actual route choice (the closer one vs.
// the one that swings wider of a hazard band) instead of a single forced
// funnel. Every gap stays exactly GATE_GAP wide regardless of count.
function makeClusterSpan(span: number, minSegment: number): WallRect[] {
  const spacing = GATE_GAP + minSegment;
  const maxGapsThatFit = Math.floor((span - minSegment) / spacing);
  const gapCount = Math.max(1, Math.min(maxGapsThatFit, Math.random() < 0.6 ? 1 : 2));

  const gapStarts: number[] = [];
  let attempts = 0;
  while (gapStarts.length < gapCount && attempts < 200) {
    attempts++;
    const candidate = minSegment + Math.random() * Math.max(1, span - GATE_GAP - minSegment * 2);
    if (gapStarts.every((g) => Math.abs(g - candidate) >= spacing)) gapStarts.push(candidate);
  }
  gapStarts.sort((a, b) => a - b);

  const rects: Omit<WallRect, "clusterId">[] = [];
  let cursor = 0;
  for (const gapX of gapStarts) {
    rects.push({ x: cursor, y: -GATE_THICKNESS / 2, w: Math.max(gapX - cursor, 0), h: GATE_THICKNESS });
    cursor = gapX + GATE_GAP;
  }
  rects.push({ x: cursor, y: -GATE_THICKNESS / 2, w: Math.max(span - cursor, 0), h: GATE_THICKNESS });
  return rects as WallRect[];
}

// One independent rock cluster, placed and jittered into world space. Unlike
// the old full-width gate rows, a cluster never spans the whole map -- the
// player routes around it or threads its gap(s) by choice, never through a
// forced chokepoint.
function makeCluster(cx: number, cy: number, span: number, clusterId: number): WallRect[] {
  const minSegment = Math.max(CLUSTER_MIN_SEGMENT_FLOOR, span * CLUSTER_MIN_SEGMENT_RATIO);
  return makeClusterSpan(span, minSegment).map((r) => ({
    ...r,
    x: r.x + cx - span / 2,
    y: r.y + cy + (Math.random() - 0.5) * 2 * CLUSTER_BOULDER_Y_JITTER,
    clusterId,
  }));
}

// Scatters CLUSTER_COUNT independent clusters across the map. Each cluster's
// center is placed via the same placeAvoiding used for hazards/food/grass,
// and pushed onto that same `occupied` list so nothing spawns inside a
// cluster's footprint -- clusters are the first thing placed, before any
// other entity.
function makeRockClusters(width: number, height: number, occupied: { pos: Vec2; radius: number }[]): WallRect[] {
  const walls: WallRect[] = [];
  for (let i = 0; i < CLUSTER_COUNT; i++) {
    const span = CLUSTER_MIN_SPAN + Math.random() * (CLUSTER_MAX_SPAN - CLUSTER_MIN_SPAN);
    const clusterRadius = span / 2;
    const pos = placeAvoiding(width, height, clusterRadius, occupied, 40, 80);
    occupied.push({ pos, radius: clusterRadius });
    walls.push(...makeCluster(pos.x, pos.y, span, i));
  }
  return walls;
}

// Pure spawn-bias split for hazard/predator placement below -- no longer
// tied to any physical wall geometry now that obstacles are scattered
// clusters instead of 2 full-width rows. Crossing from one band to another
// no longer requires threading a gap; this only biases *where* things
// spawn, it doesn't gate movement between bands the way the old rows did.
function bandBoundaries(height: number): [number, number] {
  return [height * (0.3 + (Math.random() - 0.5) * 0.06), height * (0.7 + (Math.random() - 0.5) * 0.06)];
}

// Tier 0 (weakest) stays in the player's own spawn band; tier 1 (bigger,
// deadlier -- and the predator, see below) is confined to the two outer
// bands, so the map has a deliberate safe-core/risky-periphery curve
// instead of uniform scatter.
function tierBands(tierIndex: number, height: number, dangerBands: [number, number]): YRange[] {
  const [bandTop, bandBottom] = dangerBands;
  if (tierIndex === 0) return [{ minY: bandTop, maxY: bandBottom }];
  return [
    { minY: 0, maxY: bandTop },
    { minY: bandBottom, maxY: height },
  ];
}

function outerBands(height: number, dangerBands: [number, number]): YRange[] {
  return tierBands(1, height, dangerBands);
}

export function createInitialState(width: number, height: number): GameState {
  const player: Player = { pos: { x: width / 2, y: height / 2 }, radius: START_RADIUS };
  const occupied: { pos: Vec2; radius: number }[] = [{ pos: player.pos, radius: 60 }];
  const walls = makeRockClusters(width, height, occupied);
  const dangerBands = bandBoundaries(height);

  const hazards: Hazard[] = [];
  HAZARD_TIERS.forEach((tier, tierIndex) => {
    const bands = tierBands(tierIndex, height, dangerBands);
    // Tier 0 is confined to the spawn band, so unlike tiers 1-2 (already far
    // from spawn by band alone) it needs its own extra clearance -- otherwise
    // all 4 of them landing near the one point the player is guaranteed to be
    // near, while still too small to crush, turns "explore a bit" into a coin
    // flip on an instant death before growth is even possible.
    const minGap = tierIndex === 0 ? 90 : 40;
    for (let i = 0; i < HAZARDS_PER_TIER; i++) {
      const band = bands[i % bands.length];
      const pos = placeAvoiding(width, height, tier.radius, occupied, minGap, 80, band);
      occupied.push({ pos, radius: tier.radius });
      hazards.push({ pos, radius: tier.radius, tier: tierIndex });
    }
  });

  const food: Food[] = [];
  for (let i = 0; i < FOOD_COUNT; i++) {
    const pos = placeAvoiding(width, height, FOOD_RADIUS, occupied, 12);
    food.push({ pos, radius: FOOD_RADIUS });
  }

  // The predator takes over tier 2's old role -- biggest, deadliest, and
  // confined to a random outer band so it's never right on top of spawn.
  const bands = outerBands(height, dangerBands);
  const homeBand = bands[Math.floor(Math.random() * bands.length)];
  const predatorPos = placeAvoiding(width, height, PREDATOR_RADIUS, occupied, 40, 80, homeBand);
  occupied.push({ pos: predatorPos, radius: PREDATOR_RADIUS });
  const predator: Predator = {
    pos: predatorPos,
    radius: PREDATOR_RADIUS,
    state: "patrol",
    patrolTarget: randomPoint(width, height, PREDATOR_RADIUS + 10, homeBand),
    lastKnownPlayerPos: { ...predatorPos },
    searchTimeLeft: 0,
    homeBand,
  };

  const grass: Grass[] = [];
  for (let i = 0; i < GRASS_COUNT; i++) {
    const pos = placeAvoiding(width, height, GRASS_RADIUS, occupied, 20);
    grass.push({ pos, radius: GRASS_RADIUS });
  }

  return {
    width,
    height,
    player,
    food,
    hazards,
    walls,
    dangerBands,
    predator,
    grass,
    powerUps: [],
    invincibleTimeLeft: 0,
    magnetTimeLeft: 0,
    invincibleSpawnCooldown: POWERUP_INITIAL_DELAY,
    magnetSpawnCooldown: POWERUP_INITIAL_DELAY,
    timeLeft: TIME_LIMIT_S,
    status: "playing",
  };
}

/** The one rule under a focused automated test: does growing into a hazard crush it, or does it kill you? */
export function resolveHazardCollision(player: Player, hazard: Hazard): "crush" | "die" | "none" {
  if (dist(player.pos, hazard.pos) >= player.radius + hazard.radius) return "none";
  return player.radius >= hazard.radius * CRUSH_RATIO ? "crush" : "die";
}

/** Pushes a circle out of a solid rect if it overlaps; returns the same position untouched otherwise. */
export function resolveWallCollision(pos: Vec2, radius: number, wall: WallRect): Vec2 {
  const closestX = Math.max(wall.x, Math.min(pos.x, wall.x + wall.w));
  const closestY = Math.max(wall.y, Math.min(pos.y, wall.y + wall.h));
  const dx = pos.x - closestX;
  const dy = pos.y - closestY;
  const distance = Math.hypot(dx, dy);

  if (distance === 0) {
    const pushLeft = pos.x - wall.x;
    const pushRight = wall.x + wall.w - pos.x;
    const pushUp = pos.y - wall.y;
    const pushDown = wall.y + wall.h - pos.y;
    const min = Math.min(pushLeft, pushRight, pushUp, pushDown);
    if (min === pushLeft) return { x: wall.x - radius, y: pos.y };
    if (min === pushRight) return { x: wall.x + wall.w + radius, y: pos.y };
    if (min === pushUp) return { x: pos.x, y: wall.y - radius };
    return { x: pos.x, y: wall.y + wall.h + radius };
  }

  if (distance >= radius) return pos;

  const push = (radius - distance) / distance;
  return { x: pos.x + dx * push, y: pos.y + dy * push };
}

/** True while the player's position falls inside any grass patch -- the predator can't detect them. */
export function isPlayerHidden(state: GameState): boolean {
  return state.grass.some((g) => dist(state.player.pos, g.pos) < g.radius);
}

/**
 * The predator's patrol/chase/search transition table. `search`'s own
 * give-up-and-return-to-patrol edge needs a timer and a position check, both
 * of which depend on `dt` -- that transition is handled by the caller
 * (`updatePredator`) rather than here.
 */
export function nextPredatorState(current: PredatorState, hidden: boolean, distToPlayer: number): PredatorState {
  if (current === "chase") {
    return hidden || distToPlayer > PREDATOR_LOSE_RADIUS ? "search" : "chase";
  }
  if (!hidden && distToPlayer < PREDATOR_DETECT_RADIUS) return "chase";
  return current;
}

/** While a shield is active, a would-be death is simply ignored -- the hazard/predator stays put, untouched. */
export function withInvincibility(verdict: "crush" | "die" | "none", invincibleTimeLeft: number): "crush" | "die" | "none" {
  return verdict === "die" && invincibleTimeLeft > 0 ? "none" : verdict;
}

// Unlike the old full-width gate rows, a scattered cluster never walls off a
// whole region -- growing too wide for one cluster's gap just means routing
// around that cluster instead of being structurally confined to a band. So
// food/power-ups need no reachability guard any more: they just respawn
// anywhere on the map, same as before that guard ever existed.
function consumeFood(state: GameState): void {
  state.food = state.food.filter((f) => {
    if (dist(state.player.pos, f.pos) >= state.player.radius + f.radius) return true;
    state.player.radius += FOOD_GROWTH;
    return false;
  });
  while (state.food.length < FOOD_COUNT) {
    const occupied = [{ pos: state.player.pos, radius: state.player.radius + 30 }];
    state.food.push({
      pos: placeAvoiding(state.width, state.height, FOOD_RADIUS, occupied, 8, 40, undefined, state.walls),
      radius: FOOD_RADIUS,
    });
  }
}

function updatePredator(state: GameState, dt: number): void {
  const p = state.predator;
  if (!p) return;

  const hidden = isPlayerHidden(state);
  const distToPlayer = dist(p.pos, state.player.pos);
  const wasChasing = p.state === "chase";
  p.state = nextPredatorState(p.state, hidden, distToPlayer);

  if (p.state === "chase") {
    p.lastKnownPlayerPos = { ...state.player.pos };
  } else if (wasChasing && p.state === "search") {
    p.searchTimeLeft = PREDATOR_SEARCH_TIME;
  }

  const target = p.state === "chase" ? state.player.pos : p.state === "search" ? p.lastKnownPlayerPos : p.patrolTarget;
  const speed = p.state === "patrol" ? PREDATOR_PATROL_SPEED : PREDATOR_CHASE_SPEED;
  moveToward(p.pos, target, speed, dt);

  if (p.state === "search") {
    p.searchTimeLeft -= dt;
    if (p.searchTimeLeft <= 0 || dist(p.pos, p.lastKnownPlayerPos) < p.radius) {
      p.state = "patrol";
      p.patrolTarget = randomPoint(state.width, state.height, p.radius + 10, p.homeBand);
    }
  } else if (p.state === "patrol" && dist(p.pos, p.patrolTarget) < p.radius) {
    p.patrolTarget = randomPoint(state.width, state.height, p.radius + 10, p.homeBand);
  }

  for (const wall of state.walls) {
    p.pos = resolveWallCollision(p.pos, p.radius, wall);
  }
}

// Pulls nearby food toward the player while a magnet buff is active, then
// hands off to the normal eat-on-overlap check in consumeFood -- pulled food
// that reaches the player gets eaten the same frame.
function applyMagnet(state: GameState, dt: number): void {
  if (state.magnetTimeLeft <= 0) return;
  for (const f of state.food) {
    if (dist(state.player.pos, f.pos) <= MAGNET_RADIUS) {
      moveToward(f.pos, state.player.pos, MAGNET_PULL_SPEED, dt);
    }
  }
}

function powerUpCooldown(state: GameState, kind: PowerUpKind): number {
  return kind === "invincible" ? state.invincibleSpawnCooldown : state.magnetSpawnCooldown;
}

function setPowerUpCooldown(state: GameState, kind: PowerUpKind, value: number): void {
  if (kind === "invincible") state.invincibleSpawnCooldown = value;
  else state.magnetSpawnCooldown = value;
}

function stepPowerUps(state: GameState, dt: number): void {
  state.powerUps = state.powerUps.filter((p) => {
    if (dist(state.player.pos, p.pos) >= state.player.radius + p.radius) return true;
    if (p.kind === "invincible") state.invincibleTimeLeft = INVINCIBLE_DURATION;
    else state.magnetTimeLeft = MAGNET_DURATION;
    setPowerUpCooldown(state, p.kind, POWERUP_RESPAWN_COOLDOWN);
    return false;
  });

  for (const kind of ["invincible", "magnet"] as const) {
    const cooldown = powerUpCooldown(state, kind) - dt;
    setPowerUpCooldown(state, kind, Math.max(0, cooldown));
    if (cooldown <= 0 && !state.powerUps.some((p) => p.kind === kind)) {
      const occupied = [{ pos: state.player.pos, radius: state.player.radius + 30 }];
      state.powerUps.push({
        pos: placeAvoiding(state.width, state.height, POWERUP_RADIUS, occupied, 12, 40, undefined, state.walls),
        radius: POWERUP_RADIUS,
        kind,
      });
    }
  }

  state.invincibleTimeLeft = Math.max(0, state.invincibleTimeLeft - dt);
  state.magnetTimeLeft = Math.max(0, state.magnetTimeLeft - dt);
}

export function stepGame(state: GameState, dt: number, target: Vec2): GameState {
  if (state.status !== "playing") return state;

  const ease = 1 - Math.exp(-FOLLOW_EASE * dt);
  state.player.pos.x += (target.x - state.player.pos.x) * ease;
  state.player.pos.y += (target.y - state.player.pos.y) * ease;

  state.player.pos.x = Math.max(state.player.radius, Math.min(state.width - state.player.radius, state.player.pos.x));
  state.player.pos.y = Math.max(state.player.radius, Math.min(state.height - state.player.radius, state.player.pos.y));

  for (const wall of state.walls) {
    state.player.pos = resolveWallCollision(state.player.pos, state.player.radius, wall);
  }

  updatePredator(state, dt);
  applyMagnet(state, dt);
  consumeFood(state);
  stepPowerUps(state, dt);

  const survivors: Hazard[] = [];
  for (const hazard of state.hazards) {
    const verdict = withInvincibility(resolveHazardCollision(state.player, hazard), state.invincibleTimeLeft);
    if (verdict === "die") {
      state.status = "lost";
      return state;
    }
    if (verdict !== "crush") survivors.push(hazard);
  }
  state.hazards = survivors;

  if (state.predator) {
    const verdict = withInvincibility(
      resolveHazardCollision(state.player, { ...state.predator, tier: 2 }),
      state.invincibleTimeLeft,
    );
    if (verdict === "die") {
      state.status = "lost";
      return state;
    }
    if (verdict === "crush") state.predator = null;
  }

  state.timeLeft -= dt;
  if (state.player.radius >= WIN_RADIUS) {
    state.status = "won";
  } else if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    state.status = "lost";
  }

  return state;
}
