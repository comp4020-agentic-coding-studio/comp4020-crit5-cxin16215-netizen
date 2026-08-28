// Every sound in the game, synthesized in the browser -- no audio files, so
// the deployed site gains sound without gaining a single asset byte or a
// network request. Like fx.ts this reads GameEvents and never writes state,
// so sound can't change the outcome of a round.
//
// Nothing here touches the speakers until unlock() runs from a real user
// gesture: browsers block audio before one, and a game that starts making
// noise the instant a tab loads deserves to be blocked anyway.

import { chaseThreatDistance, type GameEvent, type GameState } from "./game.ts";

const MASTER_GAIN = 0.42;

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let droneOsc: OscillatorNode | null = null;
let droneGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;

type AudioCtor = typeof AudioContext;

/**
 * Builds the audio graph on the first user gesture, and resumes it on later
 * ones (a tab that's been backgrounded can suspend the context). Safe to call
 * on every click -- it's a no-op once running.
 */
export function unlockAudio(): void {
  if (ac) {
    if (ac.state === "suspended") void ac.resume();
    return;
  }
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  // No Web Audio (or it threw): the game is fully playable silent, so fail
  // quiet rather than taking the render loop down with it.
  if (!Ctor) return;
  try {
    ac = new Ctor();
  } catch {
    ac = null;
    return;
  }

  master = ac.createGain();
  master.gain.value = muted ? 0 : MASTER_GAIN;
  master.connect(ac.destination);

  // A single sub-bass oscillator held for the whole session, its gain ridden
  // by updateAudio. Continuous proximity is something a drone expresses far
  // better than any number of discrete sounds: you hear a predator closing
  // before you've picked it out of the scene.
  droneOsc = ac.createOscillator();
  droneGain = ac.createGain();
  droneOsc.type = "sawtooth";
  droneOsc.frequency.value = 55;
  droneGain.gain.value = 0;
  const droneFilter = ac.createBiquadFilter();
  droneFilter.type = "lowpass";
  droneFilter.frequency.value = 220;
  droneOsc.connect(droneFilter).connect(droneGain).connect(master);
  droneOsc.start();
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  if (ac && master) master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ac.currentTime, 0.04);
  return muted;
}

/** One enveloped oscillator note, optionally sliding between two pitches. */
function tone(
  startHz: number,
  endHz: number,
  duration: number,
  type: OscillatorType,
  peak: number,
  delay = 0,
): void {
  if (!ac || !master) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(startHz, t0);
  if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), t0 + duration);
  // A few ms of attack instead of an instant jump -- a hard start on a gain
  // node is an audible click, which reads as a bug rather than a sound.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.012, duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(context.sampleRate * 0.6);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

/** A filtered white-noise hit -- the percussive half of impacts. */
function noiseBurst(duration: number, peak: number, fromHz: number, toHz: number, delay = 0): void {
  if (!ac || !master) return;
  const t0 = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac);
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(fromHz, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), t0 + duration);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(gain).connect(master);
  src.start(t0);
  src.stop(t0 + duration + 0.03);
}

/**
 * Plays one frame's events. The eat blip climbs a semitone per chained bite,
 * which is the cheapest possible way to make a combo *felt* -- the player
 * hears the streak building without ever reading the multiplier.
 */
export function playEvents(events: readonly GameEvent[]): void {
  if (!ac || muted) return;
  for (const e of events) {
    switch (e.kind) {
      case "eat": {
        const semitones = Math.min(e.combo - 1, 14);
        const hz = 430 * Math.pow(2, semitones / 12);
        tone(hz, hz * 1.05, 0.085, "triangle", 0.15);
        break;
      }
      case "crush":
        noiseBurst(0.24, 0.3, 1400, 160);
        tone(190, 58, 0.28, "sawtooth", 0.2);
        break;
      case "powerup":
        tone(523, 523, 0.1, "triangle", 0.14);
        tone(784, 784, 0.1, "triangle", 0.14, 0.08);
        tone(1046, 1046, 0.18, "triangle", 0.13, 0.16);
        break;
      case "spawn":
        tone(120, 62, 0.9, "sawtooth", 0.2);
        noiseBurst(0.6, 0.14, 500, 90);
        break;
      case "death":
        tone(330, 44, 0.75, "sawtooth", 0.26);
        noiseBurst(0.5, 0.28, 1800, 120);
        break;
      case "win":
        [523, 659, 784, 1046].forEach((hz, i) => tone(hz, hz, 0.3, "triangle", 0.16, i * 0.09));
        break;
    }
  }
}

/**
 * Rides the chase drone from the live game state -- the only sound that isn't
 * event-driven, because "how close is it right now" is a continuous fact.
 * setTargetAtTime rather than a hard set so it swells and fades instead of
 * stepping once per frame.
 */
export function updateAudio(state: GameState): void {
  if (!ac || !droneGain || !droneOsc) return;
  const gap = chaseThreatDistance(state);
  const proximity = Number.isFinite(gap) ? Math.max(0, 1 - gap / 320) : 0;
  const target = state.status === "playing" ? proximity * proximity * 0.5 : 0;
  droneGain.gain.setTargetAtTime(target, ac.currentTime, 0.15);
  droneOsc.frequency.setTargetAtTime(52 + proximity * 34, ac.currentTime, 0.25);
}
