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

export interface Boulder {
  pos: Vec2;
  radius: number;
  // Which scattered rock cluster this boulder belongs to -- render.ts groups
  // by this (not by position) to find each cluster's internal gap(s).
  clusterId: number;
  // Generation order along the cluster's path. render.ts sorts by this
  // (rather than by raw x/y) to walk a cluster boulder-by-boulder when
  // looking for gaps, since a cluster's path can curve, zigzag, or loop and
  // is no longer guaranteed to be x-monotonic.
  pathIndex: number;
  // Whether this cluster's path is a closed loop (a "blob" ring) rather than
  // an open curve -- render.ts needs this to know whether the highest and
  // lowest pathIndex boulders are actually adjacent (and so may bound a real
  // gap) or are just the two open ends of a line/arc/zigzag.
  closed: boolean;
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
  walls: Boulder[];
  dangerBands: [number, number];
  predators: Predator[];
  secondPredatorSpawned: boolean;
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
// dangerous longer; lower it and growth pays off sooner. Raised from the
// original 1.15 -- at that ratio the smallest hazard tier was crushable
// after only ~2 food, which meant most of a round had no real hazard danger
// left. Paired with the bigger HAZARD_TIERS radii below so the predator
// (radius 34, unchanged) stays crushable near the very end rather than
// becoming permanently invincible.
export const CRUSH_RATIO = 1.3;
export const FOOD_RADIUS = 4;
export const FOOD_GROWTH = 1.3;
export const FOOD_COUNT = 30;
export const FOLLOW_EASE = 7;
export const GATE_GAP = 80;
export const HAZARDS_PER_TIER = 4;

// Tier 2 (the old biggest/deadliest static hazard) is now the predator
// below -- only the two weaker, static tiers stay here. Radii raised
// alongside CRUSH_RATIO (see above) so both the crush threshold and the raw
// size of a hazard make it harder to shrug off early.
export const HAZARD_TIERS: { radius: number; color: string }[] = [
  { radius: 13, color: "#f5a623" },
  { radius: 27, color: "#e8543f" },
];

export const PREDATOR_RADIUS = 34;
export const PREDATOR_DETECT_RADIUS = 220;
export const PREDATOR_LOSE_RADIUS = 320;
export const PREDATOR_PATROL_SPEED = 60;
export const PREDATOR_CHASE_SPEED = 130;
export const PREDATOR_SEARCH_TIME = 3;
// Two guarantees about the opening, which previously had neither.
//
// A predator's home band can sit as close as ~130px to the centre spawn, and
// placeAvoiding only demanded 100px -- comfortably inside DETECT_RADIUS. So a
// round could legitimately begin with a predator already locked on, closing
// at chase speed, killing the player at t~1s before they had eaten anything
// or learned a rule. Losing with no agency and no score is the one outcome a
// 60-second round can't afford.
//
// CLEARANCE keeps a spawning predator outside its own detection range (which
// also covers the mid-round second predator, whose arrival is worse still --
// the player is busy). GRACE then stops any predator from acquiring at all
// for the first few seconds, so the opening is reliably about learning the
// map. Neither weakens the other 56 seconds.
// Sized against how placeAvoiding actually reads it: farEnough demands
// `dist > radius + minGap`, and minGap is 40 here, so this yields a real
// 240px exclusion -- clear of DETECT_RADIUS with room to spare. Asking for
// much more starts failing the random search often enough that the fallback
// below becomes the common path, and a predator that's reliably in a corner
// is its own kind of bad design.
export const PREDATOR_SPAWN_CLEARANCE = 200;
export const PREDATOR_GRACE_S = 4;
// A second hunter joins partway through the round -- picked so it lands
// after the safe zone has already started closing in (see below), stacking
// two escalation points instead of one.
export const SECOND_PREDATOR_SPAWN_S = 28;

// A shrinking safe zone around the map center: harmless at first, then
// closes in from SHRINK_START to SHRINK_END (elapsed round seconds),
// punishing the player for camping far from center in the back half of a
// round. Values chosen so the zone starts closing before the second
// predator arrives, and bottoms out a few seconds before the round ends.
export const SAFE_ZONE_SHRINK_START_S = 20;
export const SAFE_ZONE_SHRINK_END_S = 55;
export const SAFE_ZONE_MIN_FRACTION = 0.32;
export const SAFE_ZONE_DRAIN_PER_S = 2.5;
export const MIN_SURVIVABLE_RADIUS = 3;

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

function insideAnyWall(pos: Vec2, radius: number, walls: Boulder[]): boolean {
  return walls.some((w) => dist(pos, w.pos) < w.radius + radius);
}

function placeAvoiding(
  width: number,
  height: number,
  radius: number,
  avoid: { pos: Vec2; radius: number }[],
  minGap: number,
  attempts = 40,
  yRange?: YRange,
  walls: Boulder[] = [],
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
// Per-boulder radius range. Varying it (rather than one fixed thickness) is
// part of what makes even a "line" cluster read as an uneven rock pile
// instead of a ruler-straight bar.
const CLUSTER_BOULDER_RADIUS_MIN = 9;
const CLUSTER_BOULDER_RADIUS_MAX = 15;
// Extra isotropic jitter applied to every boulder's placement along its
// path -- the "hand-scattered, not a perfect curve" touch, now shape-
// agnostic since it's no longer tied to a single shared centerline.
const CLUSTER_BOULDER_JITTER = 6;

type ClusterShape = "line" | "arc" | "zigzag" | "blob";

// Weighted so straight-ish clusters still turn up sometimes, but most
// clusters now read as something other than a bar -- this is the direct
// answer to "obstacles shouldn't be confined to straight lines."
function pickClusterShape(): ClusterShape {
  const r = Math.random();
  if (r < 0.3) return "line";
  if (r < 0.55) return "arc";
  if (r < 0.75) return "zigzag";
  return "blob";
}

// A cluster's local-space (unrotated, uncentered) curve: `point(t)` for
// t in [0,1). `closed` clusters (the "blob" ring) treat t=0 and t=1 as
// adjacent, so their gap-search and boulder-walk wrap around instead of
// stopping at two open ends.
interface ShapePath {
  point(t: number): Vec2;
  count: number;
  closed: boolean;
}

function makeShapePath(shape: ClusterShape, span: number): ShapePath {
  const spacing = (CLUSTER_BOULDER_RADIUS_MIN + CLUSTER_BOULDER_RADIUS_MAX) * 0.7;
  const count = Math.max(8, Math.round(span / spacing));

  if (shape === "blob") {
    // A broken ring: circumference == span, so the same GATE_GAP-wide-gap
    // logic below reads as one or two openings in the ring instead of a cut
    // in a bar. Wobble is a couple of fixed-phase sine harmonics (chosen
    // once per cluster, not per point) so the ring stays a smooth lumpy
    // blob instead of a noisy, hard-to-navigate silhouette.
    const radius = span / (2 * Math.PI);
    const wobbleAmp = 0.12 + Math.random() * 0.1;
    const wobbleFreq = 2 + Math.floor(Math.random() * 2);
    const wobblePhase = Math.random() * Math.PI * 2;
    return {
      count: Math.max(10, count),
      closed: true,
      point: (t) => {
        const angle = t * Math.PI * 2;
        const r = radius * (1 + wobbleAmp * Math.sin(angle * wobbleFreq + wobblePhase));
        return { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.75 };
      },
    };
  }

  if (shape === "arc") {
    // A crescent: radius (and so curvature) varies per cluster between a
    // tight bend and a nearly-straight sweep.
    const radius = span * (0.6 + Math.random() * 0.6);
    const theta = span / radius;
    return {
      count,
      closed: false,
      point: (t) => {
        const angle = (t - 0.5) * theta;
        return {
          x: radius * Math.sin(angle),
          y: radius * (1 - Math.cos(angle)) - radius * (1 - Math.cos(theta / 2)),
        };
      },
    };
  }

  if (shape === "zigzag") {
    // A lightning-bolt ridge: a triangle wave across 2-4 segments.
    const segments = 2 + Math.floor(Math.random() * 3);
    const amp = span * 0.09;
    return {
      count,
      closed: false,
      point: (t) => {
        const local = (t * segments) % 1;
        return { x: (t - 0.5) * span, y: (1 - 4 * Math.abs(local - 0.5)) * amp };
      },
    };
  }

  return {
    count,
    closed: false,
    point: (t) => ({ x: (t - 0.5) * span, y: 0 }),
  };
}

interface LocalBoulder {
  x: number;
  y: number;
  radius: number;
  pathIndex: number;
}

// Walks a cluster's shape path and places a boulder at every step outside
// its gap window(s) -- usually one gap, but sometimes two, giving the
// player an actual route choice instead of a single forced funnel. Every
// gap stays exactly GATE_GAP wide (in arc-length) regardless of shape.
function makeClusterBoulders(shape: ClusterShape, span: number): LocalBoulder[] {
  const path = makeShapePath(shape, span);
  const gapFrac = Math.min(0.35, GATE_GAP / span);
  const wantsTwoGaps = Math.random() >= 0.6 && gapFrac * 2 + 0.15 < 1;
  const gapCount = wantsTwoGaps ? 2 : 1;

  const gapCenters: number[] = [];
  let attempts = 0;
  while (gapCenters.length < gapCount && attempts < 200) {
    attempts++;
    const candidate = gapFrac / 2 + Math.random() * Math.max(0.01, 1 - gapFrac);
    if (gapCenters.every((g) => Math.abs(g - candidate) >= gapFrac + 0.12)) gapCenters.push(candidate);
  }

  const inGap = (t: number) =>
    gapCenters.some((g) => {
      const raw = Math.abs(t - g);
      const d = path.closed ? Math.min(raw, 1 - raw) : raw;
      return d < gapFrac / 2;
    });

  const boulders: LocalBoulder[] = [];
  for (let i = 0; i < path.count; i++) {
    const t = path.closed ? i / path.count : i / (path.count - 1);
    if (inGap(t)) continue;
    const { x, y } = path.point(t);
    boulders.push({
      x: x + (Math.random() - 0.5) * 2 * CLUSTER_BOULDER_JITTER,
      y: y + (Math.random() - 0.5) * 2 * CLUSTER_BOULDER_JITTER,
      radius: CLUSTER_BOULDER_RADIUS_MIN + Math.random() * (CLUSTER_BOULDER_RADIUS_MAX - CLUSTER_BOULDER_RADIUS_MIN),
      pathIndex: boulders.length,
    });
  }
  return boulders;
}

// One independent rock cluster, placed and rotated into world space. Unlike
// the old full-width gate rows, a cluster never spans the whole map -- the
// player routes around it or threads its gap(s) by choice, never through a
// forced chokepoint. The random rotation means even a "line" or "arc"
// cluster isn't always lying flat the way every cluster used to.
function makeCluster(cx: number, cy: number, span: number, clusterId: number, shape: ClusterShape): Boulder[] {
  const angle = Math.random() * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return makeClusterBoulders(shape, span).map((b) => ({
    pos: { x: cx + b.x * cos - b.y * sin, y: cy + b.x * sin + b.y * cos },
    radius: b.radius,
    clusterId,
    pathIndex: b.pathIndex,
    closed: shape === "blob",
  }));
}

// Scatters CLUSTER_COUNT independent clusters across the map. Each cluster's
// center is placed via the same placeAvoiding used for hazards/food/grass,
// and pushed onto that same `occupied` list so nothing spawns inside a
// cluster's footprint -- clusters are the first thing placed, before any
// other entity.
function makeRockClusters(width: number, height: number, occupied: { pos: Vec2; radius: number }[]): Boulder[] {
  const walls: Boulder[] = [];
  for (let i = 0; i < CLUSTER_COUNT; i++) {
    const span = CLUSTER_MIN_SPAN + Math.random() * (CLUSTER_MAX_SPAN - CLUSTER_MIN_SPAN);
    const shape = pickClusterShape();
    // A "blob" cluster's footprint is a ring of this radius, not a
    // span/2-wide bar -- estimate its bounding radius accordingly so
    // placeAvoiding doesn't badly under- or overestimate how much room to
    // leave around it.
    const clusterRadius = shape === "blob" ? span / (2 * Math.PI) + CLUSTER_BOULDER_RADIUS_MAX : span / 2;
    const pos = placeAvoiding(width, height, clusterRadius, occupied, 40, 80);
    occupied.push({ pos, radius: clusterRadius });
    walls.push(...makeCluster(pos.x, pos.y, span, i, shape));
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

// Builds one predator in a random outer band, placed via the same
// placeAvoiding used for hazards/food/grass. `walls` is only needed for a
// mid-round spawn (createInitialState already folds cluster footprints into
// `occupied` before this runs).
/**
 * placeAvoiding gives up after a bounded number of tries and returns an
 * *unconstrained* point -- fine for food, fatal for a predator, since it
 * quietly reintroduces the spawn-already-hunting-you case the clearance
 * exists to rule out. This is the backstop: if the search came back too
 * close, take whichever corner of the predator's own band is furthest from
 * the player, which on any reasonable viewport is several hundred pixels
 * clear. Rare by design -- see PREDATOR_SPAWN_CLEARANCE on why.
 */
function farthestBandCornerIfTooClose(
  pos: Vec2,
  playerPos: Vec2,
  width: number,
  height: number,
  band: YRange,
): Vec2 {
  if (dist(pos, playerPos) > PREDATOR_SPAWN_CLEARANCE + 40) return pos;
  const margin = PREDATOR_RADIUS + 10;
  const yLow = Math.max(band.minY, margin);
  const yHigh = Math.max(yLow, Math.min(band.maxY, height - margin));
  const xLow = margin;
  const xHigh = Math.max(xLow, width - margin);

  let best = pos;
  let bestDist = -1;
  for (const x of [xLow, xHigh]) {
    for (const y of [yLow, yHigh]) {
      const candidate = { x, y };
      const d = dist(candidate, playerPos);
      if (d > bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
  }
  return best;
}

function makePredator(
  width: number,
  height: number,
  dangerBands: [number, number],
  occupied: { pos: Vec2; radius: number }[],
  playerPos: Vec2,
  walls: Boulder[] = [],
): Predator {
  const bands = outerBands(height, dangerBands);
  const homeBand = bands[Math.floor(Math.random() * bands.length)];
  // The player gets their own oversized exclusion on top of whatever's
  // already in `occupied` -- the generic 60px entry there is about not
  // spawning on top of each other, which is a much weaker promise than "far
  // enough away that it can't already see you".
  const avoid = [...occupied, { pos: playerPos, radius: PREDATOR_SPAWN_CLEARANCE }];
  const pos = farthestBandCornerIfTooClose(
    placeAvoiding(width, height, PREDATOR_RADIUS, avoid, 40, 80, homeBand, walls),
    playerPos,
    width,
    height,
    homeBand,
  );
  occupied.push({ pos, radius: PREDATOR_RADIUS });
  return {
    pos,
    radius: PREDATOR_RADIUS,
    state: "patrol",
    patrolTarget: randomPoint(width, height, PREDATOR_RADIUS + 10, homeBand),
    lastKnownPlayerPos: { ...pos },
    searchTimeLeft: 0,
    homeBand,
  };
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
  // confined to a random outer band so it's never right on top of spawn. A
  // second one joins mid-round -- see trySpawnSecondPredator.
  const predators = [makePredator(width, height, dangerBands, occupied, player.pos)];

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
    predators,
    secondPredatorSpawned: false,
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

/**
 * The safe zone's radius around the map center at a given elapsed time --
 * covers the whole map (a no-op) until SAFE_ZONE_SHRINK_START_S, then
 * linearly closes in to SAFE_ZONE_MIN_FRACTION of that by SAFE_ZONE_SHRINK_END_S.
 */
export function safeZoneRadius(width: number, height: number, elapsedS: number): number {
  const full = Math.hypot(width, height) / 2;
  const span = SAFE_ZONE_SHRINK_END_S - SAFE_ZONE_SHRINK_START_S;
  const t = Math.max(0, Math.min(1, (elapsedS - SAFE_ZONE_SHRINK_START_S) / span));
  return full * (1 - t * (1 - SAFE_ZONE_MIN_FRACTION));
}

/** Whether the player currently sits outside the shrinking safe zone -- drives both the stepGame drain and the render.ts warning tint. */
export function isOutsideSafeZone(state: GameState): boolean {
  const center = { x: state.width / 2, y: state.height / 2 };
  const radius = safeZoneRadius(state.width, state.height, TIME_LIMIT_S - state.timeLeft);
  return dist(state.player.pos, center) > radius;
}

/** The one rule under a focused automated test: does growing into a hazard crush it, or does it kill you? */
export function resolveHazardCollision(player: Player, hazard: Hazard): "crush" | "die" | "none" {
  if (dist(player.pos, hazard.pos) >= player.radius + hazard.radius) return "none";
  return player.radius >= hazard.radius * CRUSH_RATIO ? "crush" : "die";
}

/** Pushes a circle out of a solid boulder if it overlaps; returns the same position untouched otherwise. */
export function resolveWallCollision(pos: Vec2, radius: number, wall: Boulder): Vec2 {
  const dx = pos.x - wall.pos.x;
  const dy = pos.y - wall.pos.y;
  const distance = Math.hypot(dx, dy);
  const minDist = radius + wall.radius;

  if (distance === 0) return { x: pos.x + minDist, y: pos.y };
  if (distance >= minDist) return pos;

  const push = (minDist - distance) / distance;
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
export function nextPredatorState(
  current: PredatorState,
  hidden: boolean,
  distToPlayer: number,
  graceActive = false,
): PredatorState {
  if (current === "chase") {
    return hidden || distToPlayer > PREDATOR_LOSE_RADIUS ? "search" : "chase";
  }
  // Grace blocks acquiring a target, never breaking off one already held --
  // it protects the opening, it isn't a shield the player can re-trigger.
  if (graceActive) return current;
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

// Adds a second predator once the round has run for SECOND_PREDATOR_SPAWN_S
// seconds -- placed with the same avoidance logic as init, but built fresh
// each time since there's no running `occupied` list mid-round the way
// createInitialState has one.
function trySpawnSecondPredator(state: GameState): void {
  if (state.secondPredatorSpawned) return;
  if (TIME_LIMIT_S - state.timeLeft < SECOND_PREDATOR_SPAWN_S) return;
  state.secondPredatorSpawned = true;
  const occupied = [
    { pos: state.player.pos, radius: state.player.radius + 60 },
    ...state.predators.map((p) => ({ pos: p.pos, radius: p.radius })),
  ];
  state.predators.push(
    makePredator(state.width, state.height, state.dangerBands, occupied, state.player.pos, state.walls),
  );
}

function updatePredators(state: GameState, dt: number): void {
  for (const p of state.predators) updateOnePredator(state, p, dt);
}

function updateOnePredator(state: GameState, p: Predator, dt: number): void {
  const hidden = isPlayerHidden(state);
  const distToPlayer = dist(p.pos, state.player.pos);
  const wasChasing = p.state === "chase";
  const graceActive = TIME_LIMIT_S - state.timeLeft < PREDATOR_GRACE_S;
  p.state = nextPredatorState(p.state, hidden, distToPlayer, graceActive);

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

  trySpawnSecondPredator(state);
  updatePredators(state, dt);
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

  const survivingPredators: Predator[] = [];
  for (const predator of state.predators) {
    const verdict = withInvincibility(
      resolveHazardCollision(state.player, { ...predator, tier: 2 }),
      state.invincibleTimeLeft,
    );
    if (verdict === "die") {
      state.status = "lost";
      return state;
    }
    if (verdict !== "crush") survivingPredators.push(predator);
  }
  state.predators = survivingPredators;

  // The shrinking safe zone punishes camping far from center in the back
  // half of a round -- unlike hazards/predators, invincibility doesn't guard
  // against it, since the shield's role is "can't be eaten," not "immune to
  // the terrain."
  if (isOutsideSafeZone(state)) {
    state.player.radius -= SAFE_ZONE_DRAIN_PER_S * dt;
    if (state.player.radius < MIN_SURVIVABLE_RADIUS) {
      state.status = "lost";
      return state;
    }
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
