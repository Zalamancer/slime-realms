// party.js — recruit bot slimes into the player's party and fight together.
// Owns G.party (max 3): E-key invites, formation follow, ally combat AI,
// downed/revive flow. Bot objects arrive via invite (bots.js skips bots with
// bot.party === true; party.js fully drives them while partied).
// Exports: initParty, updateParty, getInviteTarget, removeFromParty, disband,
// damageAlly. See CONTRACT.md — V2 ADDENDUM (party.js section).
//
// Imports per the addendum: core, world (terrainHeight), slime (animateSlime),
// combat (damageEnemy/spawnBurst/spawnRing/spawnDamageNumber/playSound).
// Never imports enemies.js / bots.js — reads G.enemies / G.bots only.
import * as THREE from 'three';
import { G, emit, clamp, rand, pick, dist2d } from './core.js';
import { terrainHeight } from './world.js';
import { animateSlime } from './slime.js';
import {
  damageEnemy, spawnBurst, spawnRing, spawnDamageNumber, playSound,
} from './combat.js';

// ---------------------------------------------------------------- constants
const MAX_PARTY = 3;
const INVITE_RANGE = 6;        // u — E-key invite reach
const WALK_SPEED = 7.5;        // u/s toward formation slot / target
const SPRINT_MULT = 1.5;       // when far behind the player
const SPRINT_DIST = 18;        // u from player before sprinting
const TELEPORT_DIST = 60;      // u from player before snapping to the slot
const ATTACK_RANGE = 2.6;      // melee reach (plus a slice of enemy radius)
const ENGAGE_PLAYER = 16;      // aggroed enemies within this of the player
const ENGAGE_SELF = 10;        // any enemy within this of the bot itself
const LEASH_DROP = 26;         // drop targets that stray this far from player
const DOWN_TIME = 8;           // seconds knocked out
const REVIVE_FRAC = 0.6;       // revive hp fraction
const FLAT_X = 1.45, FLAT_Y = 0.22; // downed puddle scale (× baseScale)
const PARTY_BLUE = '#7ec8ff';  // same chat color bots.js uses
const PARTY_RING = 0x7ec8ff;

// Formation slots: [right, back] offsets relative to the player's facing,
// ~2.2u spacing — two flanking behind, one further back center.
const SLOTS = [[-2.2, -2.2], [2.2, -2.2], [0, -3.3]];

// Mirrors of world facts party.js may not import (addendum allows terrainHeight
// only). Values are pinned by CONTRACT.md: WATER_LEVEL = 0.9, lake at (-70, 40).
const WATER_Y = 0.9;
const LAKE_X = -70, LAKE_Z = 40, LAKE_R = 28;

const ACCEPT_LINES = [
  'inv accepted, omw!', 'sure lol', 'yooo lets goooo', 'party time!!',
  'k omw', 'finally someone invited me', 'oh heck yes',
];
const THANKS_LINES = [
  'ty for the party!', 'gg party, that was fun', 'good runs, cya around',
  'ty ty, off to roam again', 'o7 party',
];
const DOWN_LINES = ['oof', 'rip me', 'im down lol', 'ow ow ow', 'tell my goo i loved her'];
const UP_LINES = ['im ok lol', 'im ok lol', 'we are SO back', 'phew, that was close'];
const KILL_QUIPS = ['get rekt', 'ez', 'gottem', 'bonk lol', 'next!', 'too ez'];

// ------------------------------------------------------------------ scratch
const _pos = new THREE.Vector3();
const ATK_OPTS = { crit: false, knockback: 5, fromPos: null }; // reused options bag
let _slotX = 0, _slotZ = 0; // slotPoint() output

// ------------------------------------------------------------- module state
let inited = false;
let fullMsgCD = 0;   // throttle 'Your party is full.' while E-mashing
let squishCD = 0;    // throttle ally attack squish sounds
let hitSndCD = 0;    // throttle ally-hurt sounds
const pending = [];  // [{ t, fn }] delayed chats (acceptance, quips, thanks)

function schedule(t, fn) { pending.push({ t, fn }); }

function partySay(bot, text) {
  if (!bot || !text || bot.state === 'leaving') return;
  emit('chat', { from: bot.name, text, color: PARTY_BLUE });
  bot.chatTimer = 14; // play nice with bots.js's personal chat cooldown
}

function inLake(x, z) { return dist2d(x, z, LAKE_X, LAKE_Z) < LAKE_R; }

// Defensive: derive combat fields from level (addendum formulas) if bots.js's
// concurrent edit hasn't landed / a stale bot object slips through.
function ensureCombatFields(bot) {
  const lv = bot.level || 1;
  if (!Number.isFinite(bot.maxHp)) bot.maxHp = 60 + 10 * lv;
  if (!Number.isFinite(bot.hp)) bot.hp = bot.maxHp;
  if (!Number.isFinite(bot.dmg)) bot.dmg = 4 + 1.2 * lv;
  if (bot.downed === undefined) bot.downed = false;
  if (bot.party === undefined) bot.party = false;
}

// Per-member private state lives on bot._pt (no clash with bots.js fields —
// bot.target stays the bots.js waypoint Vector3; the enemy ref is pt.target).
function makePt(bot) {
  const pt = bot._pt || {};
  pt.atk = rand(0.5, 1.0);     // seconds until next bounce attack
  pt.reT = 0;                  // retarget scan timer
  pt.target = null;            // current enemy ref
  pt.jx = 0; pt.jz = 0; pt.jT = 0; // wander jitter on the slot point
  pt.hopA = 0; pt.hopD = 0.5;  // hop-in-place anim (remaining / duration)
  pt.hopT = rand(1.5, 4);      // time until next idle hop
  pt.downT = 0;
  if (!pt.tag && bot.group) {  // name-tag sprite (kept readable while downed)
    const ch = bot.group.children;
    for (let i = 0; i < ch.length; i++) {
      if (ch[i].isSprite) { pt.tag = ch[i]; break; }
    }
  }
  if (pt.tag && pt.tagSX === undefined) { // capture pristine values exactly once
    pt.tagSX = pt.tag.scale.x;
    pt.tagSY = pt.tag.scale.y;
    pt.tagY = pt.tag.position.y;
  }
  bot._pt = pt;
  return pt;
}

function restoreTag(pt) {
  if (pt && pt.tag && pt.tagSX !== undefined) {
    pt.tag.scale.set(pt.tagSX, pt.tagSY, 1);
    pt.tag.position.y = pt.tagY;
  }
}

// --------------------------------------------------------------- invitation
function findInvitable() {
  const pl = G.player;
  const pg = pl && pl.group;
  if (!pg) return null;
  const px = pg.position.x, pz = pg.position.z;
  let best = null, bestD = INVITE_RANGE;
  for (let i = 0; i < G.bots.length; i++) {
    const b = G.bots[i];
    if (!b || !b.group || b.party || b.downed) continue;
    if (b.state === 'joining' || b.state === 'leaving') continue;
    if (b._reinviteUntil && G.time < b._reinviteUntil) continue; // KO debt: no instant re-invite
    const d = dist2d(b.group.position.x, b.group.position.z, px, pz);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

export function getInviteTarget() {
  if (!inited || !G.started || G.party.length >= MAX_PARTY) return null;
  return findInvitable();
}

function invite(bot) {
  ensureCombatFields(bot);
  // keep existing wounds (no ✕+E free heal); bots regen while roaming via bots.js
  if (!Number.isFinite(bot.hp) || bot.hp <= 0) bot.hp = bot.maxHp;
  bot.party = true;
  bot.downed = false;
  bot.state = 'idle'; // neutral — bots.js skips partied bots; flag is authoritative
  if (bot.vel) bot.vel.set(0, 0, 0);
  makePt(bot);
  G.party.push(bot);
  emit('party:changed', {});
  const g = bot.group;
  if (g) {
    spawnRing(g.position, PARTY_RING, 2.2);
    _pos.set(g.position.x, g.position.y + 0.8, g.position.z);
    spawnBurst(_pos, bot.color || PARTY_RING, 10, 6);
    if (g.userData) g.userData.squash = Math.max(g.userData.squash || 0, 0.26); // excited boing
  }
  playSound('learn');
  schedule(0.55 + rand(0, 0.3), () => partySay(bot, pick(ACCEPT_LINES)));
}

// --------------------------------------------------------- leaving the party
export function removeFromParty(bot) {
  const i = G.party.indexOf(bot);
  if (i === -1) return;
  G.party.splice(i, 1);
  bot.party = false;
  if (bot.downed) {
    // KO debt survives removal — ✕ then E must not be an instant battle-rez
    bot.hp = Math.round((bot.maxHp || 60) * REVIVE_FRAC);
    bot._reinviteUntil = G.time + ((bot._pt && bot._pt.downT > 0) ? bot._pt.downT : 0) + 4;
  }
  bot.downed = false;
  const g = bot.group;
  if (g) {
    const ud = g.userData || {};
    ud.squash = 0; ud.sx = 1; ud.sy = 1;
    const b = ud.baseScale || 1;
    g.scale.set(b, b, b); // restore scale even if removed mid-downed
    // hand the slime back to bots.js in a clean roaming state
    bot.state = 'idle';
    bot.timer = rand(1, 4);
    if (bot.vel) bot.vel.set(0, 0, 0);
    bot.yawTarget = g.rotation.y;
    if (bot.target && bot.target.set) bot.target.set(g.position.x, 0, g.position.z);
  }
  if (bot._pt) {
    restoreTag(bot._pt);
    bot._pt.target = null;
    bot._pt.downT = 0;
  }
  schedule(rand(0.3, 1.2), () => partySay(bot, pick(THANKS_LINES)));
  emit('party:changed', {});
}

export function disband() {
  while (G.party.length > 0) removeFromParty(G.party[G.party.length - 1]);
}

// ------------------------------------------------------------- taking damage
export function damageAlly(bot, amount, fromPos) {
  if (!bot || !bot.group || bot.downed) return;
  ensureCombatFields(bot);
  const dmg = Math.max(1, Math.round(amount || 0));
  bot.hp = Math.max(0, bot.hp - dmg);
  const p = bot.group.position;
  const b = (bot.group.userData && bot.group.userData.baseScale) || 1;
  _pos.set(p.x, p.y + 1.5 * b, p.z);
  spawnDamageNumber(_pos, '-' + dmg, '#ff9d9d'); // soft red — ally hurt
  _pos.y -= 0.8 * b;
  spawnBurst(_pos, 0xffb3bd, 6, 5);
  if (bot.group.userData) {
    bot.group.userData.squash = Math.max(bot.group.userData.squash || 0, 0.3);
  }
  if (fromPos) { // tiny stagger away from the attacker
    const dx = p.x - fromPos.x, dz = p.z - fromPos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) { p.x += (dx / d) * 0.35; p.z += (dz / d) * 0.35; }
  }
  if (hitSndCD <= 0) { playSound('hit'); hitSndCD = 0.3; }
  if (bot.hp <= 0) {
    // only actual party members go down; strays (shouldn't happen) just survive at 1
    if (G.party.indexOf(bot) !== -1) downBot(bot);
    else bot.hp = 1;
  }
}

function downBot(bot) {
  bot.downed = true;
  bot.hp = 0;
  const pt = makePt(bot); // resets timers; preserves tag capture
  pt.downT = DOWN_TIME;
  pt.target = null;
  if (bot.vel) bot.vel.set(0, 0, 0);
  if (bot.group && bot.group.userData) bot.group.userData.squash = 0;
  playSound('squish'); // soft splat
  emit('ally:downed', { bot });
  schedule(rand(0.3, 0.8), () => { if (bot.downed) partySay(bot, pick(DOWN_LINES)); });
}

function reviveBot(bot, pt, ud) {
  bot.downed = false;
  bot.hp = Math.round((bot.maxHp || 60) * REVIVE_FRAC);
  const g = bot.group;
  const b = ud.baseScale || 1;
  // snap upright before restoring the tag (sprites inherit parent scale — restoring
  // the tag while still puddle-shaped flickers it wide/flat for a few frames),
  // then a squash impulse gives the pop-up boing instead
  g.scale.set(b, b, b);
  ud.sx = 1;
  ud.sy = 1;
  ud.squash = 0.3;
  restoreTag(pt);
  pt.atk = rand(0.6, 1.1);
  pt.hopA = 0;
  spawnRing(g.position, bot.color || PARTY_RING, 2.6);
  _pos.set(g.position.x, g.position.y + 0.6, g.position.z);
  spawnBurst(_pos, bot.color || PARTY_RING, 10, 6);
  playSound('learn');
  emit('ally:up', { bot });
  schedule(rand(0.3, 0.9), () => partySay(bot, pick(UP_LINES)));
}

// ------------------------------------------------------------------- combat
function pickTarget(bot, p, px, pz, pg) {
  let best = null, bestScore = Infinity;
  const list = G.enemies;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.dead || !e.group) continue;
    const ep = e.group.position;
    const dB = dist2d(ep.x, ep.z, p.x, p.z);
    let ok = dB < ENGAGE_SELF;
    if (!ok && pg && (e.state === 'chase' || e.state === 'windup')) {
      ok = dist2d(ep.x, ep.z, px, pz) < ENGAGE_PLAYER;
    }
    if (!ok) continue;
    // spread: strongly prefer enemies fewer allies are already on
    let n = 0;
    for (let j = 0; j < G.party.length; j++) {
      const o = G.party[j];
      if (o !== bot && o._pt && o._pt.target === e) n++;
    }
    const score = n * 100 + dB;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function validTarget(e, p, px, pz, pg) {
  if (!e || e.dead || !e.group) return false;
  const ep = e.group.position;
  if (pg && dist2d(ep.x, ep.z, px, pz) > LEASH_DROP) return false; // leash to player
  if (dist2d(ep.x, ep.z, p.x, p.z) < ENGAGE_SELF + 2) return true; // hysteresis
  return (e.state === 'chase' || e.state === 'windup') &&
    (!pg || dist2d(ep.x, ep.z, px, pz) < ENGAGE_PLAYER + 4);
}

function doAttack(bot, pt, tgt, p, ep) {
  pt.atk = 1.0 + rand(0, 0.4); // bounce attack every 1.0–1.4s
  ATK_OPTS.fromPos = p;
  damageEnemy(tgt, bot.dmg || 5, ATK_OPTS);
  ATK_OPTS.fromPos = null;
  // juice: squash impulse + hop + burst at the point of impact
  const ud = bot.group.userData;
  if (ud) ud.squash = Math.max(ud.squash || 0, 0.34);
  pt.hopA = pt.hopD = 0.3;
  const s = (tgt.group.scale && tgt.group.scale.y) || 1;
  _pos.set(
    ep.x + (p.x - ep.x) * 0.35,
    ep.y + 0.7 * s,
    ep.z + (p.z - ep.z) * 0.35
  );
  spawnBurst(_pos, bot.color || PARTY_RING, 6, 6);
  if (squishCD <= 0 && Math.random() < 0.65) { playSound('squish'); squishCD = 0.42; }
  if (tgt.dead) {
    pt.target = null;
    if (Math.random() < 0.3 && bot.chatTimer <= 0) {
      schedule(rand(0.5, 1.5), () => partySay(bot, pick(KILL_QUIPS)));
    }
  }
}

// -------------------------------------------------------------- formation
function slotPoint(idx, pl, pg, pt) {
  const yaw = (pl && pl.facing) || 0;
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // player forward
  const rx = fz, rz = -fx;                      // player right
  const s = SLOTS[idx] || SLOTS[SLOTS.length - 1];
  _slotX = pg.position.x + rx * s[0] + fx * s[1] + pt.jx;
  _slotZ = pg.position.z + rz * s[0] + fz * s[1] + pt.jz;
}

function separate(p, q, minD, dt) {
  const dx = p.x - q.x, dz = p.z - q.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < minD * minD && d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = ((minD - d) * 3 * dt) / d;
    p.x += dx * push;
    p.z += dz * push;
  }
}

// --------------------------------------------------------------- per member
function updateMember(bot, idx, dt, pl, pg) {
  const g = bot.group;
  if (!g) return;
  const p = g.position;
  const ud = g.userData || {};
  const pt = bot._pt || makePt(bot);
  if (bot.chatTimer > 0) bot.chatTimer -= dt; // bots.js may skip this while partied

  // ---- downed: melt into a puddle, wait for the revive timer ----
  if (bot.downed) {
    pt.downT -= dt;
    const b = ud.baseScale || 1;
    const k = 1 - Math.exp(-dt * 9);
    g.scale.x += (b * FLAT_X - g.scale.x) * k;
    g.scale.z = g.scale.x;
    g.scale.y += (b * FLAT_Y - g.scale.y) * k;
    let gy = terrainHeight(p.x, p.z);
    if (gy < WATER_Y - 0.35 && inLake(p.x, p.z)) gy = WATER_Y - 0.35; // KO'd over the lake: float, don't sink
    p.y = gy;
    if (pt.tag) { // counter-scale so the name tag stays put and readable
      const sx = Math.max(g.scale.x, 0.05);
      const sy = Math.max(g.scale.y, 0.05);
      pt.tag.scale.set((pt.tagSX * b) / sx, (pt.tagSY * b) / sy, 1);
      pt.tag.position.y = (pt.tagY * b) / sy;
    }
    if (pt.downT <= 0) reviveBot(bot, pt, ud);
    return; // downed allies don't move, fight or wobble
  }

  // out-of-combat regen (pauses while they have a target)
  if (!pt.target && Number.isFinite(bot.maxHp) && bot.hp < bot.maxHp) {
    bot.hp = Math.min(bot.maxHp, bot.hp + bot.maxHp * 0.04 * dt);
  }

  let moving = false;
  let yOff = 0;
  let spd = WALK_SPEED;
  let yawT = g.rotation.y;

  const px = pg ? pg.position.x : p.x;
  const pz = pg ? pg.position.z : p.z;
  const dPlayer = pg ? dist2d(p.x, p.z, px, pz) : 0;
  if (dPlayer > SPRINT_DIST) spd = WALK_SPEED * SPRINT_MULT;

  // slot wander jitter — re-rolled every couple of seconds so the formation
  // never looks like slimes glued to grid points
  pt.jT -= dt;
  if (pt.jT <= 0) { pt.jx = rand(-0.7, 0.7); pt.jz = rand(-0.7, 0.7); pt.jT = rand(1.2, 3); }

  // very far behind (zoning, dash spam): snap to the slot in a puff
  if (pg && dPlayer > TELEPORT_DIST) {
    slotPoint(idx, pl, pg, pt);
    p.x = _slotX;
    p.z = _slotZ;
    p.y = terrainHeight(p.x, p.z);
    _pos.set(p.x, p.y + 0.5, p.z);
    spawnBurst(_pos, bot.color || PARTY_RING, 10, 7);
    pt.target = null;
    pt.hopA = 0;
  }

  // ---- targeting ----
  let tgt = pt.target;
  if (tgt && !validTarget(tgt, p, px, pz, pg)) tgt = pt.target = null;
  if (!tgt) {
    pt.reT -= dt;
    if (pt.reT <= 0) { // scan ~4×/s, not every frame — enemies got dense in V2
      tgt = pt.target = pickTarget(bot, p, px, pz, pg);
      pt.reT = 0.25 + rand(0, 0.2);
    }
  }
  if (pt.atk > 0) pt.atk -= dt;

  if (tgt) {
    // ---- combat: close to melee range, bounce-attack on the timer ----
    const ep = tgt.group.position;
    const dx = ep.x - p.x, dz = ep.z - p.z;
    const d = Math.hypot(dx, dz);
    const eR = tgt.radius || ((tgt.group.scale && tgt.group.scale.x) || 1) * 0.8;
    const range = ATTACK_RANGE + eR * 0.5;
    yawT = Math.atan2(dx, dz);
    if (d > range) {
      const inv = 1 / Math.max(d, 1e-4);
      const step = Math.min(spd * dt, d - range * 0.7);
      p.x += dx * inv * step;
      p.z += dz * inv * step;
      bot.vel.set(dx * inv * spd, 0, dz * inv * spd);
      moving = true;
    } else {
      bot.vel.set(0, 0, 0);
      if (pt.atk <= 0) doAttack(bot, pt, tgt, p, ep);
    }
  } else if (pg) {
    // ---- formation follow ----
    slotPoint(idx, pl, pg, pt);
    const dx = _slotX - p.x, dz = _slotZ - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.35) {
      const inv = 1 / d;
      const step = Math.min(spd * dt, d);
      p.x += dx * inv * step;
      p.z += dz * inv * step;
      bot.vel.set(dx * inv * spd, 0, dz * inv * spd);
      moving = d > 0.6;
      if (moving) yawT = Math.atan2(dx, dz);
      else yawT = (pl && pl.facing) || yawT;
    } else {
      // waiting at the slot: look where the boss looks, hop in place sometimes
      bot.vel.set(0, 0, 0);
      yawT = (pl && pl.facing) || yawT;
      pt.hopT -= dt;
      if (pt.hopT <= 0) {
        pt.hopA = pt.hopD = 0.5;
        pt.hopT = rand(2.5, 6.5);
      }
    }
  } else {
    bot.vel.set(0, 0, 0);
  }

  // little hop arc (idle fidget or attack bounce)
  if (pt.hopA > 0) {
    pt.hopA -= dt;
    const f = 1 - Math.max(pt.hopA, 0) / pt.hopD;
    yOff = Math.sin(f * Math.PI) * 0.5;
    moving = true; // wobble during the hop
  }

  // soft separation: never stack on the player or each other
  if (pg) separate(p, pg.position, 1.9, dt);
  for (let j = 0; j < G.party.length; j++) {
    if (j === idx) continue;
    const o = G.party[j];
    if (o && o !== bot && o.group && !o.downed) separate(p, o.group.position, 1.5, dt);
  }

  // terrain follow + world clamp (+ bob at the surface if dragged across the lake)
  p.x = clamp(p.x, -112, 112);
  p.z = clamp(p.z, -112, 112);
  let gy = terrainHeight(p.x, p.z);
  if (gy < WATER_Y - 0.35 && inLake(p.x, p.z)) gy = WATER_Y - 0.35;
  p.y = gy + yOff;

  // smooth facing
  let dyaw = yawT - g.rotation.y;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  g.rotation.y += dyaw * Math.min(1, 10 * dt);
  bot.yawTarget = yawT; // keep bots.js's facing state coherent for after release

  animateSlime(g, dt, { moving, grounded: true, speed: spd });
}

// ------------------------------------------------------------------ exports
export function initParty() {
  if (inited) return;
  inited = true;
  fullMsgCD = 0;
  squishCD = 0;
  hitSndCD = 0;
  pending.length = 0;
  // party is intentionally not persisted across reloads
}

export function updateParty(dt) {
  if (!inited || !G.started) return;

  if (fullMsgCD > 0) fullMsgCD -= dt;
  if (squishCD > 0) squishCD -= dt;
  if (hitSndCD > 0) hitSndCD -= dt;

  // delayed chats (acceptance lines, quips, thanks)
  for (let i = pending.length - 1; i >= 0; i--) {
    const a = pending[i];
    a.t -= dt;
    if (a.t <= 0) { pending.splice(i, 1); a.fn(); }
  }

  const pl = G.player;
  const pg = (pl && pl.group) || null;

  // defensive prune: a partied bot should never vanish from G.bots
  // (bots.js never removes party members), but degrade gracefully if it does
  for (let i = G.party.length - 1; i >= 0; i--) {
    const b = G.party[i];
    if (!b || !b.group || G.bots.indexOf(b) === -1) {
      G.party.splice(i, 1);
      if (b) { b.party = false; b.downed = false; }
      emit('party:changed', {});
    }
  }

  // ---- E-key invite (skipped while paused / chatting / dead — but the
  // party members below keep fighting even while the player is dead) ----
  if (pg && !pl.dead && !G.paused && !G.chatFocus &&
      G.keysPressed && G.keysPressed['KeyE']) {
    if (G.party.length >= MAX_PARTY) {
      if (fullMsgCD <= 0) {
        emit('chat', { from: '🤝 Party', system: true, text: 'Your party is full.' });
        fullMsgCD = 4;
      }
    } else {
      const bot = findInvitable();
      if (bot) invite(bot);
    }
  }

  // ---- drive all members ----
  for (let i = 0; i < G.party.length; i++) {
    updateMember(G.party[i], i, dt, pl, pg);
  }
}
