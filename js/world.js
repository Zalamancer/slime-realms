// world.js — the island: terrain, water, sky & lights, vegetation, set dressing.
// Imports allowed: three, core (see CONTRACT.md). Source of truth for world layout.
import * as THREE from 'three';
import { G, clamp, lerp } from './core.js';

export const WORLD_SIZE = 240;
export const WATER_LEVEL = 0.9;

// ============================================================================
// Deterministic noise (pure — no Math.random anywhere in terrainHeight's path)
// ============================================================================

function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // [0, 1)
}

function smooth01(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// value noise on an integer lattice with smoothstep interpolation, [0, 1]
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

// layered (3-octave) signed noise, ~[-1, 1]
function fbm(x, z) {
  return (vnoise(x * 0.018 + 13.7, z * 0.018 + 7.31) - 0.5) * 1.24
       + (vnoise(x * 0.047 + 101.4, z * 0.047 + 57.2) - 0.5) * 0.54
       + (vnoise(x * 0.112 + 31.9, z * 0.112 + 91.7) - 0.5) * 0.22;
}

// Pure, deterministic, cheap. Range ≈ [-2.5, 14].
export function terrainHeight(x, z) {
  const n = fbm(x, z);
  const r = Math.hypot(x, z);

  // gentle meadow center, rolling hills outward
  const hillMask = smooth01((r - 18) / 50);
  let h = 1.6 + n * (0.9 + 4.6 * hillMask) + 1.8 * hillMask;

  // King's Arena flattening (0, 92) r18
  const ra = Math.hypot(x, z - 92);
  h = lerp(2.0, h, smooth01((ra - 18) / 14));

  // spawn / Slime Plaza flattening r16
  h = lerp(1.8, h, smooth01((r - 16) / 14));

  // lake depression centered (-70, 40), r ~24, dips to ~-2.2
  const rl = Math.hypot(x + 70, z - 40);
  h = lerp(h, -2.2, 1 - smooth01((rl - 8) / 18));

  // steep boundary cliffs beyond |112| — blend up to a craggy plateau
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h = lerp(h, 13.4 + n * 1.2, smooth01((edge - 112) / 8));

  return h;
}

export function getSpawnPos() {
  return new THREE.Vector3(0, terrainHeight(0, 3), 3);
}

// seeded deterministic RNG for layout
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

// ============================================================================
// Module state (filled by initWorld; never touched at import time)
// ============================================================================

let inited = false;
let sun = null, sunTarget = null, hemi = null, lanternLight = null;
let waterPos = null;
let cloudMesh = null, cloudData = null;
let sharedMat = null, mushCapMat = null, crystalMat = null, shardMat = null, glowWarmMat = null;
let skyColor = null;

const SKY_A = new THREE.Color(0x9fd9f6);
const SKY_B = new THREE.Color(0xb6e6f3);

// scratch (hot loops — never allocate per frame)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _IDENT_Q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

// ============================================================================
// Build helpers (init-time only — allocations fine here)
// ============================================================================

function mat4(px, py, pz, ry = 0, s = 1, rx = 0, rz = 0) {
  const sx = Array.isArray(s) ? s[0] : s;
  const sy = Array.isArray(s) ? s[1] : s;
  const sz = Array.isArray(s) ? s[2] : s;
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v1.set(px, py, pz);
  _v2.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v1, _q, _v2);
}

// merge parts [{geo, color, matrix}] into one vertex-colored BufferGeometry
function mergeParts(parts) {
  const geos = [];
  let total = 0;
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    _c.set(p.color);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = _c.r; colors[i * 3 + 1] = _c.g; colors[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(g);
    total += n;
  }
  const pos = new Float32Array(total * 3);
  const norm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, off);
    norm.set(g.attributes.normal.array, off);
    col.set(g.attributes.color.array, off);
    off += g.attributes.position.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// build an InstancedMesh from placement records
// p: { x, y, z, ry, rx, rz, s | [sx,sy,sz], tintR/G/B? }
function makeInstanced(geo, mat, placements, { cast = true, receive = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    mesh.setMatrixAt(i, mat4(p.x, p.y, p.z, p.ry || 0, p.s === undefined ? 1 : p.s, p.rx || 0, p.rz || 0));
    if (p.tintR !== undefined) mesh.setColorAt(i, _c.setRGB(p.tintR, p.tintG, p.tintB));
  }
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere();
  else mesh.frustumCulled = false;
  G.scene.add(mesh);
  return mesh;
}

// rejection-sample deterministic placements; accept(x, z, r, h) -> probability
function scatter(rng, count, accept) {
  const out = [];
  let guard = count * 40;
  while (out.length < count && guard-- > 0) {
    const x = (rng() * 2 - 1) * 116;
    const z = (rng() * 2 - 1) * 116;
    const r = Math.hypot(x, z);
    const h = terrainHeight(x, z);
    const p = accept(x, z, r, h);
    if (p > 0 && rng() < p) out.push({ x, z, h, rng });
  }
  return out;
}

const isCorner = (x, z) => Math.abs(x) > 80 && Math.abs(z) > 80;

// ============================================================================
// initWorld
// ============================================================================

export function initWorld() {
  if (inited) return;
  inited = true;
  const scene = G.scene;

  // ---- sky, fog, lights -------------------------------------------------
  skyColor = new THREE.Color().copy(SKY_A);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor.getHex(), 120, 340);
  scene.fog.color = skyColor; // share the drifting color object

  hemi = new THREE.HemisphereLight(0xcfeaff, 0x8fbf7a, 2.4);
  scene.add(hemi);

  sun = new THREE.DirectionalLight(0xfff1d6, 3.0);
  sun.position.set(55, 105, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46;
  sc.near = 20; sc.far = 280;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);

  // ---- shared materials ---------------------------------------------------
  sharedMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  glowWarmMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, emissive: 0xffc36b, emissiveIntensity: 0.8,
  });
  mushCapMat = new THREE.MeshLambertMaterial({
    color: 0x8fe8d0, flatShading: true, emissive: 0x35e8b8, emissiveIntensity: 0.8,
  });
  crystalMat = new THREE.MeshLambertMaterial({
    color: 0xcfa9f5, flatShading: true, emissive: 0x8b5cf6, emissiveIntensity: 0.55,
  });
  shardMat = new THREE.MeshLambertMaterial({
    color: 0xbfe6f5, flatShading: true, emissive: 0x6fc4e8, emissiveIntensity: 0.35,
  });

  // ---- ground -------------------------------------------------------------
  buildGround();

  // ---- water ----------------------------------------------------------------
  const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE + 8, WORLD_SIZE + 8, 40, 40);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x58b6e6, transparent: true, opacity: 0.72, flatShading: true,
    shininess: 90, specular: 0x99ddff,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = WATER_LEVEL;
  water.receiveShadow = true;
  scene.add(water);
  waterPos = waterGeo.attributes.position;
  waterPos.setUsage(THREE.DynamicDrawUsage);

  // ---- vegetation (deterministic, instanced) -------------------------------
  buildVegetation(mulberry32(0x51a91e));

  // ---- set dressing ---------------------------------------------------------
  buildVillage(mulberry32(0x9a11a6e));
  buildArena(mulberry32(0xa1e4a));
  buildCrystalHollows(mulberry32(0xc1a5));
  buildBoundaryShards(mulberry32(0xb0a2d));
  buildClouds(mulberry32(0xc10cd5));
}

// ---------------------------------------------------------------------------

function buildGround() {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 160, 160);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);

  const C_SAND = new THREE.Color(0xead9a0);
  const C_MEADOW = new THREE.Color(0x86d973);
  const C_MEADOW_HI = new THREE.Color(0xa2e58c);
  const C_WHISPER = new THREE.Color(0x53af6a);
  const C_CORNER = new THREE.Color(0xa493dd);
  const C_STONE = new THREE.Color(0x9fa3ac);
  const C_ARENA = new THREE.Color(0xbcb7aa);
  const C_PATH = new THREE.Color(0xdcca9c);

  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const r = Math.hypot(x, z);
    const ra = Math.hypot(x, z - 92);
    const edge = Math.max(Math.abs(x), Math.abs(z));

    _c.copy(C_MEADOW).lerp(C_MEADOW_HI, clamp((h - 2) / 6, 0, 1));

    // Whisperwood ring — deeper green
    const wMask = smooth01((r - 50) / 12) * (1 - smooth01((r - 95) / 12));
    _c.lerp(C_WHISPER, wMask * 0.85);

    // Crystal Hollows corners — purple tint
    _c.lerp(C_CORNER, smooth01((Math.min(Math.abs(x), Math.abs(z)) - 74) / 14) * 0.7);

    // plaza — soft sandy path circle
    _c.lerp(C_PATH, (1 - smooth01((r - 8) / 7)) * 0.55);

    // arena — warm stone disc
    _c.lerp(C_ARENA, (1 - smooth01((ra - 15) / 7)) * 0.8);

    // cliffs & high ground — grey stone
    const cliffMask = Math.max(smooth01((h - 7.5) / 3.5), smooth01((edge - 106) / 8));
    _c.lerp(C_STONE, cliffMask);

    // sandy near/below the waterline (shores, lake bed)
    _c.lerp(C_SAND, 1 - smooth01((h - (WATER_LEVEL + 0.4)) / 0.9));

    // pure-noise texture jitter
    const j = 0.93 + 0.12 * vnoise(x * 0.31 + 5.1, z * 0.31 + 9.7);
    colors[i * 3] = _c.r * j;
    colors[i * 3 + 1] = _c.g * j;
    colors[i * 3 + 2] = _c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const ground = new THREE.Mesh(geo, sharedMat);
  ground.receiveShadow = true;
  G.scene.add(ground);
}

// ---------------------------------------------------------------------------

function buildVegetation(rng) {
  const GREEN1 = 0x7ed47e, GREEN2 = 0x66c46e, GREEN3 = 0x8fdc7a;
  const DEEP1 = 0x4da567, DEEP2 = 0x3f9659;
  const TRUNK = 0x9a6b4f, TRUNK_D = 0x7d5a44;

  // --- tree variant geometries (trunk + 1-3 blob canopies, merged + colored)
  const treeA = mergeParts([
    { geo: new THREE.CylinderGeometry(0.32, 0.5, 2.4, 6), color: TRUNK, matrix: mat4(0, 1.2, 0) },
    { geo: new THREE.IcosahedronGeometry(1.25, 0), color: GREEN1, matrix: mat4(0, 3.0, 0) },
    { geo: new THREE.IcosahedronGeometry(0.95, 0), color: GREEN2, matrix: mat4(0.78, 2.45, 0.2, 0.7) },
    { geo: new THREE.IcosahedronGeometry(0.85, 0), color: GREEN3, matrix: mat4(-0.7, 2.6, -0.3, 1.9) },
  ]);
  const treeB = mergeParts([
    { geo: new THREE.CylinderGeometry(0.28, 0.45, 3.4, 6), color: TRUNK_D, matrix: mat4(0, 1.7, 0) },
    { geo: new THREE.IcosahedronGeometry(1.05, 0), color: DEEP1, matrix: mat4(0, 4.0, 0) },
    { geo: new THREE.IcosahedronGeometry(0.8, 0), color: DEEP2, matrix: mat4(0.34, 3.0, 0.3, 1.1) },
  ]);
  const treeC = mergeParts([
    { geo: new THREE.CylinderGeometry(0.4, 0.55, 1.6, 6), color: TRUNK, matrix: mat4(0, 0.8, 0) },
    { geo: new THREE.IcosahedronGeometry(1.55, 0), color: GREEN3, matrix: mat4(0, 2.5, 0, 0.4) },
  ]);

  const treeAccept = (bias) => (x, z, r, h) => {
    if (r < 21 || Math.hypot(x, z - 92) < 22) return 0;        // plaza + arena clear
    if (h < WATER_LEVEL + 0.4 || h > 8.5) return 0;             // not in water / on cliffs
    if (Math.max(Math.abs(x), Math.abs(z)) > 106) return 0;
    const corner = isCorner(x, z);
    const whisper = r >= 55 && r < 95 && !corner;
    if (bias === 'field') return whisper ? 0.35 : (r < 55 ? 0.85 : (corner ? 0.12 : 0.3));
    return whisper ? 1 : (r < 55 ? 0.12 : (corner ? 0.22 : 0.3)); // whisper bias
  };

  const place = (list, ymin, smin, srange) => list.map((p) => ({
    x: p.x, z: p.z, y: p.h - ymin, ry: rng() * Math.PI * 2, s: smin + rng() * srange,
  }));

  // V2 density: trees ×1.6 (55/85/45 -> 88/136/72); same draw calls, instances are cheap
  makeInstanced(treeA, sharedMat, place(scatter(rng, 88, treeAccept('field')), 0.12, 0.85, 0.55));
  makeInstanced(treeB, sharedMat, place(scatter(rng, 136, treeAccept('whisper')), 0.12, 0.8, 0.6));
  makeInstanced(treeC, sharedMat, place(scatter(rng, 72, treeAccept('field')), 0.12, 0.8, 0.5));

  // --- rocks ---------------------------------------------------------------
  const rockGeo = mergeParts([
    { geo: new THREE.DodecahedronGeometry(1, 0), color: 0xffffff, matrix: mat4(0, 0.55, 0) },
  ]);
  const rocks = scatter(rng, 98, (x, z, r, h) => { // V2 density: rocks ×1.4 (70 -> 98)
    if (r < 19 || h < WATER_LEVEL - 1.2) return 0;
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > 108) return 0;
    return edge > 94 ? 0.85 : 0.3;
  }).map((p) => {
    const shade = 0.62 + rng() * 0.22;
    return {
      x: p.x, z: p.z, y: p.h - 0.25, ry: rng() * Math.PI * 2,
      s: [0.5 + rng() * 1.0, 0.4 + rng() * 0.8, 0.5 + rng() * 1.0],
      rx: (rng() - 0.5) * 0.3, rz: (rng() - 0.5) * 0.3,
      tintR: shade, tintG: shade * 1.02, tintB: shade * 1.08,
    };
  });
  makeInstanced(rockGeo, sharedMat, rocks);

  // --- flowers ---------------------------------------------------------------
  const petals = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    petals.push({
      geo: new THREE.IcosahedronGeometry(0.13, 0), color: 0xffffff,
      matrix: mat4(Math.cos(a) * 0.18, 0.62, Math.sin(a) * 0.18),
    });
  }
  const flowerGeo = mergeParts([
    { geo: new THREE.CylinderGeometry(0.035, 0.05, 0.55, 4), color: 0x5f9e52, matrix: mat4(0, 0.27, 0) },
    { geo: new THREE.SphereGeometry(0.1, 5, 4), color: 0xffd96b, matrix: mat4(0, 0.62, 0) },
    ...petals,
  ]);
  const FLOWER_TINTS = [[1, 0.72, 0.85], [1, 0.95, 0.66], [0.72, 0.85, 1], [0.95, 0.78, 1], [1, 1, 1]];
  const flowers = scatter(rng, 414, (x, z, r, h) => { // V2 density: flowers ×1.8 (230 -> 414)
    if (r < 6 || h < WATER_LEVEL + 0.25 || h > 6.5) return 0;
    if (Math.hypot(x, z - 92) < 16) return 0.15;
    if (isCorner(x, z)) return 0.12;
    return r < 55 ? 1 : 0.3;
  }).map((p) => {
    const t = FLOWER_TINTS[(rng() * FLOWER_TINTS.length) | 0];
    return {
      x: p.x, z: p.z, y: p.h - 0.04, ry: rng() * Math.PI * 2, s: 0.8 + rng() * 0.6,
      tintR: t[0], tintG: t[1], tintB: t[2],
    };
  });
  makeInstanced(flowerGeo, sharedMat, flowers, { cast: false });

  // --- glow mushrooms (stems share matrices with emissive caps) --------------
  const mushAccept = (x, z, r, h) => {
    if (r < 19 || h < WATER_LEVEL + 0.3 || h > 8.5) return 0;
    if (Math.hypot(x, z - 92) < 19) return 0;
    if (isCorner(x, z)) return 0.5;
    const whisper = r >= 55 && r < 95;
    return whisper ? 1 : 0.06;
  };
  const mush = scatter(rng, 144, mushAccept).map((p) => ({ // V2 density: glow-mushrooms ×1.6 (90 -> 144)
    x: p.x, z: p.z, y: p.h - 0.05, ry: rng() * Math.PI * 2, s: 0.7 + rng() * 0.9,
  }));
  const stemGeo = mergeParts([
    { geo: new THREE.CylinderGeometry(0.12, 0.2, 0.55, 5), color: 0xd6e3da, matrix: mat4(0, 0.27, 0) },
  ]);
  const capGeo = new THREE.SphereGeometry(0.42, 6, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
  capGeo.scale(1, 0.75, 1);
  capGeo.translate(0, 0.5, 0);
  makeInstanced(stemGeo, sharedMat, mush, { cast: false });
  makeInstanced(capGeo, mushCapMat, mush, { cast: false });
}

// ---------------------------------------------------------------------------

function buildVillage(rng) {
  const parts = [];      // -> sharedMat (vertex colors)
  const glowParts = [];  // -> glowWarmMat (lantern orbs, windows)

  const bodyGeo = new THREE.CylinderGeometry(1.5, 1.8, 2.3, 9);
  const capGeo = new THREE.SphereGeometry(2.1, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.6);
  const doorGeo = new THREE.BoxGeometry(0.85, 1.4, 0.22);
  const spotGeo = new THREE.SphereGeometry(0.24, 5, 4);
  const winGeo = new THREE.BoxGeometry(0.5, 0.55, 0.12);
  const postGeo = new THREE.CylinderGeometry(0.07, 0.1, 1.9, 5);
  const orbGeo = new THREE.SphereGeometry(0.22, 6, 5);

  const CAPS = [0xe8838a, 0x7fd4c1, 0xc7a8ef, 0xf5b97f, 0xf2a0c0];
  const HOUSE_ANGLES = [0.5, 1.85, 3.0, 4.2, 5.4];

  for (let i = 0; i < 5; i++) {
    const a = HOUSE_ANGLES[i];
    const hr = 11 + rng() * 2.5;
    const hx = Math.cos(a) * hr, hz = Math.sin(a) * hr;
    const face = Math.atan2(-hx, -hz); // door looks at plaza center (+z local)
    const base = mat4(hx, terrainHeight(hx, hz) - 0.1, hz, face);
    const L = (geo, color, m, arr = parts) => arr.push({ geo, color, matrix: m.premultiply(base.clone()) });

    L(bodyGeo, 0xf3e6c8, mat4(0, 1.15, 0));
    L(capGeo, CAPS[i], mat4(0, 2.25, 0, rng() * Math.PI, [1, 0.78, 1]));
    L(doorGeo, 0x7a5340, mat4(0, 0.7, 1.68));
    L(spotGeo, 0xfff6ec, mat4(0.95, 3.0, 0.85, 0, 1));
    L(spotGeo, 0xfff6ec, mat4(-1.0, 3.15, -0.5, 0, 0.8));
    L(spotGeo, 0xfff6ec, mat4(0.2, 3.65, -0.9, 0, 0.7));
    L(winGeo, 0xffe9b0, mat4(1.45, 1.5, 0.45, Math.PI / 2 - 0.35), glowParts);
  }

  // lantern posts around the plaza
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    const lx = Math.cos(a) * 8.4, lz = Math.sin(a) * 8.4;
    const ly = terrainHeight(lx, lz);
    parts.push({ geo: postGeo, color: 0x6e5440, matrix: mat4(lx, ly + 0.9, lz) });
    glowParts.push({ geo: orbGeo, color: 0xffe2a8, matrix: mat4(lx, ly + 1.95, lz) });
  }

  // banner arch on the road out of the plaza (toward the arena)
  const ax = 0, az = 16.6, ay = terrainHeight(ax, az);
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 3.4, 6);
  const barGeo = new THREE.BoxGeometry(5.6, 0.28, 0.28);
  const flagGeo = new THREE.ConeGeometry(0.26, 0.6, 4);
  parts.push({ geo: poleGeo, color: 0x8a6a4e, matrix: mat4(-2.5, ay + 1.7, az) });
  parts.push({ geo: poleGeo, color: 0x8a6a4e, matrix: mat4(2.5, ay + 1.7, az) });
  parts.push({ geo: barGeo, color: 0x8a6a4e, matrix: mat4(0, ay + 3.4, az) });
  const FLAGS = [0xf7a8c4, 0xf7e08a, 0xa8d8f7, 0xc9f0a8, 0xe3b8f5];
  for (let i = 0; i < 5; i++) {
    parts.push({ geo: flagGeo, color: FLAGS[i], matrix: mat4(-2 + i, ay + 3.0, az, 0, 1, 0, Math.PI) });
  }

  const villageMesh = new THREE.Mesh(mergeParts(parts), sharedMat);
  villageMesh.castShadow = true;
  villageMesh.receiveShadow = true;
  G.scene.add(villageMesh);

  const glowMesh = new THREE.Mesh(mergeParts(glowParts), glowWarmMat);
  G.scene.add(glowMesh);

  // one warm light for the plaza at dusk-glow strength (physical falloff)
  lanternLight = new THREE.PointLight(0xffc985, 26, 28, 2);
  lanternLight.position.set(0, terrainHeight(0, 0) + 3, 0);
  G.scene.add(lanternLight);
}

// ---------------------------------------------------------------------------

function buildArena(rng) {
  const stoneGeo = new THREE.CylinderGeometry(0.75, 1.05, 5.2, 5);
  stoneGeo.translate(0, 2.4, 0);
  const stones = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const sx = Math.cos(a) * 14.2, sz = 92 + Math.sin(a) * 14.2;
    const shade = 0.55 + rng() * 0.18;
    stones.push({
      x: sx, z: sz, y: terrainHeight(sx, sz) - 0.45,
      ry: a + rng() * 0.6, rx: (rng() - 0.5) * 0.14, rz: (rng() - 0.5) * 0.14,
      s: [0.9 + rng() * 0.3, 0.85 + rng() * 0.35, 0.9 + rng() * 0.3],
      tintR: shade, tintG: shade * 1.02, tintB: shade * 1.1,
    });
  }
  const geo = mergeParts([{ geo: stoneGeo, color: 0xffffff, matrix: null }]);
  makeInstanced(geo, sharedMat, stones);
}

// ---------------------------------------------------------------------------

function buildCrystalHollows(rng) {
  const crystalGeo = new THREE.OctahedronGeometry(1.1, 0);
  crystalGeo.translate(0, 1.0, 0);
  const crystals = [];
  for (const cx of [-92, 92]) {
    for (const cz of [-92, 92]) {
      for (let i = 0; i < 7; i++) {
        const x = cx + (rng() - 0.5) * 15;
        const z = cz + (rng() - 0.5) * 15;
        crystals.push({
          x, z, y: terrainHeight(x, z) - 0.4,
          ry: rng() * Math.PI * 2,
          rx: (rng() - 0.5) * 0.45, rz: (rng() - 0.5) * 0.45,
          s: [0.7 + rng() * 0.7, 1.5 + rng() * 1.8, 0.7 + rng() * 0.7],
        });
      }
    }
  }
  makeInstanced(crystalGeo, crystalMat, crystals);
}

// ---------------------------------------------------------------------------

function buildBoundaryShards(rng) {
  const shardGeo = new THREE.OctahedronGeometry(0.9, 0);
  shardGeo.translate(0, 0.7, 0);
  const shards = [];
  const D = 115;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < 13; i++) {
      const t = -108 + (i / 12) * 216 + (rng() - 0.5) * 7;
      const off = D + (rng() - 0.5) * 3;
      let x, z;
      if (side === 0) { x = t; z = -off; }
      else if (side === 1) { x = t; z = off; }
      else if (side === 2) { x = -off; z = t; }
      else { x = off; z = t; }
      shards.push({
        x, z, y: terrainHeight(x, z) - 1.2,
        ry: rng() * Math.PI * 2,
        rx: (rng() - 0.5) * 0.25, rz: (rng() - 0.5) * 0.25,
        s: [0.8 + rng() * 0.6, 2.6 + rng() * 2.2, 0.8 + rng() * 0.6],
      });
    }
  }
  makeInstanced(shardGeo, shardMat, shards, { cast: false });
}

// ---------------------------------------------------------------------------

function buildClouds(rng) {
  const cloudGeo = mergeParts([
    { geo: new THREE.SphereGeometry(1.7, 7, 5), color: 0xffffff, matrix: mat4(0, 0, 0, 0, [1, 0.55, 1]) },
    { geo: new THREE.SphereGeometry(1.25, 7, 5), color: 0xffffff, matrix: mat4(1.7, 0.15, 0.4, 0, [1, 0.6, 1]) },
    { geo: new THREE.SphereGeometry(1.1, 7, 5), color: 0xffffff, matrix: mat4(-1.6, 0.1, -0.3, 0, [1, 0.6, 1]) },
    { geo: new THREE.SphereGeometry(0.95, 7, 5), color: 0xfdfdff, matrix: mat4(0.4, 0.55, -0.9, 0, [1, 0.6, 1]) },
  ]);
  const cloudMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, transparent: true, opacity: 0.92,
    emissive: 0xffffff, emissiveIntensity: 0.4,
  });
  cloudData = [];
  for (let i = 0; i < 9; i++) {
    cloudData.push({
      x: (rng() * 2 - 1) * 180,
      y: 56 + rng() * 16,
      z: (rng() * 2 - 1) * 170,
      s: 2.2 + rng() * 3.2,
      speed: 1.1 + rng() * 1.4,
      phase: rng() * Math.PI * 2,
    });
  }
  cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, cloudData.length);
  cloudMesh.frustumCulled = false; // instances drift; skip culling
  cloudMesh.castShadow = false;
  cloudMesh.receiveShadow = false;
  for (let i = 0; i < cloudData.length; i++) {
    const c = cloudData[i];
    cloudMesh.setMatrixAt(i, mat4(c.x, c.y, c.z, 0, [c.s, c.s * 0.8, c.s]));
  }
  cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  G.scene.add(cloudMesh);
}

// ============================================================================
// updateWorld — water bob, drifting clouds, shadow follow, ambient drift
// ============================================================================

export function updateWorld(dt) {
  if (!inited) return;
  const t = G.time;

  // gentle water waves
  const wp = waterPos;
  for (let i = 0; i < wp.count; i++) {
    const x = wp.getX(i), z = wp.getZ(i);
    wp.setY(i, Math.sin(x * 0.16 + t * 1.15) * 0.07 + Math.sin(z * 0.21 + x * 0.05 + t * 0.85) * 0.05);
  }
  wp.needsUpdate = true;

  // drifting cloud clusters
  for (let i = 0; i < cloudData.length; i++) {
    const c = cloudData[i];
    c.x += c.speed * dt;
    if (c.x > 185) c.x = -185;
    _v1.set(c.x, c.y + Math.sin(t * 0.12 + c.phase) * 1.6, c.z);
    _v2.set(c.s, c.s * 0.8, c.s);
    _m4.compose(_v1, _IDENT_Q, _v2);
    cloudMesh.setMatrixAt(i, _m4);
  }
  cloudMesh.instanceMatrix.needsUpdate = true;

  // shadow box follows the player (snapped to reduce shimmer)
  const pg = G.player && G.player.group;
  if (pg) {
    const px = Math.round(pg.position.x * 0.5) * 2;
    const pz = Math.round(pg.position.z * 0.5) * 2;
    sunTarget.position.set(px, 0, pz);
    sun.position.set(px + 55, 105, pz + 40);
  }

  // subtle, cheerful ambient drift (mutates shared color objects — no allocs)
  const k = 0.5 + 0.5 * Math.sin(t * 0.04);
  skyColor.lerpColors(SKY_A, SKY_B, k);
  hemi.intensity = 2.3 + 0.3 * k;

  // soft pulsing glows
  mushCapMat.emissiveIntensity = 0.7 + 0.25 * Math.sin(t * 1.8);
  crystalMat.emissiveIntensity = 0.5 + 0.15 * Math.sin(t * 1.1 + 1.7);
  glowWarmMat.emissiveIntensity = 0.75 + 0.1 * Math.sin(t * 2.1) + 0.05 * Math.sin(t * 6.7);
  lanternLight.intensity = 26 + 2.5 * Math.sin(t * 2.3) + 1.5 * Math.sin(t * 7.1);
}
