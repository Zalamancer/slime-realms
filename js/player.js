// player.js — player avatar, movement physics, third-person orbit camera, ability input.
// Owns: G.player.group / vel / grounded / dead / facing. See CONTRACT.md.
import * as THREE from 'three';
import { G, on, clamp, lerp } from './core.js';
import { WATER_LEVEL, terrainHeight, getSpawnPos } from './world.js';
import { createSlime, animateSlime, makeNameTag } from './slime.js';
import { tryAbility, playSound, spawnBurst, spawnRing } from './combat.js';
import { hasAbility } from './progression.js';

// ---- tuning ----
const ACCEL = 60;
const FRICTION_GROUND = 10;
const FRICTION_AIR = 2;
const GRAVITY = 28;
const JUMP_V = 11;
const COYOTE = 0.1;
const WATER_SPEED_MUL = 0.55;
const BOUND = 118;            // hard clamp
const BOUND_SOFT = 115;       // soft pushback starts here
const CAM_SENS = 0.0045;
const PITCH_MIN = -1.25;
const PITCH_MAX = -0.08;
const ZOOM_MIN = 6;
const ZOOM_MAX = 26;
const DASH_SPEED = 26;
const DASH_TIME = 0.22;       // overspeed window after a dash
const TAG_Y = 1.8;            // name tag local height above slime base
const HEAD_Y = 1.15;          // look-at / camera pivot height (× scale)

// ---- module state ----
let group = null;
let tag = null;
let camYaw = Math.PI;         // behind a slime facing +z
let camPitch = -0.45;
let camZoom = 13;
let camZoomTarget = 13;
let airTime = 0;              // seconds since last grounded (coyote time)
let jumps = 0;                // 0 = fresh, 1 = jumped, 2 = double-jumped
let dashTimer = 0;
let wasInWater = false;
let listenersBound = false;

// scratch (no per-frame allocations)
const _desired = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();

export function initPlayer() {
  const p = G.player;
  group = createSlime({ color: p.color, size: 1 });
  group.userData.baseScale = p.stats.scale || 1;
  group.scale.setScalar(p.stats.scale || 1);
  group.position.copy(getSpawnPos());
  p.group = group;
  if (!p.vel) p.vel = new THREE.Vector3();
  p.vel.set(0, 0, 0);
  p.grounded = true;
  p.dead = false;
  p.facing = p.facing || 0;
  refreshTag();
  G.scene.add(group);

  // camera orbit: yaw directly behind the player
  camYaw = wrapAngle(p.facing + Math.PI);
  camPitch = -0.45;
  camZoom = camZoomTarget = 13;
  airTime = 0;
  jumps = 0;
  dashTimer = 0;
  wasInWater = false;
  snapCamera();

  if (!listenersBound) {
    listenersBound = true;
    on('player:respawn', onRespawn);
    on('player:levelup', () => { refreshTag(); applyScale(); });
    on('stats:changed', () => { refreshTag(); applyScale(); });
  }
}

export function updatePlayer(dt) {
  const p = G.player;
  if (!p || !group) return;
  const v = p.vel;
  const pos = group.position;
  const scale = p.stats.scale || 1;
  const control = !G.paused && !G.chatFocus && !p.dead;

  // --- input direction relative to camera yaw ---
  let ix = 0, iz = 0;
  if (control) {
    const k = G.keys;
    if (k['KeyW'] || k['ArrowUp']) iz += 1;
    if (k['KeyS'] || k['ArrowDown']) iz -= 1;
    if (k['KeyA'] || k['ArrowLeft']) ix -= 1;
    if (k['KeyD'] || k['ArrowRight']) ix += 1;
  }
  const fwdX = -Math.sin(camYaw), fwdZ = -Math.cos(camYaw); // camera forward on XZ
  let dx = fwdX * iz - fwdZ * ix;                           // right = (-fwdZ, fwdX)
  let dz = fwdZ * iz + fwdX * ix;
  const dlen = Math.hypot(dx, dz);
  const hasInput = dlen > 0.001;
  if (hasInput) { dx /= dlen; dz /= dlen; }

  // --- water state (body below the surface) ---
  const inWater = pos.y + 0.45 * scale < WATER_LEVEL;
  if (inWater && !wasInWater && v.y < -3) { // splash on entry
    spawnRing(pos, 0x9fe8ff, 1.6);
    spawnBurst(pos, 0xbef0ff, 8, 5);
    playSound('squish');
  }
  wasInWater = inWater;

  // --- jumping (coyote time + optional double jump) ---
  if (control && G.keysPressed['Space']) {
    if ((p.grounded || airTime < COYOTE) && jumps === 0) {
      v.y = JUMP_V;
      jumps = 1;
      p.grounded = false;
      airTime = COYOTE; // consume coyote window
      playSound('jump');
    } else if (hasAbility('doubleJump')) {
      if (jumps === 0) jumps = 1; // walked off a ledge: air jump spends the first
      if (jumps < 2) {
        v.y = JUMP_V;
        jumps = 2;
        playSound('jump');
        spawnRing(pos, p.color, 1.4);     // stretch FX pop
        spawnBurst(pos, p.color, 10, 6);
      }
    }
  }

  // --- abilities ---
  if (control) {
    const kp = G.keysPressed;
    if (kp['Digit1'] || G.mouse.clicked) tryAbility('melee');
    if (kp['Digit2'] || G.mouse.rclicked) tryAbility('shot');
    if (kp['Digit3']) tryAbility('slam');
    if ((kp['Digit4'] || kp['ShiftLeft'] || kp['ShiftRight']) && tryAbility('dash')) {
      const ddx = hasInput ? dx : Math.sin(p.facing);
      const ddz = hasInput ? dz : Math.cos(p.facing);
      v.x = ddx * DASH_SPEED;
      v.z = ddz * DASH_SPEED;
      dashTimer = DASH_TIME;
      p.invuln = Math.max(p.invuln || 0, 0.15);
    }
  }
  dashTimer = Math.max(0, dashTimer - dt);
  const dashing = dashTimer > 0;

  // --- horizontal physics ---
  const fr = (p.grounded && !dashing) ? FRICTION_GROUND : FRICTION_AIR;
  const damp = Math.max(0, 1 - fr * dt);
  v.x *= damp;
  v.z *= damp;
  if (hasInput) {
    v.x += dx * ACCEL * dt;
    v.z += dz * ACCEL * dt;
  }
  const maxS = p.stats.moveSpeed * (inWater ? WATER_SPEED_MUL : 1);
  const hs0 = Math.hypot(v.x, v.z);
  if (hs0 > maxS && !dashing) {
    const ns = Math.max(maxS, hs0 - 40 * dt); // soft clamp so dash overspeed bleeds off
    const s = ns / hs0;
    v.x *= s;
    v.z *= s;
  }

  // --- vertical physics ---
  v.y -= GRAVITY * (inWater ? 0.5 : 1) * dt;  // buoyant in water
  if (inWater) v.y *= Math.max(0, 1 - 3 * dt); // water drag

  // integrate
  pos.x += v.x * dt;
  pos.y += v.y * dt;
  pos.z += v.z * dt;

  // --- world bounds: soft pushback then hard clamp ---
  if (pos.x > BOUND_SOFT) v.x -= (pos.x - BOUND_SOFT) * 6 * dt;
  else if (pos.x < -BOUND_SOFT) v.x -= (pos.x + BOUND_SOFT) * 6 * dt;
  if (pos.z > BOUND_SOFT) v.z -= (pos.z - BOUND_SOFT) * 6 * dt;
  else if (pos.z < -BOUND_SOFT) v.z -= (pos.z + BOUND_SOFT) * 6 * dt;
  pos.x = clamp(pos.x, -BOUND, BOUND);
  pos.z = clamp(pos.z, -BOUND, BOUND);

  // --- terrain collision (+ gentle bob while standing in water) ---
  const ground = terrainHeight(pos.x, pos.z);
  const bob = (inWater && ground < WATER_LEVEL)
    ? (Math.sin(G.time * 2.7) * 0.5 + 0.5) * 0.22
    : 0;
  const rest = ground + bob;
  const wasGrounded = p.grounded;
  const stick = (wasGrounded && v.y <= 0) ? 0.45 : 0; // hug terrain walking downhill
  p.grounded = false;
  if (v.y <= 0 && pos.y <= rest + stick) {
    const impact = v.y;
    pos.y = rest;
    v.y = 0;
    p.grounded = true;
    jumps = 0;
    airTime = 0;
    if (!wasGrounded && impact < -13 && !inWater) { // hard landing squish
      spawnBurst(pos, p.color, 6, 4);
      playSound('squish');
    }
  } else {
    if (pos.y < rest) pos.y = rest; // rising through a slope
    airTime += dt;
  }

  // --- facing lerps toward move direction ---
  if (hasInput) {
    const target = Math.atan2(dx, dz);
    let d = target - p.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    p.facing = wrapAngle(p.facing + d * Math.min(1, 12 * dt));
  }
  group.rotation.y = p.facing;

  // --- animation + i-frame blink (skip while dead: just settle) ---
  const speed = Math.hypot(v.x, v.z);
  if (!p.dead) {
    animateSlime(group, dt, { moving: hasInput && speed > 0.4, grounded: p.grounded, speed });
    group.visible = !((p.invuln || 0) > 0.05) || Math.sin(G.time * 26) > -0.3;
  }

  updateCamera(dt, pos, scale);
}

// ---- camera ----

function updateCamera(dt, pos, scale) {
  const m = G.mouse;
  if (m.down || m.rdown) {
    camYaw = wrapAngle(camYaw - m.mx * CAM_SENS);
    camPitch = clamp(camPitch - m.my * CAM_SENS, PITCH_MIN, PITCH_MAX);
  }
  m.mx = 0; // consumed every frame regardless
  m.my = 0;
  if (m.wheel !== 0) {
    camZoomTarget = clamp(camZoomTarget + m.wheel * 0.012, ZOOM_MIN, ZOOM_MAX);
    m.wheel = 0;
  }
  camZoom = lerp(camZoom, camZoomTarget, Math.min(1, 10 * dt));

  computeCamDesired(_desired);
  _camPos.lerp(_desired, Math.min(1, 12 * dt));
  const floor = terrainHeight(_camPos.x, _camPos.z) + 0.6;
  if (_camPos.y < floor) _camPos.y = floor;

  const cam = G.camera;
  cam.position.copy(_camPos);
  _look.set(pos.x, pos.y + HEAD_Y * scale, pos.z);
  cam.lookAt(_look);

  if (G.shake > 0.001) {
    cam.position.x += (Math.random() - 0.5) * G.shake * 0.4;
    cam.position.y += (Math.random() - 0.5) * G.shake * 0.4;
    cam.position.z += (Math.random() - 0.5) * G.shake * 0.4;
  }
  G.shake *= Math.max(0, 1 - 8 * dt);
}

function computeCamDesired(out) {
  const p = G.player;
  const pp = p.group.position;
  const cp = Math.cos(camPitch);
  out.set(
    pp.x + Math.sin(camYaw) * cp * camZoom,
    pp.y + HEAD_Y * (p.stats.scale || 1) - Math.sin(camPitch) * camZoom,
    pp.z + Math.cos(camYaw) * cp * camZoom
  );
}

function snapCamera() {
  computeCamDesired(_camPos);
  const floor = terrainHeight(_camPos.x, _camPos.z) + 0.6;
  if (_camPos.y < floor) _camPos.y = floor;
  G.camera.position.copy(_camPos);
  const p = G.player;
  const pp = p.group.position;
  _look.set(pp.x, pp.y + HEAD_Y * (p.stats.scale || 1), pp.z);
  G.camera.lookAt(_look);
}

// ---- name tag / scale ----

function refreshTag() {
  const p = G.player;
  if (!p || !group) return;
  if (tag) {
    group.remove(tag);
    if (tag.material) {
      if (tag.material.map) tag.material.map.dispose();
      tag.material.dispose();
    }
  }
  tag = makeNameTag(p.name, { sub: 'Lv ' + p.level });
  tag.position.set(0, TAG_Y, 0);
  group.add(tag);
}

function applyScale() {
  const p = G.player;
  if (!p || !group) return;
  // animateSlime rebuilds group.scale from userData.baseScale every frame,
  // so the stat-driven size (Titan Gel) must land there, not on group.scale
  group.userData.baseScale = p.stats.scale || 1;
  group.scale.setScalar(p.stats.scale || 1);
}

// ---- events ----

function onRespawn() {
  const p = G.player;
  if (!p || !group) return;
  p.hp = p.stats.maxHp;
  p.mana = p.stats.maxMana;
  p.dead = false;
  p.vel.set(0, 0, 0);
  group.position.copy(getSpawnPos());
  p.grounded = true;
  jumps = 0;
  airTime = 0;
  dashTimer = 0;
  p.invuln = Math.max(p.invuln || 0, 1.2); // brief spawn protection
  group.visible = true;
  snapCamera();
  spawnRing(group.position, p.color, 2.5);
  playSound('squish');
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
