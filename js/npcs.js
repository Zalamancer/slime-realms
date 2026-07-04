// npcs.js — ambient island life: animals (bunnies, butterflies, birds, frogs,
// snails) and friendly humans (villagers, Merchant Bo, patrolling adventurers).
// Imports allowed: three, core, world (terrainHeight, WATER_LEVEL),
// combat (spawnBurst, playSound). No slime.js dependency — all meshes are
// built here from shared module-level geometries/materials, flat shaded.
// Humans are invulnerable, non-colliding, and never appear in G.enemies/G.bots.
import * as THREE from 'three';
import { G, clamp, lerp, rand } from './core.js';
import { terrainHeight, WATER_LEVEL } from './world.js';
import { spawnBurst, playSound } from './combat.js';

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// module state (filled in initNPCs — nothing touches G.scene/DOM at import)
// ---------------------------------------------------------------------------

let inited = false;

const bunnies = [];
const butterflies = [];
const birds = [];
const frogs = [];
const snails = [];
const villagers = [];   // strolling plaza folk (4)
let merchant = null;    // Merchant Bo (stands at his stall)
const adventurers = []; // sword-swinging patrol heroes (3)

// scratch (zero per-frame allocations in hot loops)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// deterministic placement RNG (world.js style) — behaviors use Math.random
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// shared geometry / material caches (built lazily inside initNPCs)
// ---------------------------------------------------------------------------

let GEO = null;
const _lamberts = new Map(); // color -> MeshLambertMaterial (flat shaded)
const _basics = new Map();   // color -> MeshBasicMaterial (tiny unlit bits)

function lam(color) {
  let m = _lamberts.get(color);
  if (!m) { m = new THREE.MeshLambertMaterial({ color, flatShading: true }); _lamberts.set(color, m); }
  return m;
}

function lamDS(color) { // double-sided lambert (butterfly wings, awning uses its own)
  const key = color ^ 0x1000000;
  let m = _basics.get(key);
  if (!m) { m = new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide }); _basics.set(key, m); }
  return m;
}

function bas(color) {
  let m = _basics.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); _basics.set(color, m); }
  return m;
}

function buildSharedGeos() {
  if (GEO) return;
  const sphere = new THREE.SphereGeometry(1, 8, 6);   // generic unit blob (scaled per mesh)
  const sphereLo = new THREE.SphereGeometry(1, 6, 5); // cheaper unit blob

  // bunny ear — origin at the base so rotation.x lays it back
  const bunnyEar = new THREE.SphereGeometry(1, 6, 5);
  bunnyEar.scale(0.05, 0.21, 0.032);
  bunnyEar.translate(0, 0.17, 0);

  // butterfly wings — flat planes hinged at the body (rotation.z flaps)
  const wingR = new THREE.PlaneGeometry(0.27, 0.19);
  wingR.rotateX(-Math.PI / 2);
  wingR.translate(0.15, 0, 0);
  const wingL = new THREE.PlaneGeometry(0.27, 0.19);
  wingL.rotateX(-Math.PI / 2);
  wingL.translate(-0.15, 0, 0);

  // bird wings — slim boxes hinged at the body (rotation.z flaps/folds)
  const bWingR = new THREE.BoxGeometry(0.24, 0.018, 0.13);
  bWingR.translate(0.14, 0, 0);
  const bWingL = new THREE.BoxGeometry(0.24, 0.018, 0.13);
  bWingL.translate(-0.14, 0, 0);
  const beak = new THREE.ConeGeometry(0.032, 0.09, 4);
  beak.rotateX(Math.PI / 2); // points +z
  const birdTail = new THREE.BoxGeometry(0.08, 0.015, 0.13);
  birdTail.translate(0, 0, -0.06);

  // snail
  const snailShell = new THREE.TorusGeometry(0.085, 0.05, 6, 10);
  snailShell.rotateY(Math.PI / 2); // ring plane contains the travel axis
  const snailStalk = new THREE.CylinderGeometry(0.008, 0.013, 0.095, 4);
  snailStalk.translate(0, 0.0475, 0);

  // humans — limbs pivot at the hip/shoulder (geometry hangs below origin)
  const leg = new THREE.BoxGeometry(0.13, 0.34, 0.13);
  leg.translate(0, -0.17, 0);
  const arm = new THREE.BoxGeometry(0.09, 0.3, 0.09);
  arm.translate(0, -0.15, 0);
  const torso = new THREE.BoxGeometry(0.34, 0.36, 0.2);
  const head = new THREE.BoxGeometry(0.22, 0.2, 0.2);
  const hair = new THREE.BoxGeometry(0.24, 0.09, 0.22);
  const hatCone = new THREE.ConeGeometry(0.155, 0.13, 7);
  const hatBrim = new THREE.CylinderGeometry(0.24, 0.26, 0.025, 8);

  // sword (child of the right arm; hangs blade-down from the hand)
  const blade = new THREE.BoxGeometry(0.05, 0.52, 0.018);
  blade.translate(0, -0.31, 0);
  const guard = new THREE.BoxGeometry(0.15, 0.03, 0.045);
  guard.translate(0, -0.06, 0);

  // market stall
  const stallPost = new THREE.CylinderGeometry(0.05, 0.065, 1.6, 5);
  const stallCounter = new THREE.BoxGeometry(2.1, 0.5, 0.7);
  const awning = new THREE.PlaneGeometry(2.5, 1.25, 6, 1);
  // vertex-color stripes (rose / cream) — no canvas texture needed
  {
    const posA = awning.attributes.position;
    const cols = new Float32Array(posA.count * 3);
    const cA = new THREE.Color(0xe86a72), cB = new THREE.Color(0xfdf3e3);
    for (let i = 0; i < posA.count; i++) {
      const col = Math.round((posA.getX(i) / 2.5 + 0.5) * 6);
      const c = col % 2 === 0 ? cA : cB;
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    awning.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  }

  GEO = {
    sphere, sphereLo, bunnyEar, wingR, wingL, bWingR, bWingL, beak, birdTail,
    snailShell, snailStalk, leg, arm, torso, head, hair, hatCone, hatBrim,
    blade, guard, stallPost, stallCounter, awning,
  };
}

// ---------------------------------------------------------------------------
// gold NPC name tag — replicates slime.js's makeNameTag pill style locally
// (dark translucent pill, 3x supersample for crispness). DOM use is init-only.
// ---------------------------------------------------------------------------

const FONT = "'Trebuchet MS','Comic Sans MS','Segoe UI',sans-serif";

function pillPath(ctx, x, y, w, h, r) {
  w = Math.max(w, 0.001); h = Math.max(h, 0.001);
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeGoldTag(text, sub = '') {
  const SS = 3; // supersample
  const mainPx = 34, subPx = 21, padX = 20, padY = 9, gap = 5;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `700 ${mainPx * SS}px ${FONT}`;
  let textW = ctx.measureText(text).width / SS;
  if (sub) {
    ctx.font = `600 ${subPx * SS}px ${FONT}`;
    textW = Math.max(textW, ctx.measureText(sub).width / SS);
  }
  const w = Math.ceil(textW + padX * 2);
  const h = Math.ceil(mainPx + (sub ? gap + subPx : 0) + padY * 2);
  canvas.width = w * SS;
  canvas.height = h * SS;
  ctx.scale(SS, SS);

  pillPath(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.fillStyle = 'rgba(15,19,32,0.64)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,216,122,0.32)'; // faint gold rim — reads as "NPC"
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  ctx.font = `700 ${mainPx}px ${FONT}`;
  ctx.fillStyle = '#ffd87a'; // classic NPC gold
  ctx.fillText(text, w / 2, padY + mainPx / 2 + 1);
  if (sub) {
    ctx.font = `600 ${subPx}px ${FONT}`;
    ctx.fillStyle = 'rgba(244,228,190,0.88)';
    ctx.fillText(sub, w / 2, padY + mainPx + gap + subPx / 2 + 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  const worldW = clamp(w * 0.0095, 1.9, 2.9);
  sprite.scale.set(worldW, (worldW * h) / w, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

const isWater = (x, z) => terrainHeight(x, z) < WATER_LEVEL + 0.35;

// shortest-arc yaw step (no wrap pops)
function turnYaw(cur, target, maxStep) {
  let d = (target - cur) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  if (d > maxStep) d = maxStep;
  else if (d < -maxStep) d = -maxStep;
  return cur + d;
}

// squared distance to the nearest "threat" (player or any bot) — early-out free,
// but it's all scalar math so a full scan of ~25 entries is trivially cheap.
function nearestThreatSq(x, z) {
  let best = Infinity;
  const p = G.player;
  if (p && p.group) {
    const dx = p.group.position.x - x, dz = p.group.position.z - z;
    best = dx * dx + dz * dz;
  }
  const bots = G.bots;
  for (let i = 0; i < bots.length; i++) {
    const g = bots[i].group;
    if (!g) continue;
    const dx = g.position.x - x, dz = g.position.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

// rejection-sample one ambient-animal spot with the seeded rng
function findSpot(rng, rMin, rMax, hMax) {
  for (let i = 0; i < 60; i++) {
    const a = rng() * TWO_PI;
    const r = rMin + rng() * (rMax - rMin);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < WATER_LEVEL + 0.45 || h > hMax) continue;
    if (Math.hypot(x + 70, z - 40) < 30) continue;   // lake + shore
    if (Math.hypot(x, z - 92) < 21) continue;        // arena
    if (Math.abs(x) > 80 && Math.abs(z) > 80) continue; // crystal corners
    return { x, z };
  }
  return { x: rMin + 4, z: 0 };
}

// ===========================================================================
// ANIMAL BUILDERS
// ===========================================================================

const BUNNY_FURS = [0xf1e3cf, 0xddc9b2, 0xc4b5a6, 0xfaf3e6];

function makeBunny(x, z, fur) {
  const root = new THREE.Group();
  const furMat = lam(fur);

  const body = new THREE.Mesh(GEO.sphere, furMat);
  body.scale.set(0.21, 0.17, 0.27);
  body.position.y = 0.18;
  body.castShadow = true;
  root.add(body);

  const head = new THREE.Mesh(GEO.sphereLo, furMat);
  head.scale.set(0.13, 0.12, 0.13);
  head.position.set(0, 0.34, 0.2);
  root.add(head);

  const earL = new THREE.Mesh(GEO.bunnyEar, furMat);
  earL.position.set(-0.055, 0.43, 0.17);
  earL.rotation.set(-0.12, 0, 0.14);
  root.add(earL);

  const earR = new THREE.Mesh(GEO.bunnyEar, furMat);
  earR.position.set(0.055, 0.43, 0.17);
  earR.rotation.set(-0.12, 0, -0.14);
  root.add(earR);

  const tail = new THREE.Mesh(GEO.sphereLo, lam(0xfffbf0));
  tail.scale.setScalar(0.07);
  tail.position.set(0, 0.21, -0.26);
  root.add(tail);

  root.position.set(x, terrainHeight(x, z), z);
  root.rotation.y = Math.random() * TWO_PI;
  G.scene.add(root);

  return {
    root, head, earL, earR,
    x, z, yaw: root.rotation.y,
    st: 0,                 // 0 idle/nibble · 1 relocation hop · 2 fleeing
    idleT: rand(1.5, 5),
    hopsLeft: 0,
    hopT: 0, hopDur: 0.4, hopH: 0.28,
    fx: x, fz: z, tx: x, tz: z, fh: 0, th: 0,
    earLay: 0,
    phase: Math.random() * TWO_PI,
  };
}

// pick a hop destination; deflects away from water / world edge
function bunnyAimHop(b, dirX, dirZ, len) {
  let dx = dirX, dz = dirZ;
  for (let i = 0; i < 3; i++) {
    const tx = b.x + dx * len, tz = b.z + dz * len;
    if (Math.abs(tx) < 112 && Math.abs(tz) < 112 && !isWater(tx, tz)) {
      b.tx = tx; b.tz = tz;
      b.fx = b.x; b.fz = b.z;
      b.fh = terrainHeight(b.fx, b.fz);
      b.th = terrainHeight(tx, tz);
      return true;
    }
    // rotate the heading ~110° and retry
    const nx = dx * -0.342 - dz * 0.94;
    dz = dx * 0.94 + dz * -0.342;
    dx = nx;
  }
  return false;
}

const BFLY_COLORS = [0xf7a8c4, 0xc9aef7, 0xa8e6c8, 0xf7d488];

function makeButterfly(x, z, color) {
  const root = new THREE.Group();
  const wingMat = lamDS(color);

  const wingR = new THREE.Mesh(GEO.wingR, wingMat);
  const wingL = new THREE.Mesh(GEO.wingL, wingMat);
  root.add(wingR, wingL);

  const body = new THREE.Mesh(GEO.sphereLo, bas(0x3a3346));
  body.scale.set(0.024, 0.024, 0.085);
  root.add(body);

  root.position.set(x, terrainHeight(x, z) + 1, z);
  G.scene.add(root);

  return {
    root, wingR, wingL,
    ax: x, az: z,                              // anchor (near flowers)
    r1: rand(1.6, 3.4), r2: rand(1.2, 3.0),    // wander ellipse
    w1: rand(0.25, 0.45),                      // loop speed
    flapW: rand(11, 16),
    phase: Math.random() * TWO_PI,
    px: x, pz: z, yaw: 0,
  };
}

const BIRD_COLORS = [0x7bbce0, 0xf2a7b8, 0xf5d77a];

function makeBird(color) {
  const root = new THREE.Group();
  const tilt = new THREE.Group(); // pitch (peck) + roll (banking)
  root.add(tilt);
  const mat = lam(color);

  const body = new THREE.Mesh(GEO.sphere, mat);
  body.scale.set(0.11, 0.11, 0.17);
  tilt.add(body);

  const beak = new THREE.Mesh(GEO.beak, lam(0xf0a050));
  beak.position.set(0, 0.01, 0.19);
  tilt.add(beak);

  const wingR = new THREE.Mesh(GEO.bWingR, mat);
  wingR.position.set(0.06, 0.04, 0);
  tilt.add(wingR);

  const wingL = new THREE.Mesh(GEO.bWingL, mat);
  wingL.position.set(-0.06, 0.04, 0);
  tilt.add(wingL);

  const tail = new THREE.Mesh(GEO.birdTail, mat);
  tail.position.set(0, 0.03, -0.15);
  tail.rotation.x = 0.25;
  tilt.add(tail);

  G.scene.add(root);

  const b = {
    root, tilt, wingR, wingL,
    st: 0,                 // 0 fly · 1 land(descend) · 2 ground · 3 takeoff
    cx: rand(-40, 40), cz: rand(-40, 40),
    radius: rand(18, 32),
    ang: Math.random() * TWO_PI,
    angVel: (Math.random() < 0.5 ? -1 : 1) * rand(0.12, 0.24),
    alt: rand(9, 17),      // base altitude (spec: 8–18)
    flyT: rand(10, 30),    // until it considers landing
    groundT: 0,
    tx: 0, tz: 0,
    yaw: 0, flap: 0, roll: 0,
    phase: Math.random() * TWO_PI,
    flapW: rand(7, 10),
  };
  // start mid-arc
  b.root.position.set(b.cx + Math.cos(b.ang) * b.radius, b.alt, b.cz + Math.sin(b.ang) * b.radius);
  return b;
}

function birdFindSpot(b) {
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * TWO_PI;
    const r = 24 + Math.random() * 30;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < WATER_LEVEL + 0.5 || h > 6.5) continue;
    if (Math.hypot(x + 70, z - 40) < 30) continue;
    if (Math.hypot(x, z - 92) < 21) continue;
    b.tx = x; b.tz = z;
    return true;
  }
  return false;
}

// rebuild the flight circle through the bird's current position
function birdNewArc(b) {
  const a = Math.random() * TWO_PI;
  b.radius = rand(16, 30);
  b.angVel = (Math.random() < 0.5 ? -1 : 1) * rand(0.12, 0.24);
  b.ang = a;
  b.cx = clamp(b.root.position.x - Math.cos(a) * b.radius, -85, 85);
  b.cz = clamp(b.root.position.z - Math.sin(a) * b.radius, -85, 85);
  b.alt = rand(9, 17);
  b.flyT = rand(14, 36);
}

function makeFrog(x, z, green) {
  const root = new THREE.Group();
  const mat = lam(green);

  const body = new THREE.Mesh(GEO.sphere, mat);
  body.scale.set(0.17, 0.115, 0.2);
  body.position.y = 0.105;
  body.castShadow = true;
  root.add(body);

  const bumpL = new THREE.Mesh(GEO.sphereLo, mat);
  bumpL.scale.setScalar(0.05);
  bumpL.position.set(-0.075, 0.215, 0.1);
  root.add(bumpL);

  const bumpR = new THREE.Mesh(GEO.sphereLo, mat);
  bumpR.scale.setScalar(0.05);
  bumpR.position.set(0.075, 0.215, 0.1);
  root.add(bumpR);

  const pupL = new THREE.Mesh(GEO.sphereLo, bas(0x1c2418));
  pupL.scale.setScalar(0.02);
  pupL.position.set(-0.075, 0.235, 0.14);
  root.add(pupL);

  const pupR = new THREE.Mesh(GEO.sphereLo, bas(0x1c2418));
  pupR.scale.setScalar(0.02);
  pupR.position.set(0.075, 0.235, 0.14);
  root.add(pupR);

  root.position.set(x, terrainHeight(x, z), z);
  root.rotation.y = Math.random() * TWO_PI;
  G.scene.add(root);

  return {
    root, body,
    x, z, yaw: root.rotation.y,
    st: 0, // 0 sit · 1 hop
    sitT: rand(2, 7),
    hopT: 0, hopDur: 0.32, hopH: 0.38,
    fx: x, fz: z, tx: x, tz: z, fh: 0, th: 0,
    ang: Math.atan2(z - 40, x + 70), // shore-ring angle around the lake center
    phase: Math.random() * TWO_PI,
  };
}

// next frog hop target: stay on the lake-shore ring (~24–28), on land
function frogAimHop(f) {
  for (let i = 0; i < 5; i++) {
    const a = f.ang + rand(-0.45, 0.45);
    const r = rand(24.5, 27.5);
    const x = -70 + Math.cos(a) * r;
    const z = 40 + Math.sin(a) * r;
    if (terrainHeight(x, z) < WATER_LEVEL + 0.2) continue;
    f.tx = x; f.tz = z;
    f.fx = f.x; f.fz = f.z;
    f.fh = terrainHeight(f.fx, f.fz);
    f.th = terrainHeight(x, z);
    f.ang = a;
    return true;
  }
  return false;
}

function makeSnail(x, z) {
  const root = new THREE.Group();
  const bodyMat = lam(0xd8c49a);

  const shell = new THREE.Mesh(GEO.snailShell, lam(0xc9956b));
  shell.position.set(0, 0.125, -0.03);
  root.add(shell);

  const body = new THREE.Mesh(GEO.sphere, bodyMat);
  body.scale.set(0.06, 0.045, 0.15);
  body.position.y = 0.045;
  root.add(body);

  const stalkL = new THREE.Mesh(GEO.snailStalk, bodyMat);
  stalkL.position.set(-0.028, 0.075, 0.115);
  root.add(stalkL);

  const stalkR = new THREE.Mesh(GEO.snailStalk, bodyMat);
  stalkR.position.set(0.028, 0.075, 0.115);
  root.add(stalkR);

  root.position.set(x, terrainHeight(x, z), z);
  root.rotation.y = Math.random() * TWO_PI;
  G.scene.add(root);

  return {
    root, stalkL, stalkR,
    x, z, yaw: root.rotation.y,
    phase: Math.random() * TWO_PI,
  };
}

// ===========================================================================
// HUMAN BUILDER (blocky low-poly villager ~7 meshes; +2 for a sword)
// ===========================================================================

function makeHuman({ name, sub, tunic, hairColor = 0x5b4632, strawHat = false, height = 1.0, sword = false }) {
  const root = new THREE.Group();
  const bob = new THREE.Group(); // walk-cycle body bob lives here
  root.add(bob);

  const skinMat = lam(0xf0c8a0);
  const legMat = lam(0x6b5340);

  const legL = new THREE.Mesh(GEO.leg, legMat);
  legL.position.set(-0.085, 0.34, 0);
  bob.add(legL);

  const legR = new THREE.Mesh(GEO.leg, legMat);
  legR.position.set(0.085, 0.34, 0);
  bob.add(legR);

  const torso = new THREE.Mesh(GEO.torso, lam(tunic));
  torso.position.y = 0.52;
  torso.castShadow = true;
  bob.add(torso);

  const head = new THREE.Mesh(GEO.head, skinMat);
  head.position.y = 0.81;
  bob.add(head);

  if (strawHat) {
    const cone = new THREE.Mesh(GEO.hatCone, lam(0xe6c97a));
    cone.position.y = 0.985;
    bob.add(cone);
    const brim = new THREE.Mesh(GEO.hatBrim, lam(0xd9b964));
    brim.position.y = 0.915;
    bob.add(brim);
  } else {
    const cap = new THREE.Mesh(GEO.hair, lam(hairColor));
    cap.position.y = 0.935;
    bob.add(cap);
  }

  const armL = new THREE.Mesh(GEO.arm, skinMat);
  armL.position.set(-0.215, 0.67, 0);
  armL.rotation.z = -0.08;
  bob.add(armL);

  const armR = new THREE.Mesh(GEO.arm, skinMat);
  armR.position.set(0.215, 0.67, 0);
  armR.rotation.z = 0.08;
  bob.add(armR);

  if (sword) {
    const blade = new THREE.Mesh(GEO.blade, lam(0xd3dae3));
    blade.position.set(0.02, -0.3, 0.04);
    armR.add(blade);
    const guard = new THREE.Mesh(GEO.guard, lam(0x8a6a4e));
    guard.position.set(0.02, -0.24, 0.04);
    armR.add(guard);
  }

  const tag = makeGoldTag(name, sub);
  tag.position.y = 1.16;
  root.add(tag);

  root.scale.setScalar(height);
  G.scene.add(root);

  return {
    root, bob, legL, legR, armL, armR,
    yaw: 0, phase: Math.random() * TWO_PI,
  };
}

// relax limbs toward the rest pose (used when standing still)
function relaxLimbs(h, dt) {
  const k = Math.exp(-dt * 8);
  h.legL.rotation.x *= k;
  h.legR.rotation.x *= k;
  h.armL.rotation.x *= k;
  h.bob.position.y *= k;
}

// drive the simple limb-swing walk cycle; armRFree=false leaves armR to the caller
function walkLimbs(h, dt, speed, armRFree) {
  h.phase += dt * (4.2 + speed * 2.1);
  if (h.phase > 1e4) h.phase %= TWO_PI;
  const s = Math.sin(h.phase);
  h.legL.rotation.x = s * 0.55;
  h.legR.rotation.x = -s * 0.55;
  h.armL.rotation.x = -s * 0.38;
  if (armRFree) h.armR.rotation.x = s * 0.38;
  h.bob.position.y = Math.abs(Math.cos(h.phase)) * 0.045;
}

// ===========================================================================
// initNPCs
// ===========================================================================

export function initNPCs() {
  if (inited) return;
  inited = true;
  buildSharedGeos();

  const rng = mulberry32(0xfab1e5);

  // ---- bunnies ×10 — meadow + Whisperwood edges --------------------------
  for (let i = 0; i < 10; i++) {
    const spot = i < 7 ? findSpot(rng, 23, 50, 6.0) : findSpot(rng, 55, 64, 7.0);
    bunnies.push(makeBunny(spot.x, spot.z, BUNNY_FURS[i % BUNNY_FURS.length]));
  }

  // ---- butterflies ×8 — flowery meadow ------------------------------------
  for (let i = 0; i < 8; i++) {
    const spot = findSpot(rng, 19, 48, 5.5);
    butterflies.push(makeButterfly(spot.x, spot.z, BFLY_COLORS[i % BFLY_COLORS.length]));
  }

  // ---- birds ×6 ------------------------------------------------------------
  for (let i = 0; i < 6; i++) birds.push(makeBird(BIRD_COLORS[i % BIRD_COLORS.length]));

  // ---- frogs ×4 — lake shore ring (~24–28), on land ------------------------
  {
    let placed = 0, guard = 200;
    while (placed < 4 && guard-- > 0) {
      const a = rng() * TWO_PI;
      const r = 24.5 + rng() * 3;
      const x = -70 + Math.cos(a) * r;
      const z = 40 + Math.sin(a) * r;
      if (terrainHeight(x, z) < WATER_LEVEL + 0.2) continue;
      if (Math.abs(x) > 110 || Math.abs(z) > 110) continue;
      frogs.push(makeFrog(x, z, placed % 2 === 0 ? 0x86c860 : 0x5fa84e));
      placed++;
    }
  }

  // ---- snails ×3 — slow meadow wanderers -----------------------------------
  for (let i = 0; i < 3; i++) {
    const spot = findSpot(rng, 20, 36, 5.0);
    snails.push(makeSnail(spot.x, spot.z));
  }

  // ---- market stall + Merchant Bo (beside the houses, in the plaza) --------
  const stallA = 1.18, stallR = 10.3;
  const sx = Math.cos(stallA) * stallR, sz = Math.sin(stallA) * stallR;
  const sy = terrainHeight(sx, sz);
  const stallYaw = Math.atan2(-sx, -sz); // counter faces the plaza center
  {
    const stall = new THREE.Group();
    const wood = lam(0x8a6a4e);
    const postL = new THREE.Mesh(GEO.stallPost, wood);
    postL.position.set(-1.0, 0.8, -0.25);
    const postR = new THREE.Mesh(GEO.stallPost, wood);
    postR.position.set(1.0, 0.8, -0.25);
    const counter = new THREE.Mesh(GEO.stallCounter, lam(0xa07b58));
    counter.position.set(0, 0.5, 0.25);
    counter.castShadow = true;
    const awnMat = new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, side: THREE.DoubleSide,
    });
    const awn = new THREE.Mesh(GEO.awning, awnMat);
    awn.position.set(0, 1.62, 0.28);
    awn.rotation.x = -1.18; // slopes down toward the plaza
    awn.castShadow = true;
    stall.add(postL, postR, counter, awn);
    stall.position.set(sx, sy, sz);
    stall.rotation.y = stallYaw;
    G.scene.add(stall);
  }
  {
    const h = makeHuman({
      name: 'Merchant Bo', sub: 'Merchant', tunic: 0xd9684f,
      hairColor: 0x2e2a26, height: 1.04,
    });
    // stands behind the counter, looking across it at the plaza
    _v1.set(0, 0, -0.7).applyAxisAngle(_v2.set(0, 1, 0), stallYaw);
    const bx = sx + _v1.x, bz = sz + _v1.z;
    h.root.position.set(bx, terrainHeight(bx, bz), bz);
    h.yaw = stallYaw;
    h.root.rotation.y = stallYaw;
    merchant = { ...h, x: bx, z: bz, baseYaw: stallYaw };
  }

  // ---- villagers ×4 — stroll between the mushroom houses --------------------
  // house fronts (world.js HOUSE_ANGLES at r≈11–13.5) + a few plaza spots
  const HOUSE_ANGLES = [0.5, 1.85, 3.0, 4.2, 5.4];
  const plazaWps = [];
  for (const a of HOUSE_ANGLES) plazaWps.push([Math.cos(a) * 8.7, Math.sin(a) * 8.7]);
  plazaWps.push([2.5, 2.5], [-3.5, 1.0], [1.0, -4.0], [-1.5, 5.5], [4.0, -1.5]);

  const VILLAGER_DEFS = [
    { name: 'Poppy', sub: 'Villager', tunic: 0xe07856, hairColor: 0xc7b08a, height: 0.97 },
    { name: 'Old Tom', sub: 'Villager', tunic: 0xb98a4e, strawHat: true, height: 1.0 },
    { name: 'Hazel', sub: 'Villager', tunic: 0xc96a6a, hairColor: 0x8a4f33, height: 0.95 },
    { name: 'Bram', sub: 'Villager', tunic: 0xd9a04b, strawHat: true, height: 1.08 },
  ];
  for (let i = 0; i < VILLAGER_DEFS.length; i++) {
    const h = makeHuman(VILLAGER_DEFS[i]);
    const wp = plazaWps[(i * 2 + 1) % plazaWps.length];
    h.root.position.set(wp[0], terrainHeight(wp[0], wp[1]), wp[1]);
    villagers.push({
      ...h,
      wps: plazaWps,
      wpIdx: (i * 2 + 1) % plazaWps.length,
      mode: 0,               // 0 pause · 1 walk
      pauseT: rand(1, 4),
      waveT: 0, waveAt: -1,
      speed: rand(1.3, 1.7),
    });
  }

  // ---- adventurers ×3 — long patrol loops plaza → fields → Whisperwood ------
  const ADV_DEFS = [
    {
      name: 'Sir Reginald ⚔', tunic: 0x8c9bb5, hairColor: 0xc7b08a, height: 1.16,
      route: [[2, 8], [4, 18], [14, 32], [30, 46], [52, 60], [64, 34], [44, 10], [18, -2]],
    },
    {
      name: 'Scout Fen 🏹', tunic: 0x7da45c, hairColor: 0x9c5b3c, height: 1.06,
      route: [[-4, 7], [-18, 16], [-36, 4], [-58, -14], [-44, -42], [-20, -32], [-6, -12]],
    },
    {
      name: 'Mira the Bold 🗡', tunic: 0xb5485a, hairColor: 0x2e2a26, height: 1.1,
      route: [[6, -6], [24, -20], [46, -38], [66, -58], [34, -62], [10, -34]],
    },
  ];
  for (let i = 0; i < ADV_DEFS.length; i++) {
    const d = ADV_DEFS[i];
    const h = makeHuman({
      name: d.name, sub: 'Adventurer', tunic: d.tunic,
      hairColor: d.hairColor, height: d.height, sword: true,
    });
    const start = d.route[0];
    h.root.position.set(start[0], terrainHeight(start[0], start[1]), start[1]);
    h.armR.rotation.x = -0.35; // sword carried at the side, slightly forward
    adventurers.push({
      ...h,
      route: d.route,
      wpIdx: 1,
      target: null,          // engaged enemy
      swingT: 0,             // until next theatrical swing
      animT: -1,             // swing animation clock (-1 = not swinging)
      impactDone: false,
      ax: start[0], az: start[1], // anchor while fighting (lunge returns here)
    });
  }
}

// ===========================================================================
// per-type updates
// ===========================================================================

function updateBunnies(dt) {
  const t = G.time;
  for (let i = 0; i < bunnies.length; i++) {
    const b = bunnies[i];
    const threatSq = nearestThreatSq(b.x, b.z);

    // flee / calm transitions (4u panic, 9u calm — hysteresis)
    if (b.st !== 2 && threatSq < 16) {
      if (b.st === 0) b.hopT = 999; // sitting — bolt into a flee hop right now
      b.st = 2;                     // mid-hop — finish the hop, then flee
    } else if (b.st === 2 && threatSq > 81) {
      b.st = 0;
      b.idleT = rand(1, 3);
      b.hopsLeft = 0;
      // forget any interrupted hop: settle exactly where the bunny is rendered,
      // otherwise the next hop snaps it from mid-arc to the stale hop target
      b.x = b.tx = b.root.position.x;
      b.z = b.tz = b.root.position.z;
      b.hopT = 0;
    }

    // ears: laid back while fleeing
    const earTarget = b.st === 2 ? 1 : 0;
    b.earLay += (earTarget - b.earLay) * Math.min(1, dt * 10);
    b.earL.rotation.x = -0.12 - b.earLay * 1.15;
    b.earR.rotation.x = -0.12 - b.earLay * 1.15;

    if (b.st === 0) {
      // idle — nibbling head dips
      const nib = Math.sin(t * 1.1 + b.phase);
      const dip = nib > 0.45 ? (nib - 0.45) * 0.22 : 0;
      b.head.position.y = 0.34 - dip;
      b.head.position.z = 0.2 + dip * 0.35;
      b.root.position.y = terrainHeight(b.x, b.z);

      b.idleT -= dt;
      if (b.idleT <= 0) {
        // relocate with a short chain of casual hops
        b.hopsLeft = 1 + ((Math.random() * 3) | 0);
        b.st = 1;
        b.hopT = b.hopDur;
      }
    }

    if (b.st === 1 || b.st === 2) {
      const fleeing = b.st === 2;
      b.hopT += dt;

      if (b.hopT >= b.hopDur) {
        // land the previous hop
        b.x = b.tx; b.z = b.tz;
        b.hopT = 0;

        // aim the next hop
        let dx, dz;
        if (fleeing) {
          // directly away from the player (bots count too, but the player
          // reference keeps the flee direction stable & readable)
          let tx = 0, tz = 0, got = false;
          const p = G.player;
          if (p && p.group) { tx = p.group.position.x; tz = p.group.position.z; got = true; }
          if (!got && G.bots.length && G.bots[0].group) {
            tx = G.bots[0].group.position.x; tz = G.bots[0].group.position.z;
          }
          const ax = b.x - tx, az = b.z - tz;
          const al = Math.hypot(ax, az) || 1;
          const jig = (Math.random() - 0.5) * 0.7;
          const c = Math.cos(jig), s = Math.sin(jig);
          dx = (ax / al) * c - (az / al) * s;
          dz = (ax / al) * s + (az / al) * c;
        } else {
          const a = Math.random() * TWO_PI;
          dx = Math.sin(a); dz = Math.cos(a);
          if (--b.hopsLeft <= 0) {
            b.st = 0;
            b.idleT = rand(2, 7);
            b.root.position.set(b.x, terrainHeight(b.x, b.z), b.z);
            continue;
          }
        }
        if (!bunnyAimHop(b, dx, dz, fleeing ? rand(1.5, 2.1) : rand(0.7, 1.1))) {
          // boxed in — just sit
          b.st = 0;
          b.idleT = rand(1, 3);
          continue;
        }
        // hop tempo fixed per-hop (changing it mid-flight would pop)
        b.hopDur = fleeing ? 0.26 : 0.4;
        b.hopH = fleeing ? 0.42 : 0.28;
        b.yaw = Math.atan2(b.tx - b.x, b.tz - b.z);
      }

      const k = Math.min(1, b.hopT / b.hopDur);
      b.root.position.set(
        lerp(b.fx, b.tx, k),
        lerp(b.fh, b.th, k) + Math.sin(k * Math.PI) * b.hopH,
        lerp(b.fz, b.tz, k)
      );
      b.head.position.y = 0.34; // head up while hopping
      b.head.position.z = 0.2;
    }

    b.root.rotation.y = turnYaw(b.root.rotation.y, b.yaw, dt * 12);
  }
}

function updateButterflies(dt) {
  const t = G.time;
  for (let i = 0; i < butterflies.length; i++) {
    const f = butterflies[i];
    const x = f.ax + Math.cos(t * f.w1 + f.phase) * f.r1;
    const z = f.az + Math.sin(t * f.w1 * 0.83 + f.phase * 1.7) * f.r2;
    const y = terrainHeight(x, z) + 1.0 + Math.sin(t * 0.9 + f.phase) * 0.5; // 0.5–1.5u up
    f.root.position.set(x, y, z);

    // face travel direction
    const dx = x - f.px, dz = z - f.pz;
    if (dx * dx + dz * dz > 1e-8) f.yaw = Math.atan2(dx, dz);
    f.root.rotation.y = turnYaw(f.root.rotation.y, f.yaw, dt * 6);
    f.px = x; f.pz = z;

    // flap via rotation.z
    const flap = Math.sin(t * f.flapW + f.phase) * 1.0 + 0.12;
    f.wingR.rotation.z = flap;
    f.wingL.rotation.z = -flap;
  }
}

function updateBirds(dt) {
  const t = G.time;
  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    const pos = b.root.position;
    let flapTarget = 0, rollTarget = 0, pitch = 0;

    if (b.st === 0) {
      // wide lazy arcs with banking
      b.ang += b.angVel * dt;
      const px = b.cx + Math.cos(b.ang) * b.radius;
      const pz = b.cz + Math.sin(b.ang) * b.radius;
      let py = b.alt + Math.sin(t * 0.5 + b.phase) * 2.2;
      const minY = terrainHeight(px, pz) + 3;
      if (py < minY) py = minY;
      pos.set(px, py, pz);

      const sgn = b.angVel >= 0 ? 1 : -1;
      b.yaw = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      rollTarget = -0.42 * sgn;
      flapTarget = Math.sin(t * b.flapW + b.phase) * 0.65 - 0.1;

      b.flyT -= dt;
      if (b.flyT <= 0) {
        if (birdFindSpot(b)) b.st = 1;
        else b.flyT = rand(4, 9);
      }
    } else if (b.st === 1) {
      // glide down to the landing spot
      const dx = b.tx - pos.x, dz = b.tz - pos.z;
      const d = Math.hypot(dx, dz);
      const gy = terrainHeight(b.tx, b.tz) + 0.12;
      if (d > 0.5) {
        const sp = Math.min(7, d * 2 + 1.5) * dt;
        pos.x += (dx / d) * Math.min(sp, d);
        pos.z += (dz / d) * Math.min(sp, d);
        b.yaw = Math.atan2(dx, dz);
      }
      pos.y += (gy - pos.y) * Math.min(1, dt * 1.6);
      // long approaches cross hills: skim the terrain instead of tunneling through it
      const floorY = terrainHeight(pos.x, pos.z) + 0.12;
      if (pos.y < floorY) pos.y = floorY;
      flapTarget = Math.sin(t * (b.flapW * 0.7) + b.phase) * 0.45;
      if (d < 0.6 && Math.abs(pos.y - gy) < 0.25) {
        pos.set(b.tx, gy, b.tz);
        b.st = 2;
        b.groundT = rand(6, 13);
      }
    } else if (b.st === 2) {
      // grounded — peck about; flush if anything comes within 3u
      pos.y = terrainHeight(pos.x, pos.z) + 0.12;
      const p = Math.sin(t * 2.3 + b.phase);
      pitch = p > 0.5 ? (p - 0.5) * 1.5 : 0;
      flapTarget = -0.5; // wings folded
      b.groundT -= dt;
      if (b.groundT <= 0 || nearestThreatSq(pos.x, pos.z) < 9) {
        b.st = 3;
        b.alt = rand(9, 17);
      }
    } else {
      // takeoff — climb forward until cruise altitude
      pos.x += Math.sin(b.yaw) * 6.5 * dt;
      pos.z += Math.cos(b.yaw) * 6.5 * dt;
      pos.y += 4.5 * dt;
      flapTarget = Math.sin(t * (b.flapW * 1.6) + b.phase) * 0.95;
      if (pos.y >= b.alt || Math.abs(pos.x) > 100 || Math.abs(pos.z) > 100) birdNewArc(b), (b.st = 0);
    }

    // smooth wing fold/flap and banking
    b.flap += (flapTarget - b.flap) * Math.min(1, dt * 10);
    b.wingR.rotation.z = b.flap;
    b.wingL.rotation.z = -b.flap;
    b.roll += (rollTarget - b.roll) * Math.min(1, dt * 3);
    b.tilt.rotation.z = b.roll;
    b.tilt.rotation.x = pitch;
    b.root.rotation.y = turnYaw(b.root.rotation.y, b.yaw, dt * 4);
  }
}

function updateFrogs(dt) {
  const t = G.time;
  for (let i = 0; i < frogs.length; i++) {
    const f = frogs[i];

    if (f.st === 0) {
      f.root.position.y = terrainHeight(f.x, f.z);
      // throat-bob: quick gulping scale pulse
      const p = Math.pow(Math.sin(t * 2.6 + f.phase) * 0.5 + 0.5, 3);
      f.body.scale.set(0.17 * (1 + p * 0.12), 0.115 * (1 - p * 0.07), 0.2 * (1 + p * 0.1));

      f.sitT -= dt;
      if (f.sitT <= 0 && frogAimHop(f)) {
        f.st = 1;
        f.hopT = 0;
        f.yaw = Math.atan2(f.tx - f.x, f.tz - f.z);
      } else if (f.sitT <= 0) {
        f.sitT = rand(1, 3); // shore too wet right now — wait
      }
    } else {
      f.hopT += dt;
      const k = Math.min(1, f.hopT / f.hopDur);
      f.root.position.set(
        lerp(f.fx, f.tx, k),
        lerp(f.fh, f.th, k) + Math.sin(k * Math.PI) * f.hopH,
        lerp(f.fz, f.tz, k)
      );
      if (k >= 1) {
        f.x = f.tx; f.z = f.tz;
        f.st = 0;
        f.sitT = rand(2.5, 8);
      }
    }

    f.root.rotation.y = turnYaw(f.root.rotation.y, f.yaw, dt * 7);
  }
}

function updateSnails(dt) {
  const t = G.time;
  for (let i = 0; i < snails.length; i++) {
    const s = snails[i];
    // heading drifts very slowly
    s.yaw += Math.sin(t * 0.13 + s.phase) * 0.12 * dt;

    const dx = Math.sin(s.yaw), dz = Math.cos(s.yaw);
    // probe ahead — turn away from water / world edge
    const px = s.x + dx * 1.2, pz = s.z + dz * 1.2;
    if (isWater(px, pz) || Math.abs(px) > 110 || Math.abs(pz) > 110) {
      s.yaw += 1.7;
    } else {
      s.x += dx * 0.15 * dt; // ~0.15 u/s creep
      s.z += dz * 0.15 * dt;
    }
    s.root.position.set(s.x, terrainHeight(s.x, s.z), s.z);
    s.root.rotation.y = s.yaw;

    // tiny eye-stalk sway
    const sway = Math.sin(t * 1.4 + s.phase) * 0.16;
    s.stalkL.rotation.z = 0.22 + sway;
    s.stalkR.rotation.z = -0.22 + sway * 0.7;
    s.stalkL.rotation.x = Math.sin(t * 1.1 + s.phase * 2) * 0.1 - 0.15;
    s.stalkR.rotation.x = Math.cos(t * 1.2 + s.phase) * 0.1 - 0.15;
  }
}

function updateVillagers(dt) {
  const t = G.time;
  for (let i = 0; i < villagers.length; i++) {
    const v = villagers[i];
    const pos = v.root.position;

    if (v.mode === 1) {
      // walking to the next waypoint
      const wp = v.wps[v.wpIdx];
      const dx = wp[0] - pos.x, dz = wp[1] - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.45) {
        v.mode = 0;
        v.pauseT = rand(2, 6);
        v.waveAt = Math.random() < 0.45 ? v.pauseT * rand(0.3, 0.6) : -1;
      } else {
        const step = Math.min(v.speed * dt, d);
        pos.x += (dx / d) * step;
        pos.z += (dz / d) * step;
        v.yaw = Math.atan2(dx, dz);
        walkLimbs(v, dt, v.speed, true);
      }
      pos.y = terrainHeight(pos.x, pos.z);
    }

    if (v.mode === 0) {
      v.pauseT -= dt;
      relaxLimbs(v, dt);

      // occasional friendly arm wave
      if (v.waveAt > 0 && v.pauseT <= v.waveAt) {
        v.waveT = 1.7;
        v.waveAt = -1;
      }
      if (v.waveT > 0) {
        v.waveT -= dt;
        v.armR.rotation.x += (0 - v.armR.rotation.x) * Math.min(1, dt * 10);
        v.armR.rotation.z += (2.45 + Math.sin(t * 9) * 0.3 - v.armR.rotation.z) * Math.min(1, dt * 12);
      } else {
        v.armR.rotation.x *= Math.exp(-dt * 8);
        v.armR.rotation.z += (0.08 - v.armR.rotation.z) * Math.min(1, dt * 6);
      }

      if (v.pauseT <= 0) {
        // pick a different waypoint and head out
        let idx = (Math.random() * v.wps.length) | 0;
        if (idx === v.wpIdx) idx = (idx + 1) % v.wps.length;
        v.wpIdx = idx;
        v.mode = 1;
        v.waveT = 0;
      }
    } else if (v.waveT <= 0) {
      v.armR.rotation.z += (0.08 - v.armR.rotation.z) * Math.min(1, dt * 6);
    }

    v.root.rotation.y = turnYaw(v.root.rotation.y, v.yaw, dt * 7);
  }

  // ---- Merchant Bo — stands at the stall, turns to face a close player ----
  const m = merchant;
  if (m) {
    let yawTarget = m.baseYaw;
    const p = G.player;
    if (p && p.group) {
      const dx = p.group.position.x - m.x, dz = p.group.position.z - m.z;
      if (dx * dx + dz * dz < 25) yawTarget = Math.atan2(dx, dz); // within 5u
    }
    m.root.rotation.y = turnYaw(m.root.rotation.y, yawTarget, dt * 4);
    // gentle breathing bob + a slow welcoming arm sway
    m.bob.position.y = Math.sin(t * 1.8 + m.phase) * 0.012;
    m.armR.rotation.x = -0.5 + Math.sin(t * 0.9 + m.phase) * 0.08;
    m.armL.rotation.x = Math.sin(t * 0.8 + m.phase + 2) * 0.06;
  }
}

const SWING_DUR = 0.45;

function updateAdventurers(dt) {
  const t = G.time;
  const enemies = G.enemies;
  const p = G.player;

  for (let i = 0; i < adventurers.length; i++) {
    const a = adventurers[i];
    const pos = a.root.position;

    // ---- validate / acquire a target (non-boss, alive, close) ----
    let tg = a.target;
    if (tg) {
      const dx = tg.group.position.x - a.ax, dz = tg.group.position.z - a.az;
      if (tg.dead || tg.state === 'dying' || dx * dx + dz * dz > 16) { // leaves at >4u
        tg = a.target = null;
        a.animT = -1;
      }
    }
    if (!tg) {
      let bestSq = 9; // engage within 3u
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (e.dead || e.type === 'boss' || e.state === 'dying') continue;
        const dx = e.group.position.x - pos.x, dz = e.group.position.z - pos.z;
        if (dx > 3.2 || dx < -3.2 || dz > 3.2 || dz < -3.2) continue; // cheap reject
        const d = dx * dx + dz * dz;
        if (d < bestSq) { bestSq = d; tg = e; }
      }
      if (tg) {
        a.target = tg;
        a.ax = pos.x; a.az = pos.z; // anchor — lunges depart from & return here
        a.swingT = rand(0.3, 0.7);  // first swing comes quickly
        a.animT = -1;
      }
    }

    if (tg) {
      // ================= FIGHT — theatrical, zero real damage =================
      const ep = tg.group.position;
      a.yaw = Math.atan2(ep.x - a.ax, ep.z - a.az);

      let lunge = 0;
      if (a.animT >= 0) {
        a.animT += dt;
        const k = Math.min(1, a.animT / SWING_DUR);
        // wind-up over the shoulder, then the sweeping arc down past the knee
        if (k < 0.35) {
          a.armR.rotation.x = lerp(-1.1, 2.4, k / 0.35);
        } else {
          const sw = (k - 0.35) / 0.65;
          a.armR.rotation.x = 2.4 - sw * sw * 3.4;
        }
        // quick in-and-out lunge timed with the sweep
        lunge = Math.sin(Math.max(0, k - 0.3) / 0.7 * Math.PI) * 0.5;

        if (!a.impactDone && k >= 0.62) {
          a.impactDone = true;
          if (!tg.dead) {
            spawnBurst(ep, 0xffe9a0, 9, 8);
            tg.hitFlash = 0.3;
            // shove the enemy away — pure theater, no damageEnemy
            const ddx = ep.x - a.ax, ddz = ep.z - a.az;
            const dl = Math.hypot(ddx, ddz) || 1;
            tg.vel.x += (ddx / dl) * 3;
            tg.vel.z += (ddz / dl) * 3;
            if (p && p.group) {
              const pdx = p.group.position.x - a.ax, pdz = p.group.position.z - a.az;
              if (pdx * pdx + pdz * pdz < 484) playSound('hit'); // audible within ~22u
            }
          }
        }
        if (k >= 1) a.animT = -1;
      } else {
        // ready stance between swings — sword raised
        a.armR.rotation.x += (-1.1 - a.armR.rotation.x) * Math.min(1, dt * 8);
        a.swingT -= dt;
        if (a.swingT <= 0) {
          a.swingT = rand(1.35, 1.7); // every ~1.5s
          a.animT = 0;
          a.impactDone = false;
        }
      }

      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      pos.x = a.ax + fx * lunge;
      pos.z = a.az + fz * lunge;
      pos.y = terrainHeight(pos.x, pos.z);

      // bouncy combat footwork
      a.bob.position.y = Math.abs(Math.sin(t * 6 + a.phase)) * 0.03;
      a.legL.rotation.x *= Math.exp(-dt * 8);
      a.legR.rotation.x *= Math.exp(-dt * 8);
      a.armL.rotation.x += (-0.5 - a.armL.rotation.x) * Math.min(1, dt * 6);
    } else {
      // ================= PATROL =================
      const wp = a.route[a.wpIdx];
      const dx = wp[0] - pos.x, dz = wp[1] - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2) {
        a.wpIdx = (a.wpIdx + 1) % a.route.length;
      } else {
        const step = Math.min(3.0 * dt, d);
        pos.x += (dx / d) * step;
        pos.z += (dz / d) * step;
        a.yaw = Math.atan2(dx, dz);
      }
      pos.y = terrainHeight(pos.x, pos.z);
      a.ax = pos.x; a.az = pos.z;

      walkLimbs(a, dt, 3.0, false);
      // sword arm relaxes to the carry pose
      a.armR.rotation.x += (-0.35 - a.armR.rotation.x) * Math.min(1, dt * 5);
    }

    a.root.rotation.y = turnYaw(a.root.rotation.y, a.yaw, dt * 9);
  }
}

// ===========================================================================
// updateNPCs
// ===========================================================================

export function updateNPCs(dt) {
  if (!inited) return;
  updateBunnies(dt);
  updateButterflies(dt);
  updateBirds(dt);
  updateFrogs(dt);
  updateSnails(dt);
  updateVillagers(dt);
  updateAdventurers(dt);
}
