// enemies.js — all hostile mobs + the King Gloop world boss.
// Owns spawning, respawn timers, the AI state machine, death FX and 'enemy:killed'.
// Imports allowed: three, core, world, slime, combat, party (see CONTRACT.md V2 ADDENDUM).
import * as THREE from 'three';
import { G, emit, clamp, rand, randInt, pick } from './core.js';
import { terrainHeight, WATER_LEVEL } from './world.js';
import { createSlime, animateSlime, makeNameTag, makeHpBar } from './slime.js';
import { damagePlayer, spawnBurst, spawnRing, playSound } from './combat.js';
import { damageAlly } from './party.js'; // no cycle: party.js never imports enemies.js

// ---------------------------------------------------------------- type table

const TYPES = {
  wild: {
    name: 'Wild Slime', lv: [1, 3], count: 20, size: [0.85, 1.1],
    speed: [3.4, 4.3], aggro: 9, attackRange: 2.2, atkCd: [1.6, 2.2], bounce: 1.35,
    colors: [0x7ed957, 0x99d65c, 0xb8e05e, 0xd9df63, 0x84d96e],
  },
  spike: {
    name: 'Spike Slime', lv: [4, 6], count: 15, size: [0.95, 1.15],
    speed: [4.8, 5.7], aggro: 11, attackRange: 2.2, atkCd: [1.4, 1.8], bounce: 1.1,
    colors: [0xff9a4d, 0xff8c42, 0xf2823a, 0xffa45e],
  },
  brute: {
    name: 'Mushroom Brute', lv: [6, 8], count: 11, size: [1.3, 1.5],
    speed: [2.4, 3.0], aggro: 10, attackRange: 2.5, atkCd: [1.8, 2.2], bounce: 0.85,
    dmgMul: 1.6, hpMul: 1.25,
    colors: [0x9c6b4f, 0x8d6346, 0xa5775e],
  },
  crystal: {
    name: 'Crystal Slime', lv: [9, 11], count: 13, size: [1.0, 1.2],
    speed: [4.0, 4.9], aggro: 12.5, attackRange: 2.2, atkCd: [1.5, 1.9], bounce: 1.0,
    colors: [0xab7df6, 0xb892ff, 0x9d6ef0], xpMul: 1.5,
  },
  boss: {
    name: 'King Gloop', lv: [13, 13], count: 1, size: [3.2, 3.2],
    speed: [3.5, 3.5], aggro: 13, attackRange: 4, atkCd: [1.8, 2.2], bounce: 0.9,
    colors: [0xffb347],
  },
};

const BOSS_SLAM_RADIUS = 7;
const BOSS_RESPAWN = 90;

// ---------------------------------------------------------------- module state

const pending = [];   // { type, timer } — scheduled respawns
const corpses = [];   // { e, t, dur } — death squash-out animations
const hpBarPool = []; // { bar, base } — recycled slime.makeHpBar instances
let cornerIdx = 0;    // rotates Crystal Slimes through the 4 hollows
let assets = null;    // lazy shared geometries/materials for attachments

// scratch — never allocate these in the per-frame path
const _v1 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const C_DARK = new THREE.Color(0x2b1d33);
const C_FLASH = new THREE.Color(0xff7468);
const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function ensureAssets() {
  if (assets) return assets;
  const std = (o) => new THREE.MeshStandardMaterial(
    Object.assign({ flatShading: true, roughness: 0.85, metalness: 0.05 }, o));
  assets = {
    spikeGeo: new THREE.ConeGeometry(0.09, 0.3, 5),
    spikeMat: std({ color: 0x4f3a2e }),
    capGeo: new THREE.SphereGeometry(0.5, 8, 6),
    capMat: std({ color: 0xe05548 }),
    dotGeo: new THREE.SphereGeometry(0.085, 5, 4),
    dotMat: std({ color: 0xfff3da }),
    shardGeo: new THREE.OctahedronGeometry(0.13),
    shardMat: std({ color: 0xd6bdff, emissive: 0x8b5cf6, emissiveIntensity: 0.85, roughness: 0.4 }),
    bandGeo: new THREE.CylinderGeometry(0.36, 0.42, 0.16, 8, 1, true),
    prongGeo: new THREE.ConeGeometry(0.075, 0.22, 4),
    goldMat: std({
      color: 0xffd24a, emissive: 0x4a3500, emissiveIntensity: 0.5,
      metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide,
    }),
  };
  return assets;
}

// ---------------------------------------------------------------- attachments

function addSpikes(inner, size) {
  const a = ensureAssets();
  for (let i = 0; i < 7; i++) {
    const phi = i * 2.39996 + 0.7;
    const yy = 0.25 + 0.62 * (i / 6);
    const rr = Math.sqrt(Math.max(0.05, 1 - yy * yy));
    _v1.set(Math.cos(phi) * rr, yy, Math.sin(phi) * rr).normalize();
    const m = new THREE.Mesh(a.spikeGeo, a.spikeMat);
    m.position.copy(_v1).multiplyScalar(0.52 * size);
    m.position.y *= 0.78;
    m.quaternion.setFromUnitVectors(UP, _v1);
    m.scale.setScalar(size * rand(0.85, 1.25));
    m.castShadow = true;
    inner.add(m);
  }
}

function addMushroomCap(inner, size) {
  const a = ensureAssets();
  const cap = new THREE.Mesh(a.capGeo, a.capMat);
  cap.scale.set(size * 0.92, size * 0.55, size * 0.92);
  cap.position.y = 0.46 * size;
  cap.rotation.z = 0.14;
  cap.castShadow = true;
  inner.add(cap);
  for (let i = 0; i < 6; i++) {
    const phi = i * 2.39996;
    const yy = 0.35 + 0.5 * ((i % 3) / 3);
    const rr = Math.sqrt(Math.max(0.05, 1 - yy * yy));
    const dot = new THREE.Mesh(a.dotGeo, a.dotMat);
    dot.position.set(Math.cos(phi) * rr * 0.5, yy * 0.5, Math.sin(phi) * rr * 0.5);
    cap.add(dot);
  }
}

function addShards(inner, size) {
  const a = ensureAssets();
  for (let i = 0; i < 5; i++) {
    const phi = i * 2.39996 + 1.3;
    const yy = 0.4 + 0.5 * (i / 4);
    const rr = Math.sqrt(Math.max(0.05, 1 - yy * yy));
    _v1.set(Math.cos(phi) * rr, yy, Math.sin(phi) * rr).normalize();
    const m = new THREE.Mesh(a.shardGeo, a.shardMat);
    m.position.copy(_v1).multiplyScalar(0.5 * size);
    m.position.y *= 0.8;
    m.quaternion.setFromUnitVectors(UP, _v1);
    m.scale.set(size * rand(0.8, 1.1), size * rand(1.7, 2.6), size * rand(0.8, 1.1));
    m.castShadow = true;
    inner.add(m);
  }
}

function addCrown(inner, size) {
  const a = ensureAssets();
  const crown = new THREE.Group();
  const band = new THREE.Mesh(a.bandGeo, a.goldMat);
  band.castShadow = true;
  crown.add(band);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const p = new THREE.Mesh(a.prongGeo, a.goldMat);
    p.position.set(Math.cos(ang) * 0.36, 0.16, Math.sin(ang) * 0.36);
    p.castShadow = true;
    crown.add(p);
  }
  crown.scale.setScalar(size * 0.62);
  crown.position.y = 0.5 * size;
  crown.rotation.z = 0.1;
  inner.add(crown);
}

// Clone materials per-enemy (slime.js caches/shares them) so hit flash, windup
// darken and corpse fade never bleed onto siblings. Map keeps within-group sharing.
function collectMats(root) {
  const seen = new Map();
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
    let m = seen.get(o.material);
    if (!m) {
      m = o.material.clone();
      seen.set(o.material, m);
      out.push({ m, c: m.color ? m.color.clone() : null, e: m.emissive ? m.emissive.clone() : null });
    }
    o.material = m;
  });
  return out;
}

// ---------------------------------------------------------------- spawning

function spotFor(type) {
  for (let i = 0; i < 30; i++) {
    let x, z;
    if (type === 'boss') { x = 0; z = 92; }
    else if (type === 'wild') {
      const a = rand(Math.PI * 2), r = rand(20, 52);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } else if (type === 'crystal') {
      const c = CORNERS[cornerIdx % 4];
      x = c[0] * rand(82, 107); z = c[1] * rand(82, 107);
    } else { // spike + brute: Whisperwood ring
      const a = rand(Math.PI * 2), r = rand(55, 95);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    }
    if (Math.abs(x) > 110 || Math.abs(z) > 110) continue;
    if (type !== 'boss') {
      if (Math.hypot(x, z) < 19) continue;            // Slime Plaza is safe
      if (Math.hypot(x, z - 92) < 20) continue;       // keep trash out of the arena
      if (terrainHeight(x, z) < WATER_LEVEL + 0.25) continue; // not in the lake
    }
    if (type === 'crystal') cornerIdx++;
    return new THREE.Vector3(x, terrainHeight(x, z), z);
  }
  const f = type === 'boss' ? [0, 92] : type === 'wild' ? [34, 8]
    : type === 'crystal' ? [92, 92] : [0, -72];
  return new THREE.Vector3(f[0], terrainHeight(f[0], f[1]), f[1]);
}

function acquireHpBar() {
  const rec = hpBarPool.pop();
  if (rec) return rec;
  const bar = makeHpBar();
  return { bar, base: bar.sprite.scale.clone() };
}

function spawnEnemy(typeKey, atPos = null, minion = false) {
  const cfg = TYPES[typeKey];
  const home = atPos ? atPos.clone() : spotFor(typeKey); // clone FIRST: atPos may be scratch
  home.y = terrainHeight(home.x, home.z);

  const level = randInt(cfg.lv[0], cfg.lv[1]);
  const size = rand(cfg.size[0], cfg.size[1]);
  const color = pick(cfg.colors);

  const group = new THREE.Group();
  const inner = createSlime({ color, size });
  group.add(inner);

  if (typeKey === 'spike') addSpikes(inner, size);
  else if (typeKey === 'brute') addMushroomCap(inner, size);
  else if (typeKey === 'crystal') addShards(inner, size);
  else if (typeKey === 'boss') addCrown(inner, size);

  const mats = collectMats(inner);
  if (typeKey === 'crystal') {
    for (const t of mats) { // gel-translucent body; keep dark eye materials solid
      if (t.c && (t.c.r + t.c.g + t.c.b) > 0.75) { t.m.transparent = true; t.m.opacity = 0.82; }
    }
  }

  group.position.copy(home);

  const hpMul = cfg.hpMul || 1;
  const dmgMul = cfg.dmgMul || 1;
  const e = {
    // contract shape
    group, type: typeKey, name: cfg.name, level,
    maxHp: typeKey === 'boss' ? 1000 : Math.round((20 + 8 * level) * hpMul),
    hp: 0,
    damage: Math.round((3 + 1.5 * level) * dmgMul),
    speed: rand(cfg.speed[0], cfg.speed[1]),
    xpValue: typeKey === 'boss' ? 260 : Math.round((8 + 4 * level) * (cfg.xpMul || 1)),
    goldValue: typeKey === 'boss' ? 50 + randInt(0, 15) : level + randInt(0, 3),
    state: minion ? 'chase' : 'idle',
    homePos: home,
    aggroRange: cfg.aggro + rand(-0.5, 0.5),
    attackRange: cfg.attackRange,
    attackTimer: 0,
    vel: new THREE.Vector3(),
    dead: false,
    hitFlash: 0,
    hpBar: null,
    // internals
    inner, mats, color, sizeF: size, radius: 0.8 * size,
    bounce: cfg.bounce, atkCd: cfg.atkCd,
    stateTimer: rand(0.5, 2.5), wanderTarget: home.clone(),
    windupT: 0, yaw: rand(Math.PI * 2), lastFrac: -1,
    minion, tinted: false, hpBarRec: null, tag: null,
    slamTimer: 3.5, slamWarn: 0, enraged: false,
  };
  e.hp = e.maxHp;
  group.rotation.y = e.yaw;

  const rec = acquireHpBar();
  rec.bar.sprite.scale.copy(rec.base);
  if (typeKey === 'boss') rec.bar.sprite.scale.multiplyScalar(2.4);
  rec.bar.sprite.position.set(0, size * 0.95 + 0.55, 0);
  rec.bar.sprite.visible = false;
  rec.bar.set(1);
  group.add(rec.bar.sprite);
  e.hpBar = rec.bar;
  e.hpBarRec = rec;

  if (typeKey === 'boss') {
    e.tag = makeNameTag('King Gloop 👑', { color: '#ffd24a', sub: 'Lv 13 · World Boss' });
    e.tag.position.set(0, size * 1.05 + 1.0, 0);
    group.add(e.tag);
  }

  G.scene.add(group);
  G.enemies.push(e);
  return e;
}

// ---------------------------------------------------------------- death

function killEnemy(e, idx) {
  G.enemies.splice(idx, 1);
  e.state = 'dying';
  emit('enemy:killed', { enemy: e });

  playSound('squish');
  playSound('coin');
  spawnBurst(e.group.position, e.color, e.type === 'boss' ? 34 : 16, e.type === 'boss' ? 12 : 8);
  spawnBurst(e.group.position, 0xffd95a, e.type === 'boss' ? 14 : 6, 9); // golden coin sparkle

  if (e.hpBarRec) {
    e.group.remove(e.hpBar.sprite);
    e.hpBar.sprite.visible = false;
    hpBarPool.push(e.hpBarRec);
    e.hpBar = null;
    e.hpBarRec = null;
  }

  if (e.type === 'boss') {
    const who = (G.player && G.player.name) || 'A brave slime';
    emit('chat', { from: '⚔ Realm', system: true, text: who + ' has slain King Gloop!' });
    spawnRing(e.group.position, 0xffd24a, 6);
    G.shake += 1.2;
    // the king's court dissolves with him — silently despawn leftover enrage minions
    for (let j = G.enemies.length - 1; j >= 0; j--) {
      const m = G.enemies[j];
      if (!m.minion) continue;
      G.enemies.splice(j, 1);
      m.state = 'dying';
      spawnBurst(m.group.position, m.color, 8, 6);
      if (m.hpBarRec) {
        m.group.remove(m.hpBar.sprite);
        m.hpBar.sprite.visible = false;
        hpBarPool.push(m.hpBarRec);
        m.hpBar = null;
        m.hpBarRec = null;
      }
      for (const t of m.mats) t.m.transparent = true;
      corpses.push({ e: m, t: 0, dur: 0.32 });
    }
  }

  for (const t of e.mats) t.m.transparent = true; // allow corpse fade
  corpses.push({ e, t: 0, dur: e.type === 'boss' ? 0.5 : 0.32 });

  if (!e.minion) pending.push({ type: e.type, timer: e.type === 'boss' ? BOSS_RESPAWN : rand(12, 25) });
}

// ---------------------------------------------------------------- AI helpers

// V2 multi-target: candidates = player (alive) + party bots (!downed).
// Module-level scratch record — resolveTarget fills it, callers read it
// immediately within the same enemy's update. Zero per-frame allocations;
// _tg.pos is a live reference to the candidate group's position Vector3.
const _tg = { bot: null, pos: null, dist: Infinity };

function resolveTarget(pos, pg, pAlive) {
  _tg.bot = null;
  _tg.pos = null;
  _tg.dist = Infinity;
  if (pAlive) {
    _tg.pos = pg.position;
    _tg.dist = pos.distanceTo(pg.position);
  }
  const party = G.party;
  for (let i = 0; i < party.length; i++) {
    const b = party[i];
    if (!b || b.downed || !b.group) continue;
    const d = pos.distanceTo(b.group.position);
    if (d < _tg.dist) { _tg.dist = d; _tg.bot = b; _tg.pos = b.group.position; }
  }
}

// strike/slam delivery: route to combat.damagePlayer or party.damageAlly
function hitCandidate(bot, amount, fromPos) {
  if (bot) damageAlly(bot, amount, fromPos);
  else damagePlayer(amount, fromPos);
}

function faceTowards(e, p) {
  e.yaw = Math.atan2(p.x - e.group.position.x, p.z - e.group.position.z);
}

function applyTint(e) {
  const flash = Math.min(1, clamp(e.hitFlash, 0, 1) * 1.4);
  let dark = 0;
  if (e.state === 'windup' || e.slamWarn > 0) dark = 0.3 + 0.18 * Math.sin(G.time * 28);
  const active = flash > 0.003 || dark > 0.003;
  if (!active && !e.tinted) return; // skip untouched idle mobs entirely
  for (let k = 0; k < e.mats.length; k++) {
    const t = e.mats[k];
    if (t.c) { t.m.color.copy(t.c); if (dark > 0) t.m.color.lerp(C_DARK, dark); }
    if (t.e) { t.m.emissive.copy(t.e); if (flash > 0) t.m.emissive.lerp(C_FLASH, flash); }
  }
  e.tinted = active;
}

function updateBoss(e, dt, pg, pAlive, dp) {
  // enrage once at half health: minions + taunt
  if (!e.enraged && e.hp <= e.maxHp * 0.5) {
    e.enraged = true;
    emit('chat', { from: 'King Gloop 👑', text: 'WHO DARES JIGGLE IN MY ARENA?', color: '#ffb347' });
    G.shake += 0.6;
    for (let k = 0; k < 2; k++) {
      _v1.set(e.group.position.x + (k ? 3.2 : -3.2), 0, e.group.position.z + rand(-1.5, 1.5));
      const m = spawnEnemy('wild', _v1, true);
      m.aggroRange = 16; // minions latch on immediately and stay on
    }
  }

  if (e.slamWarn > 0) {
    const before = e.slamWarn;
    e.slamWarn -= dt;
    if (before > 0.45 && e.slamWarn <= 0.45 && e.slamWarn > 0) {
      spawnRing(e.group.position, 0xff7042, BOSS_SLAM_RADIUS); // second warning pulse
    }
    if (e.slamWarn <= 0) {
      const bp = e.group.position;
      spawnRing(bp, 0xffcf5e, BOSS_SLAM_RADIUS);
      spawnBurst(bp, 0xffa843, 26, 13);
      playSound('slam');
      G.shake += 1.1;
      const slamDmg = Math.round(e.damage * 1.8);
      if (pAlive && bp.distanceTo(pg.position) <= BOSS_SLAM_RADIUS + 0.5) {
        damagePlayer(slamDmg, bp);
      }
      const party = G.party; // allies caught in the shockwave too
      for (let k = 0; k < party.length; k++) {
        const b = party[k];
        if (!b || b.downed || !b.group) continue;
        if (bp.distanceTo(b.group.position) <= BOSS_SLAM_RADIUS + 0.5) {
          damageAlly(b, slamDmg, bp);
        }
      }
      e.slamTimer = rand(6, 8.5);
    }
  } else if (e.state === 'chase' || e.state === 'windup') {
    e.slamTimer -= dt;
    // dp = distance to nearest candidate (player or party bot); finite implies one exists
    if (e.slamTimer <= 0 && e.state === 'chase' && dp < 15) {
      e.slamWarn = 0.9;
      spawnRing(e.group.position, 0xff7042, BOSS_SLAM_RADIUS); // telegraph
      G.shake += 0.25;
    }
  }
}

function updateEnemy(e, dt, pg, pAlive) {
  const pos = e.group.position;
  e.attackTimer = Math.max(0, e.attackTimer - dt);
  if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4.5);

  // nearest candidate (player or party bot) re-resolved every frame; dp = its distance
  resolveTarget(pos, pg, pAlive);
  const dp = _tg.dist;

  let speedMul = 0;
  let tx = pos.x, tz = pos.z;

  switch (e.state) {
    case 'idle': {
      e.stateTimer -= dt;
      if (e.stateTimer <= 0) {
        const a = rand(Math.PI * 2), r = rand(1.5, 6);
        e.wanderTarget.set(e.homePos.x + Math.cos(a) * r, 0, e.homePos.z + Math.sin(a) * r);
        e.state = 'wander';
        e.stateTimer = rand(4, 7); // wander timeout
      }
      break;
    }
    case 'wander': {
      e.stateTimer -= dt;
      tx = e.wanderTarget.x; tz = e.wanderTarget.z;
      speedMul = 0.5;
      if (e.stateTimer <= 0 || Math.hypot(tx - pos.x, tz - pos.z) < 0.6) {
        e.state = 'idle';
        e.stateTimer = rand(0.8, 2.6);
        speedMul = 0;
      }
      break;
    }
    case 'chase': {
      if (!_tg.pos || dp > e.aggroRange * 1.6) { e.state = 'return'; break; }
      tx = _tg.pos.x; tz = _tg.pos.z;
      speedMul = 1;
      if (dp <= e.attackRange && e.attackTimer <= 0 && e.slamWarn <= 0) {
        e.state = 'windup';
        e.windupT = 0.4;
        speedMul = 0;
      }
      break;
    }
    case 'windup': {
      e.windupT -= dt;
      if (_tg.pos) faceTowards(e, _tg.pos);
      if (e.windupT <= 0) {
        if (_tg.pos && dp <= e.attackRange + 0.6) {
          hitCandidate(_tg.bot, e.damage, pos); // player -> damagePlayer, bot -> damageAlly
          _v1.set(_tg.pos.x - pos.x, 0, _tg.pos.z - pos.z);
          if (_v1.lengthSq() > 1e-4) e.vel.add(_v1.normalize().multiplyScalar(4)); // little lunge
        }
        e.attackTimer = rand(e.atkCd[0], e.atkCd[1]);
        e.state = (_tg.pos && dp < e.aggroRange * 1.6) ? 'chase' : 'return';
      }
      break;
    }
    case 'return': {
      tx = e.homePos.x; tz = e.homePos.z;
      speedMul = 1;
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * dt * 0.4); // leashed: heal back up
      if (Math.hypot(tx - pos.x, tz - pos.z) < 1.2) {
        e.hp = e.maxHp;
        e.state = 'idle';
        e.stateTimer = rand(0.5, 2);
        speedMul = 0;
      }
      break;
    }
  }

  // aggro from peaceful states (1.5x retaliation stays under the 1.6x leash — no flip-flop)
  // dp is the nearest candidate, so a hit while wandering retaliates at player OR ally.
  // Any hp drop provokes a chase regardless of range (anti-snipe: chase -> leash ->
  // return -> full heal), and out-of-combat mobs slowly shrug chip damage off.
  const provoked = e.lastHp !== undefined && e.hp < e.lastHp - 0.01;
  if ((e.state === 'idle' || e.state === 'wander') && e.hp < e.maxHp) {
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * dt * 0.02);
  }
  e.lastHp = e.hp;
  if ((e.state === 'idle' || e.state === 'wander') && _tg.pos &&
      (provoked || dp < e.aggroRange || (e.hp < e.maxHp - 0.5 && dp < e.aggroRange * 1.5))) {
    e.state = 'chase';
  }

  if (e.type === 'boss') {
    updateBoss(e, dt, pg, pAlive, dp);
    if (e.slamWarn > 0) {
      speedMul = 0; // rooted while telegraphing the slam
      if (_tg.pos) faceTowards(e, _tg.pos);
    }
  }

  // steering + integration
  if (speedMul > 0) {
    _v1.set(tx - pos.x, 0, tz - pos.z);
    const d = _v1.length();
    if (d > 0.05) {
      const k = (e.speed * speedMul) / d;
      e.vel.x += (_v1.x * k - e.vel.x) * Math.min(1, dt * 5);
      e.vel.z += (_v1.z * k - e.vel.z) * Math.min(1, dt * 5);
    }
  } else {
    const f = Math.max(0, 1 - dt * 7);
    e.vel.x *= f;
    e.vel.z *= f;
  }
  pos.x = clamp(pos.x + e.vel.x * dt, -112, 112);
  pos.z = clamp(pos.z + e.vel.z * dt, -112, 112);
  pos.y = terrainHeight(pos.x, pos.z);

  // face velocity (windup/slam override above by writing e.yaw directly)
  const hs = Math.hypot(e.vel.x, e.vel.z);
  if (hs > 0.6 && e.state !== 'windup' && e.slamWarn <= 0) {
    e.yaw = Math.atan2(e.vel.x, e.vel.z);
  }
  let dy = e.yaw - e.group.rotation.y;
  dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  e.group.rotation.y += dy * Math.min(1, dt * 10);

  // squash & stretch lives on the inner slime; telegraph squash on the outer group
  animateSlime(e.inner, dt, { moving: hs > 0.5, grounded: true, speed: hs * e.bounce });
  let sq = 0;
  if (e.state === 'windup') sq = 0.3 * (1 - Math.max(0, e.windupT) / 0.4);
  if (e.slamWarn > 0) sq = Math.max(sq, 0.35 * (1 - e.slamWarn / 0.9));
  e.group.scale.set(1 + sq * 0.7, 1 - sq, 1 + sq * 0.7);

  applyTint(e);

  // hp bar: only when aggro or hurt; redraw only when the fraction moved
  const aggro = e.state === 'chase' || e.state === 'windup' || e.slamWarn > 0;
  const show = aggro || e.hp < e.maxHp - 0.5;
  if (e.hpBar.sprite.visible !== show) e.hpBar.sprite.visible = show;
  if (show) {
    const frac = clamp(e.hp / e.maxHp, 0, 1);
    if (Math.abs(frac - e.lastFrac) > 0.003) {
      e.hpBar.set(frac);
      e.lastFrac = frac;
    }
  }
}

// soft pairwise separation push (~60 mobs → ~1770 cheap pair checks, early-out on distance)
function separation() {
  const list = G.enemies;
  for (let i = 0; i < list.length; i++) {
    const a = list[i], ap = a.group.position;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j], bp = b.group.position;
      const dx = bp.x - ap.x, dz = bp.z - ap.z;
      const rr = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const sep = (rr - d) * 0.5; // soft: resolve half the overlap per frame
      const nx = dx / d, nz = dz / d;
      const wa = b.sizeF / (a.sizeF + b.sizeF); // big slimes barely budge
      ap.x -= nx * sep * wa; ap.z -= nz * sep * wa;
      bp.x += nx * sep * (1 - wa); bp.z += nz * sep * (1 - wa);
      ap.y = terrainHeight(ap.x, ap.z);
      bp.y = terrainHeight(bp.x, bp.z);
    }
  }
}

// ---------------------------------------------------------------- public API

export function initEnemies() {
  for (const e of G.enemies) G.scene.remove(e.group);
  G.enemies.length = 0;
  for (const c of corpses) G.scene.remove(c.e.group);
  corpses.length = 0;
  pending.length = 0;
  cornerIdx = 0;
  for (const key of Object.keys(TYPES)) {
    for (let n = 0; n < TYPES[key].count; n++) spawnEnemy(key);
  }
}

export function updateEnemies(dt) {
  if (!G.scene) return;

  // scheduled respawns
  for (let i = pending.length - 1; i >= 0; i--) {
    pending[i].timer -= dt;
    if (pending[i].timer <= 0) {
      const type = pending[i].type;
      pending.splice(i, 1);
      spawnEnemy(type);
    }
  }

  // corpse squash-out + fade, then cleanup
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i];
    c.t += dt;
    const p = c.t / c.dur;
    if (p >= 1) {
      G.scene.remove(c.e.group);
      for (const t of c.e.mats) t.m.dispose(); // per-enemy clones; shared geometry untouched
      if (c.e.tag) {
        if (c.e.tag.material.map) c.e.tag.material.map.dispose();
        c.e.tag.material.dispose();
      }
      corpses.splice(i, 1);
      continue;
    }
    c.e.group.scale.set(1 + p * 1.2, Math.max(0.04, 1 - p * p), 1 + p * 1.2);
    for (const t of c.e.mats) t.m.opacity = 1 - p;
  }

  const pl = G.player;
  const pg = pl ? pl.group : null;
  const pAlive = !!(pg && !pl.dead);

  for (let i = G.enemies.length - 1; i >= 0; i--) {
    const e = G.enemies[i];
    if (e.dead) { killEnemy(e, i); continue; } // combat set the flag; we own the funeral
    updateEnemy(e, dt, pg, pAlive);
  }

  separation();
}
