// combat.js — abilities, projectiles, damage, FX, juice, sound.
// Owns: G.player.cooldowns / G.player.invuln, projectile + particle + damage-number +
// ring pools, HP/mana regen ticks, and the tiny WebAudio synth.
// See CONTRACT.md (combat.js section) for the integration spec.
import * as THREE from 'three';
import { G, on, emit, rand } from './core.js';
import { terrainHeight } from './world.js';
import { hasAbility, getRank } from './progression.js';

// ---------------------------------------------------------------------------
// constants & scratch
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
const MELEE_RANGE = 3.2;
const MELEE_COS = Math.cos(50 * DEG); // ~100° total arc
const SHOT_SPEED = 28;
const SHOT_LIFE = 1.6;
const SLAM_RADIUS = 6;
const PART_MAX = 200;
const NUM_MAX = 24;
const RING_MAX = 12;
const PROJ_MAX = 32;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// Skill-node id candidates (progression.js owns the exact ids; getRank returns 0
// for unknown ids, so probing a few plausible spellings is safe).
const IDS_SPLITTER = ['splitter', 'split', 'splitShot', 'splitshot', 'split_shot'];
const IDS_HEAVY = ['heavySlug', 'heavy_slug', 'heavyslug', 'heavy-slug', 'slug', 'heavy'];
const IDS_OVERFLOW = ['overflow', 'over_flow'];

function skillRank(ids) {
  let r = 0;
  for (let i = 0; i < ids.length; i++) {
    try { r = Math.max(r, getRank(ids[i]) | 0); } catch (e) { /* not ready yet */ }
  }
  return r;
}

function liveStats() {
  return (G.player && G.player.stats) || null;
}

// ---------------------------------------------------------------------------
// ABILITIES (ui renders the hotbar from this, in slot order)
// ---------------------------------------------------------------------------
export const ABILITIES = [
  {
    id: 'melee', slot: 1, keyLabel: '1 / LMB', name: 'Bounce Strike', icon: '💥', mana: 0,
    cdMax() { const s = liveStats(); return 0.45 / ((s && s.attackSpeed) || 1); },
    unlocked() { return true; },
  },
  {
    id: 'shot', slot: 2, keyLabel: '2 / RMB', name: 'Slime Shot', icon: '🟢', mana: 8,
    cdMax() { return 1.2; },
    unlocked() { try { return hasAbility('shot'); } catch (e) { return false; } },
  },
  {
    id: 'slam', slot: 3, keyLabel: '3', name: 'Goo Slam', icon: '🌊', mana: 22,
    cdMax() { return 5; },
    unlocked() { try { return hasAbility('slam'); } catch (e) { return false; } },
  },
  {
    id: 'dash', slot: 4, keyLabel: '4 / Shift', name: 'Slip Dash', icon: '💨', mana: 12,
    cdMax() { return 2.5; },
    unlocked() { try { return hasAbility('dash'); } catch (e) { return false; } },
  },
];
const ABILITY_MAP = {};
for (const ab of ABILITIES) ABILITY_MAP[ab.id] = ab;

// ---------------------------------------------------------------------------
// module state (pools created in initCombat — never at import time)
// ---------------------------------------------------------------------------
let inited = false;
let bound = false;
let fxGroup = null;

let projGeo = null, projMat = null, projBurstColor = 0xa6f7a6;
const projActive = [];
const projPool = [];

let partGeo = null;
const parts = [];
let partCursor = 0;

const nums = [];
let ringGeo = null;
const rings = [];

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export function initCombat() {
  if (!fxGroup) {
    fxGroup = new THREE.Group();
    fxGroup.name = 'combat-fx';
  }
  if (G.scene && fxGroup.parent !== G.scene) G.scene.add(fxGroup);

  if (!projGeo) projGeo = new THREE.IcosahedronGeometry(0.5, 1);
  if (!partGeo) partGeo = new THREE.IcosahedronGeometry(0.5, 0);
  if (!ringGeo) {
    ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
  }
  if (!projMat) {
    const base = new THREE.Color((G.player && G.player.color) || 0x6fcf5f)
      .lerp(new THREE.Color(0xffffff), 0.25);
    projBurstColor = base.getHex();
    projMat = new THREE.MeshStandardMaterial({
      color: base,
      emissive: base.clone().multiplyScalar(0.35),
      flatShading: true,
      roughness: 0.4,
      metalness: 0,
    });
  }

  inited = true;

  if (!bound) {
    bound = true;
    on('player:levelup', () => {
      const p = G.player;
      if (!p || !p.group) return;
      _v1.copy(p.group.position); _v1.y += 1.2;
      spawnBurst(_v1, 0xffd75e, 30, 9);
      spawnRing(p.group.position, 0xffd75e, 5);
      playSound('level');
    });
    on('player:respawn', () => {
      const p = G.player;
      if (!p) return;
      if (p.cooldowns) for (const k in p.cooldowns) p.cooldowns[k] = 0;
      p.invuln = 0;
    });
  }
}

// ---------------------------------------------------------------------------
// abilities
// ---------------------------------------------------------------------------
export function getCooldown(id) {
  const p = G.player;
  return (p && p.cooldowns && p.cooldowns[id]) || 0;
}

export function tryAbility(id) {
  const p = G.player;
  if (!p || p.dead || !p.group) return false;
  const ab = ABILITY_MAP[id];
  if (!ab) return false;
  if (!ab.unlocked()) return false;
  if (!p.cooldowns) p.cooldowns = { melee: 0, shot: 0, slam: 0, dash: 0 };
  if ((p.cooldowns[id] || 0) > 0) { playSound('denied'); return false; }
  const cost = ab.mana * ((p.stats && p.stats.manaCost) || 1);
  if (p.mana < cost - 1e-4) { playSound('denied'); return false; }

  p.mana -= cost;
  p.cooldowns[id] = ab.cdMax();

  switch (id) {
    case 'melee': doMelee(p); break;
    case 'shot': doShot(p); break;
    case 'slam': doSlam(p); break;
    case 'dash': doDash(p); break; // player.js applies the impulse
  }
  return true;
}

function facingDir(p) {
  return _fwd.set(Math.sin(p.facing), 0, Math.cos(p.facing));
}

function doMelee(p) {
  const pos = p.group.position;
  const fwd = facingDir(p);
  let hitAny = false;
  for (let i = 0; i < G.enemies.length; i++) {
    const e = G.enemies[i];
    if (!e || e.dead || !e.group) continue;
    _v1.copy(e.group.position).sub(pos);
    _v1.y = 0;
    const d = _v1.length();
    const eR = e.radius || ((e.group.scale && e.group.scale.x) || 1) * 0.8;
    if (d > MELEE_RANGE + eR) continue;
    if (d > 0.001) _v1.multiplyScalar(1 / d);
    if (d > 0.6 && _v1.dot(fwd) < MELEE_COS) continue; // ~100° arc; point-blank always hits
    const crit = Math.random() < ((p.stats && p.stats.crit) || 0);
    const dmg = ((p.stats && p.stats.damage) || 10) * (crit ? 2 : 1);
    damageEnemy(e, dmg, { crit, knockback: 8, fromPos: pos });
    if (crit) G.shake += 0.2;
    hitAny = true;
  }
  // squish FX in front of the slime, whether or not we connected
  _v2.copy(pos).addScaledVector(fwd, 1.7);
  _v2.y += 0.7;
  spawnBurst(_v2, hitAny ? 0xfff0b0 : 0xeafff0, hitAny ? 12 : 6, hitAny ? 8 : 5);
  playSound('squish');
}

function doShot(p) {
  const split = skillRank(IDS_SPLITTER) > 0;
  const heavy = skillRank(IDS_HEAVY) > 0;
  const pierce = skillRank(IDS_OVERFLOW) > 0;
  const crit = Math.random() < ((p.stats && p.stats.crit) || 0);
  const dmg = ((p.stats && p.stats.damage) || 10) * (heavy ? 1.5 : 1) * (crit ? 2 : 1);
  const knock = heavy ? 10 : 5;
  if (split) {
    fireProjectile(p, p.facing - 12 * DEG, dmg, knock, pierce, heavy, crit);
    fireProjectile(p, p.facing, dmg, knock, pierce, heavy, crit);
    fireProjectile(p, p.facing + 12 * DEG, dmg, knock, pierce, heavy, crit);
  } else {
    fireProjectile(p, p.facing, dmg, knock, pierce, heavy, crit);
  }
  const fwd = facingDir(p);
  _v2.copy(p.group.position).addScaledVector(fwd, 1.1);
  _v2.y += 0.9 * ((p.stats && p.stats.scale) || 1);
  spawnBurst(_v2, projBurstColor, 6, 4);
  playSound('shot');
}

function doSlam(p) {
  const pos = p.group.position;
  spawnRing(pos, 0x7ee787, SLAM_RADIUS);
  _v2.copy(pos); _v2.y += 0.5;
  spawnBurst(_v2, 0xbef7c8, 26, 10);
  G.shake += 0.8;
  const dmg = ((p.stats && p.stats.damage) || 10) * 1.6;
  for (let i = 0; i < G.enemies.length; i++) {
    const e = G.enemies[i];
    if (!e || e.dead || !e.group) continue;
    const dx = e.group.position.x - pos.x;
    const dz = e.group.position.z - pos.z;
    const eR = e.radius || ((e.group.scale && e.group.scale.x) || 1) * 0.8;
    if (dx * dx + dz * dz > (SLAM_RADIUS + eR) * (SLAM_RADIUS + eR)) continue;
    const crit = Math.random() < ((p.stats && p.stats.crit) || 0);
    damageEnemy(e, dmg * (crit ? 2 : 1), { crit, knockback: 9, fromPos: pos });
    if (e.vel) e.vel.y += 5.5; // knock-up
  }
  playSound('slam');
}

function doDash(p) {
  // validate + cooldown + FX + sound only — player.js applies the impulse
  const fwd = facingDir(p);
  _v2.copy(p.group.position).addScaledVector(fwd, -0.6);
  _v2.y += 0.5;
  spawnBurst(_v2, 0xcdeffd, 14, 8);
  playSound('dash');
}

// ---------------------------------------------------------------------------
// projectiles
// ---------------------------------------------------------------------------
function makeProjectile() {
  const mesh = new THREE.Mesh(projGeo, projMat);
  mesh.visible = false;
  mesh.castShadow = false;
  fxGroup.add(mesh);
  return { mesh, vel: new THREE.Vector3(), life: 0, dmg: 0, knock: 0, pierce: false, base: 1, wob: 0, hits: [] };
}

function fireProjectile(p, yaw, dmg, knock, pierce, heavy, crit) {
  if (!inited) return;
  let pr;
  if (projPool.length) pr = projPool.pop();
  else if (projActive.length + 1 <= PROJ_MAX) pr = makeProjectile();
  else { pr = projActive.shift(); pr.mesh.visible = false; } // steal oldest
  _v1.set(Math.sin(yaw), 0, Math.cos(yaw));
  const scale = (p.stats && p.stats.scale) || 1;
  pr.mesh.position.copy(p.group.position).addScaledVector(_v1, 0.9);
  pr.mesh.position.y += 0.9 * scale;
  pr.vel.copy(_v1).multiplyScalar(SHOT_SPEED);
  pr.vel.y = 1.2;
  pr.life = SHOT_LIFE;
  pr.dmg = dmg;
  pr.knock = knock;
  pr.pierce = pierce;
  pr.base = heavy ? 1.35 : 1;
  pr.crit = !!crit;
  pr.wob = rand(0, Math.PI * 2);
  pr.hits.length = 0;
  pr.mesh.scale.setScalar(pr.base);
  pr.mesh.visible = true;
  projActive.push(pr);
}

function updateProjectiles(dt) {
  for (let i = projActive.length - 1; i >= 0; i--) {
    const pr = projActive[i];
    pr.life -= dt;
    let kill = pr.life <= 0;
    if (!kill) {
      pr.vel.y -= 4.5 * dt; // gentle goo arc
      const mp = pr.mesh.position;
      mp.addScaledVector(pr.vel, dt);
      pr.wob += dt * 16;
      pr.mesh.scale.setScalar(pr.base * (1 + 0.16 * Math.sin(pr.wob)));
      pr.mesh.rotation.x += dt * 6;
      pr.mesh.rotation.z += dt * 4.2;
      if (Math.abs(mp.x) > 119 || Math.abs(mp.z) > 119) {
        kill = true;
      } else if (mp.y - 0.25 <= terrainHeight(mp.x, mp.z)) {
        spawnBurst(mp, projBurstColor, 8, 5);
        kill = true;
      } else {
        for (let j = 0; j < G.enemies.length; j++) {
          const e = G.enemies[j];
          if (!e || e.dead || !e.group) continue;
          if (pr.hits.indexOf(e) !== -1) continue;
          const s = e.sizeF || ((e.group.scale && e.group.scale.x) || 1);
          const hitR = 0.5 + 0.85 * s;
          const dx = e.group.position.x - mp.x;
          const dy = e.group.position.y + 0.6 * s - mp.y;
          const dz = e.group.position.z - mp.z;
          if (dx * dx + dy * dy + dz * dz > hitR * hitR) continue;
          damageEnemy(e, pr.dmg, { crit: pr.crit, knockback: pr.knock, fromPos: mp });
          spawnBurst(mp, projBurstColor, 8, 6);
          if (pr.pierce) { pr.hits.push(e); }
          else { kill = true; break; }
        }
      }
    }
    if (kill) {
      pr.mesh.visible = false;
      const last = projActive.length - 1;
      projActive[i] = projActive[last];
      projActive.pop();
      projPool.push(pr);
    }
  }
}

// ---------------------------------------------------------------------------
// damage routing
// ---------------------------------------------------------------------------
export function damageEnemy(enemy, amount, { crit = false, knockback = 0, fromPos = null } = {}) {
  if (!enemy || enemy.dead || !enemy.group) return;
  enemy.hp -= amount;
  enemy.hitFlash = 0.15;
  if (knockback > 0 && fromPos && enemy.vel) {
    _v1.copy(enemy.group.position).sub(fromPos);
    _v1.y = 0;
    const len = _v1.length();
    if (len > 0.001) _v1.multiplyScalar(1 / len);
    else _v1.set(Math.sin(rand(0, Math.PI * 2)), 0, Math.cos(rand(0, Math.PI * 2)));
    enemy.vel.x += _v1.x * knockback;
    enemy.vel.z += _v1.z * knockback;
    enemy.vel.y += knockback * 0.25;
  }
  const s = (enemy.group.scale && enemy.group.scale.y) || 1;
  _v2.copy(enemy.group.position);
  _v2.y += 1.4 * s;
  if (crit) spawnNumber(_v2, Math.round(amount) + '!', '#ffd24a', 1.4);
  else spawnNumber(_v2, Math.round(amount), '#ffffff', 1);
  _v2.y -= 0.5 * s;
  spawnBurst(_v2, 0xfff0f5, crit ? 14 : 8, crit ? 9 : 6);
  playSound('hit');
  if (enemy.hp <= 0) enemy.dead = true; // enemies.js handles death + respawn
}

export function damagePlayer(amount, fromPos = null) {
  const p = G.player;
  if (!p || p.dead || p.invuln > 0) return;
  const armor = (p.stats && p.stats.armor) || 0;
  const reduced = Math.max(1, amount - armor);
  p.hp -= reduced;
  p.invuln = 0.6;
  if (fromPos && p.vel && p.group) {
    _v1.copy(p.group.position).sub(fromPos);
    _v1.y = 0;
    const len = _v1.length();
    if (len > 0.001) _v1.multiplyScalar(1 / len);
    else _v1.set(0, 0, 1);
    p.vel.x += _v1.x * 10;
    p.vel.z += _v1.z * 10;
    p.vel.y += 3.5;
  }
  G.shake += 0.6;
  if (p.group) {
    _v2.copy(p.group.position);
    _v2.y += 1.6 * ((p.stats && p.stats.scale) || 1);
    spawnNumber(_v2, '-' + Math.round(reduced), '#ff7b7b', 1.1);
    _v2.y -= 0.8;
    spawnBurst(_v2, 0xff9d9d, 10, 6);
  }
  emit('player:damaged', { amount: reduced });
  playSound('hurt');
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    G.shake += 0.5;
    emit('player:died', {});
    playSound('die');
  }
}

// ---------------------------------------------------------------------------
// particles (pooled, capped, meshes reused & hidden when idle)
// ---------------------------------------------------------------------------
function makeParticle() {
  const mesh = new THREE.Mesh(
    partGeo,
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
  );
  mesh.visible = false;
  fxGroup.add(mesh);
  return { mesh, vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 0.5 };
}

function allocParticle() {
  for (let n = 0; n < parts.length; n++) {
    partCursor = (partCursor + 1) % parts.length;
    if (parts[partCursor].life <= 0) return parts[partCursor];
  }
  if (parts.length < PART_MAX) {
    const pt = makeParticle();
    parts.push(pt);
    return pt;
  }
  partCursor = (partCursor + 1) % parts.length; // steal
  return parts[partCursor];
}

export function spawnBurst(pos, color, count = 12, speed = 8) {
  if (!inited) return;
  for (let i = 0; i < count; i++) {
    const pt = allocParticle();
    const a = rand(0, Math.PI * 2);
    const up = rand(0.25, 1);
    const horiz = Math.sqrt(Math.max(0, 1 - up * up));
    pt.vel.set(Math.cos(a) * horiz, up, Math.sin(a) * horiz).multiplyScalar(speed * rand(0.5, 1.3));
    pt.mesh.position.set(pos.x + rand(-0.25, 0.25), pos.y + rand(-0.1, 0.3), pos.z + rand(-0.25, 0.25));
    pt.maxLife = rand(0.35, 0.7);
    pt.life = pt.maxLife;
    pt.size = rand(0.3, 0.75);
    pt.mesh.scale.setScalar(pt.size);
    pt.mesh.material.color.set(color);
    pt.mesh.material.opacity = 1;
    pt.mesh.visible = true;
  }
}

function updateParticles(dt) {
  for (let i = 0; i < parts.length; i++) {
    const pt = parts[i];
    if (pt.life <= 0) continue;
    pt.life -= dt;
    const m = pt.mesh;
    if (pt.life <= 0) { m.visible = false; continue; }
    pt.vel.y -= 20 * dt; // gravity
    m.position.addScaledVector(pt.vel, dt);
    if (pt.vel.y < 0) {
      const th = terrainHeight(m.position.x, m.position.z) + 0.12;
      if (m.position.y < th) {
        m.position.y = th;
        pt.vel.y *= -0.35; // goo bounce
        pt.vel.x *= 0.7;
        pt.vel.z *= 0.7;
      }
    }
    const k = pt.life / pt.maxLife;
    m.scale.setScalar(Math.max(0.001, pt.size * k)); // shrink
    m.material.opacity = k; // fade
  }
}

// ---------------------------------------------------------------------------
// damage numbers (pooled canvas sprites)
// ---------------------------------------------------------------------------
function makeNumber() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  sprite.renderOrder = 999;
  sprite.visible = false;
  fxGroup.add(sprite);
  return { sprite, canvas, ctx, tex, life: 0, maxLife: 1, base: 1.5 };
}

function allocNumber() {
  let oldest = null;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i].life <= 0) return nums[i];
    if (!oldest || nums[i].life < oldest.life) oldest = nums[i];
  }
  if (nums.length < NUM_MAX) {
    const n = makeNumber();
    nums.push(n);
    return n;
  }
  return oldest;
}

function spawnNumber(pos, text, color = '#ffffff', big = 1) {
  if (!inited) return;
  const n = allocNumber();
  const c = n.ctx, cv = n.canvas;
  c.clearRect(0, 0, cv.width, cv.height);
  c.font = "bold 54px 'Trebuchet MS', Verdana, sans-serif";
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = 10;
  c.strokeStyle = 'rgba(35,18,46,0.85)';
  const str = String(text);
  c.strokeText(str, cv.width / 2, cv.height / 2 + 2);
  c.fillStyle = color;
  c.fillText(str, cv.width / 2, cv.height / 2 + 2);
  n.tex.needsUpdate = true;
  n.sprite.position.set(pos.x + rand(-0.35, 0.35), pos.y + rand(0, 0.3), pos.z + rand(-0.35, 0.35));
  n.maxLife = 0.9;
  n.life = n.maxLife;
  n.base = 1.5 * big;
  n.sprite.scale.set(2.6 * n.base, 0.975 * n.base, 1);
  n.sprite.material.opacity = 1;
  n.sprite.visible = true;
}

export function spawnDamageNumber(pos, text, color = '#ffffff') {
  spawnNumber(pos, text, color, 1);
}

function updateNumbers(dt) {
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (n.life <= 0) continue;
    n.life -= dt;
    if (n.life <= 0) { n.sprite.visible = false; continue; }
    n.sprite.position.y += 2.6 * dt; // float up
    const age = n.maxLife - n.life;
    const pop = age < 0.12 ? 1 + 0.45 * (1 - age / 0.12) : 1; // squishy pop-in
    n.sprite.scale.set(2.6 * n.base * pop, 0.975 * n.base * pop, 1);
    n.sprite.material.opacity = Math.min(1, n.life / (n.maxLife * 0.45)); // fade out
  }
}

// ---------------------------------------------------------------------------
// expanding ground rings (pooled)
// ---------------------------------------------------------------------------
function makeRing() {
  const mesh = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  mesh.visible = false;
  fxGroup.add(mesh);
  return { mesh, life: 0, maxLife: 0.55, target: 4 };
}

function allocRing() {
  let oldest = null;
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].life <= 0) return rings[i];
    if (!oldest || rings[i].life < oldest.life) oldest = rings[i];
  }
  if (rings.length < RING_MAX) {
    const r = makeRing();
    rings.push(r);
    return r;
  }
  return oldest;
}

export function spawnRing(pos, color, radius = 4) {
  if (!inited) return;
  const r = allocRing();
  r.mesh.material.color.set(color);
  r.mesh.position.set(pos.x, terrainHeight(pos.x, pos.z) + 0.15, pos.z);
  r.maxLife = 0.55;
  r.life = r.maxLife;
  r.target = radius;
  r.mesh.scale.set(0.4, 1, 0.4);
  r.mesh.material.opacity = 0.9;
  r.mesh.visible = true;
}

function updateRings(dt) {
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (r.life <= 0) continue;
    r.life -= dt;
    if (r.life <= 0) { r.mesh.visible = false; continue; }
    const t = 1 - r.life / r.maxLife;
    const e = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
    const s = 0.4 + (r.target - 0.4) * e;
    r.mesh.scale.set(s, 1, s);
    r.mesh.material.opacity = (1 - t) * 0.9;
  }
}

// ---------------------------------------------------------------------------
// per-frame update
// ---------------------------------------------------------------------------
export function updateCombat(dt) {
  const p = G.player;
  if (p) {
    if (p.cooldowns) {
      const cds = p.cooldowns;
      for (const k in cds) if (cds[k] > 0) cds[k] = Math.max(0, cds[k] - dt);
    }
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (!p.dead && p.stats) {
      // HP / mana regen ticks
      p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.regen * dt);
      p.mana = Math.min(p.stats.maxMana, p.mana + p.stats.manaRegen * dt);
    }
  }
  if (!inited) return;
  updateProjectiles(dt);
  updateParticles(dt);
  updateNumbers(dt);
  updateRings(dt);
}

// ---------------------------------------------------------------------------
// sound — tiny WebAudio synth, lazy ctx, always try/catch safe
// ---------------------------------------------------------------------------
let actx = null;
let master = null;
let noiseBuf = null;
const lastPlay = {};

function ensureAudio() {
  if (actx) {
    if (actx.state === 'suspended') actx.resume();
    return true;
  }
  const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return false;
  actx = new AC();
  master = actx.createGain();
  master.gain.value = 0.18; // pleasant, not loud
  master.connect(actx.destination);
  if (actx.state === 'suspended') actx.resume();
  return true;
}

function tone({ f0 = 440, f1 = f0, t = 0, dur = 0.1, type = 'sine', vol = 0.4 }) {
  const now = actx.currentTime + t;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, f0), now);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + dur);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  o.connect(g);
  g.connect(master);
  o.start(now);
  o.stop(now + dur + 0.05);
}

function noiseHit({ t = 0, dur = 0.2, vol = 0.5, type = 'lowpass', freq = 800, slide = freq }) {
  if (!noiseBuf) {
    const len = (actx.sampleRate * 0.5) | 0;
    noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  const now = actx.currentTime + t;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = actx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, now);
  if (slide !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(40, slide), now + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(now);
  src.stop(now + dur + 0.05);
}

export function playSound(name) {
  try {
    const tNow = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (lastPlay[name] !== undefined && tNow - lastPlay[name] < 45) return; // de-spam same frame
    lastPlay[name] = tNow;
    if (!ensureAudio()) return;
    switch (name) {
      case 'hit': // squishy little pop
        tone({ f0: 520, f1: 170, dur: 0.07, type: 'triangle', vol: 0.5 });
        tone({ f0: 780, f1: 240, dur: 0.05, type: 'sine', vol: 0.22 });
        break;
      case 'squish': // pitch-bent gel swing
        tone({ f0: 190, f1: 74, dur: 0.13, type: 'triangle', vol: 0.55 });
        tone({ f0: 300, f1: 120, dur: 0.09, type: 'sine', vol: 0.3, t: 0.01 });
        break;
      case 'shot': // rising zip
        tone({ f0: 640, f1: 1180, dur: 0.1, type: 'sine', vol: 0.4 });
        tone({ f0: 320, f1: 560, dur: 0.07, type: 'triangle', vol: 0.2 });
        break;
      case 'slam': // noise burst + low thud
        noiseHit({ dur: 0.3, vol: 0.7, freq: 900, slide: 120 });
        tone({ f0: 120, f1: 36, dur: 0.34, type: 'sine', vol: 0.85 });
        break;
      case 'dash': // airy whoosh
        noiseHit({ dur: 0.18, vol: 0.4, type: 'bandpass', freq: 700, slide: 2400 });
        tone({ f0: 300, f1: 880, dur: 0.14, type: 'sine', vol: 0.2 });
        break;
      case 'hurt':
        tone({ f0: 210, f1: 80, dur: 0.16, type: 'square', vol: 0.3 });
        tone({ f0: 140, f1: 60, dur: 0.2, type: 'triangle', vol: 0.4, t: 0.01 });
        break;
      case 'level': { // rising arpeggio C5 E5 G5 C6
        tone({ f0: 523.25, dur: 0.18, type: 'sine', vol: 0.45 });
        tone({ f0: 659.25, t: 0.09, dur: 0.18, type: 'sine', vol: 0.45 });
        tone({ f0: 783.99, t: 0.18, dur: 0.18, type: 'sine', vol: 0.45 });
        tone({ f0: 1046.5, t: 0.27, dur: 0.45, type: 'sine', vol: 0.5 });
        tone({ f0: 1046.5, t: 0.27, dur: 0.45, type: 'triangle', vol: 0.16 });
        break;
      }
      case 'learn': // sparkly two-note chime
        tone({ f0: 660, dur: 0.12, type: 'sine', vol: 0.42 });
        tone({ f0: 990, t: 0.09, dur: 0.2, type: 'sine', vol: 0.42 });
        break;
      case 'die': // sad descend
        tone({ f0: 280, f1: 46, dur: 0.7, type: 'sawtooth', vol: 0.28 });
        tone({ f0: 190, f1: 38, dur: 0.8, type: 'sine', vol: 0.4, t: 0.04 });
        break;
      case 'coin': // classic two-step ding
        tone({ f0: 987.77, dur: 0.085, type: 'square', vol: 0.22 });
        tone({ f0: 1318.5, t: 0.085, dur: 0.3, type: 'square', vol: 0.22 });
        break;
      case 'jump':
        tone({ f0: 250, f1: 540, dur: 0.12, type: 'sine', vol: 0.3 });
        break;
      case 'denied': // soft dull blip (cooldown / no mana)
        tone({ f0: 150, f1: 96, dur: 0.08, type: 'triangle', vol: 0.22 });
        break;
      default:
        tone({ f0: 440, dur: 0.08, type: 'sine', vol: 0.2 });
    }
  } catch (e) {
    /* audio must never break the game */
  }
}
