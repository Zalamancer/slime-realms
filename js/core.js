// core.js — shared state, event bus, math helpers.
// Every module imports from here. See CONTRACT.md for the full integration spec.
import * as THREE from 'three';

export const G = {
  // three.js basics (set by main.js before any init* runs)
  scene: null,
  camera: null,
  renderer: null,
  canvas: null,

  // gameplay state
  player: null,   // created by progression.initProgression(); mesh attached by player.initPlayer()
  enemies: [],    // managed by enemies.js
  bots: [],       // managed by bots.js
  party: [],      // bot objects recruited into the player's party (max 3) — managed by party.js
  time: 0,        // seconds since boot
  started: false, // true once 'game:start' init completed
  paused: false,  // ui.js sets true while a fullscreen panel (skill tree / help) is open
  chatFocus: false, // ui.js sets true while the chat input is focused
  shake: 0,       // screen shake amount; combat/enemies add to it, player.js applies + decays

  // raw input (written by main.js; consumed per CONTRACT.md)
  keys: {},        // keys['KeyW'] === true while held
  keysPressed: {}, // true only on the frame the key went down (main.js clears each frame)
  mouse: {
    down: false, rdown: false,        // buttons currently held
    clicked: false, rclicked: false,  // frame flags (main.js clears each frame)
    mx: 0, my: 0,                     // accumulated drag deltas; player.js consumes and zeroes
    wheel: 0,                         // accumulated wheel delta; player.js consumes and zeroes
  },
};

// debug/testing hook (harmless in production)
if (typeof window !== 'undefined') window.__SLIME_G = G;

// ---- event bus ----
const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, []);
  listeners.get(evt).push(fn);
}

export function emit(evt, data) {
  const fns = listeners.get(evt);
  if (fns) for (const fn of fns.slice()) fn(data);
}

// ---- helpers ----
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const dist2d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
