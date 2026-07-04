// bots.js — simulated other players. Cosmetic only: they roam, hop, emote and
// chat like an MMO server population, but never fight or take damage.
// Exports: initBots(), updateBots(dt). See CONTRACT.md (bots.js section).
import * as THREE from 'three';
import { G, on, emit, clamp, rand, randInt, pick, dist2d } from './core.js';
import { terrainHeight, WATER_LEVEL } from './world.js';
import { createSlime, animateSlime, makeNameTag } from './slime.js';

// ---------------------------------------------------------------- constants
const NAME_POOL = [
  'GooberTTV', 'moss_maiden', 'BlobRoss', 'xX_SlimeLord_Xx', 'JellyJim',
  'drip_drop', 'SlimeShady', 'kingwobble', 'oozelord99', 'pebblewort',
  'snailbait', 'GelatinKing', 'wibblewobble', 'puddlemancer', 'MossyBoi',
  'slorpy',
  'goopED', 'Sli_Mer', 'tadpole22', 'BlorboTheVast', 'mucusmaximus',
  'sir_drips', 'PuddleQueen', 'gelfband', 'wobbert', 'OozeGoose',
  'splatrick', 'jiggleJoe', 'BounceHouse', 'slimothy',
];

const BOT_BLUE = '#7ec8ff';
// fixed pastel palette — slime.js caches one material pair per unique color,
// so bot colors must come from a bounded set or long sessions leak materials
const BOT_PALETTE = [
  0xf4a6b8, 0xf6c177, 0xefe28a, 0xb8e08c, 0x8fdcc0, 0x8fc8ef, 0xa9a6f2,
  0xd9a6ef, 0xf2a6d8, 0xa6f2b8, 0xf2bca6, 0xa6d8f2, 0xc8f2a6, 0xe0a6f2,
  0xf2e0a6, 0xa6f2e0, 0xbfa6f2, 0xf2a6a6,
];
const START_COUNT = 22;
const MIN_BOTS = 20;
const MAX_BOTS = 24;
const LEAVE_T = 1.25;   // seconds of sink/shrink before despawn
const JOIN_T = 0.85;    // seconds of grow-in
const SPIN_T = 1.15;    // spin emote duration (~2 full turns)
const HOPS_T = 1.5;     // three-excited-hops emote duration
const LAKE_X = -70, LAKE_Z = 40, LAKE_R = 28; // lake + margin: never stop here
const EDGE = 108;       // waypoint bound; terrain cliffs past ~112

// Scripted call-and-response keys
const ASK_K = 'how do i open the skill tree lol';
const GG = 'gg';

// ~30 generic lines (zone lines below bring the pool to ~45)
const LINES = [
  'lfg King Gloop need 2 more',
  'selling royal jelly 5g at the plaza',
  ASK_K,
  GG,
  'anyone wanna duo whisperwood?',
  'just hit a fat crit on a mushroom brute LOL',
  'wts shiny pebbles, plaza, cheap cheap',
  'is double jump worth a point? asking for a friend',
  'who keeps training spike slimes into the road...',
  'this game is so cute i cant',
  'fell in the lake again',
  'pro tip: shift to dash, thank me later',
  'anyone else lagging or is that just me',
  'King Gloop dropped NOTHING. scammed',
  'whats the max level, anyone know?',
  'i swear the boss spawned right on top of me',
  'goo slam is so satisfying',
  'just respecced full vitality, im a TANK now',
  'free hugs at the plaza fountain',
  'day 3 of farming crystal slimes, pray for me',
  'o7 to whoever carried me through whisperwood',
  'my crit build slaps so hard rn',
  'wow nerf mushroom brutes pls',
  'echo + splitter shot is busted fr',
  'where do i learn slime shot?? nvm found it',
  'race you to the arena, last one there is a wild slime',
  'afk 2 min, dont kill my vibe',
  'brb mom needs the computer',
  'does armor even do anything lol',
  'the sunset over the boundary cliffs... chefs kiss',
  'anyone wanna party up?',
  'press E on a slime to invite them btw',
  'my party carried me thru whisperwood lol',
  'partied with 3 randos and we just vibed at the lake',
];

const ZONE_LINES = {
  plaza: [
    'plaza fountain meetup, 5 min',
    'love the lanterns here in the plaza',
    'selling royal jelly 5g at the plaza',
  ],
  fields: [
    'green fields is so peaceful rn',
    'these wild slimes give NO xp at my level, sigh',
    'touching grass in green fields, literally',
  ],
  wood: [
    'anyone else farming Spike Slimes in Whisperwood?',
    'the glow mushrooms in whisperwood are so pretty',
    'a mushroom brute almost got me lol',
  ],
  crystal: [
    'the Crystal Hollows music slaps',
    'crystal slimes hit different',
    'out here mining vibes in crystal hollows',
  ],
  arena: [
    'King Gloop is UP, get over here',
    'these standing stones look sick',
    'lfg King Gloop need 2 more',
  ],
};

const K_ANSWERS = ['press K', 'press K!!', 'K opens it'];
const GG_ECHOES = ['gg', 'gg wp', 'ggs'];
const GRATS = ['grats!', 'big grats', 'gz', 'GRATS', 'poggers, grats'];
const BOSS_NICE = ['nice', 'NICE', 'gg king', 'clean kill wow'];
const GENERIC_REPLIES = ['lol', 'haha true', 'o7', 'real', 'same', 'nice', 'based', 'mood', '+1', 'fr fr'];
const DOWNED_REACTS = ['F', 'rip', 'F in the chat', 'big rip', 'oof, F'];

// ---------------------------------------------------------------- module state
let inited = false;
let chatTimer = 0;        // global "someone says something" timer
let swapTimer = 0;        // join/leave cycle timer
let lastLine = '';
const pending = [];       // [{ t, fn }] delayed actions (replies, joins, chains)

// ------------------------------------------------------------------- helpers
function zoneOf(x, z) {
  if (dist2d(x, z, 0, 92) < 18) return 'arena';
  if (Math.abs(x) > 80 && Math.abs(z) > 80) return 'crystal';
  const r = Math.hypot(x, z);
  if (r < 18) return 'plaza';
  if (r < 55) return 'fields';
  return 'wood';
}

function inLake(x, z) { return dist2d(x, z, LAKE_X, LAKE_Z) < LAKE_R; }

function okSpot(x, z) {
  return Math.abs(x) <= EDGE && Math.abs(z) <= EDGE && !inLake(x, z);
}

function schedule(t, fn) { pending.push({ t, fn }); }

function countActive() {
  let n = 0;
  for (let i = 0; i < G.bots.length; i++) if (G.bots[i].state !== 'leaving') n++;
  return n;
}

// Random active bot, optionally excluding one. Alloc-free reservoir pick.
// Party members stay eligible (chatty teammates); downed bots stay quiet
// (party.js owns their 'oof'/'im ok' beats).
function randomBot(exclude) {
  let chosen = null, n = 0;
  for (let i = 0; i < G.bots.length; i++) {
    const b = G.bots[i];
    if (b === exclude || b.downed || b.state === 'leaving' || b.state === 'joining') continue;
    n++;
    if (Math.random() < 1 / n) chosen = b;
  }
  return chosen;
}

// Prefer bots whose personal chat cooldown has expired.
function randomTalker() {
  let chosen = null, n = 0;
  for (let i = 0; i < G.bots.length; i++) {
    const b = G.bots[i];
    if (b.downed || b.state === 'leaving' || b.state === 'joining' || b.chatTimer > 0) continue;
    n++;
    if (Math.random() < 1 / n) chosen = b;
  }
  return chosen || randomBot(null);
}

// Like randomBot but also excludes party members — used for the leave cycle
// (never yank someone out of the player's party) and 'F' reactions.
function randomNonParty() {
  let chosen = null, n = 0;
  for (let i = 0; i < G.bots.length; i++) {
    const b = G.bots[i];
    if (b.party || b.downed || b.state === 'leaving' || b.state === 'joining') continue;
    n++;
    if (Math.random() < 1 / n) chosen = b;
  }
  return chosen;
}

function offlineName() {
  let chosen = null, n = 0;
  for (let i = 0; i < NAME_POOL.length; i++) {
    const name = NAME_POOL[i];
    let online = false;
    for (let j = 0; j < G.bots.length; j++) {
      if (G.bots[j].name === name) { online = true; break; }
    }
    if (online) continue;
    n++;
    if (Math.random() < 1 / n) chosen = name;
  }
  return chosen;
}

// Random point somewhere interesting in the world (all zones, never the lake).
function scatterPoint(out) {
  for (let tries = 0; tries < 12; tries++) {
    const k = Math.random();
    let x, z;
    if (k < 0.12) {            // Slime Plaza
      const a = rand(0, Math.PI * 2), r = rand(5, 15);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } else if (k < 0.5) {      // Green Fields
      const a = rand(0, Math.PI * 2), r = rand(20, 52);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } else if (k < 0.82) {     // Whisperwood
      const a = rand(0, Math.PI * 2), r = rand(58, 92);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } else if (k < 0.92) {     // Crystal Hollows corners
      const sx = Math.random() < 0.5 ? 1 : -1;
      const sz = Math.random() < 0.5 ? 1 : -1;
      x = sx * rand(83, 106); z = sz * rand(83, 106);
    } else {                   // King's Arena outskirts
      const a = rand(0, Math.PI * 2), r = rand(3, 15);
      x = Math.sin(a) * r; z = 92 + Math.cos(a) * r;
    }
    if (okSpot(x, z)) { out.x = x; out.z = z; return out; }
  }
  out.x = rand(-12, 12); out.z = rand(-12, 12); // fallback: plaza
  return out;
}

const _wp = { x: 0, z: 0 };
function pickWaypoint(bot) {
  const p = bot.group.position;
  // 65%: short local stroll (stay in/near current zone); 35%: hop zones.
  if (Math.random() < 0.65) {
    for (let tries = 0; tries < 8; tries++) {
      const a = rand(0, Math.PI * 2), d = rand(8, 26);
      const x = clamp(p.x + Math.cos(a) * d, -EDGE, EDGE);
      const z = clamp(p.z + Math.sin(a) * d, -EDGE, EDGE);
      if (okSpot(x, z)) { bot.target.set(x, 0, z); return; }
    }
  }
  scatterPoint(_wp);
  bot.target.set(_wp.x, 0, _wp.z);
}

// ---------------------------------------------------------------------- chat
function sayRaw(bot, text) {
  if (!bot || bot.state === 'leaving') return;
  emit('chat', { from: bot.name, text, color: BOT_BLUE });
  bot.chatTimer = 18; // personal cooldown so one bot doesn't dominate
}

// say() = sayRaw + scripted call-and-response chains.
function say(bot, text) {
  if (!bot || bot.state === 'leaving') return;
  sayRaw(bot, text);
  if (text === ASK_K) {
    schedule(rand(3, 5), () => {
      const other = randomBot(bot);
      if (other) sayRaw(other, pick(K_ANSWERS));
    });
  } else if (text === GG) {
    const n = randInt(1, 2);
    for (let i = 0; i < n; i++) {
      schedule(rand(1, 3) + i * rand(0.8, 1.6), () => {
        const other = randomBot(bot);
        if (other) sayRaw(other, pick(GG_ECHOES));
      });
    }
  }
}

function fireChat() {
  const bot = randomTalker();
  if (!bot) return;
  const zl = ZONE_LINES[zoneOf(bot.group.position.x, bot.group.position.z)];
  let line = (zl && Math.random() < 0.45) ? pick(zl) : pick(LINES);
  if (line === lastLine) line = pick(LINES);
  if (line === lastLine) return; // very unlucky; just skip this beat
  lastLine = line;
  say(bot, line);
}

// ---------------------------------------------------------------- join/leave
function makeBot(name, x, z, joining) {
  const level = randInt(3, 34);
  const color = pick(BOT_PALETTE);
  const size = rand(0.9, 1.12);
  const group = createSlime({ color, size });
  const tag = makeNameTag(name, { color: BOT_BLUE, sub: 'Lv ' + level });
  tag.position.y = 1.8 * size;
  group.add(tag);
  group.position.set(x, terrainHeight(x, z), z);
  group.rotation.y = rand(-Math.PI, Math.PI);
  if (joining) group.scale.setScalar(0.001);

  const maxHp = 60 + 10 * level;
  const bot = {
    group, name, level, color,
    vel: new THREE.Vector3(),
    state: joining ? 'joining' : 'idle',
    target: new THREE.Vector3(x, 0, z),
    timer: joining ? JOIN_T : rand(0.5, 4),
    chatTimer: rand(4, 30),
    // combat fields (used when recruited into the player's party — party.js)
    maxHp, hp: maxHp,
    dmg: Math.round((4 + 1.2 * level) * 10) / 10,
    downed: false, party: false,
    // internal extras
    speed: rand(6, 8), size, yawTarget: group.rotation.y, emote: 0,
  };
  G.scene.add(group);
  G.bots.push(bot);
  return bot;
}

function removeBot(index) {
  const b = G.bots[index];
  G.bots.splice(index, 1);
  G.scene.remove(b.group);
  // Dispose only the per-bot name-tag sprite (canvas texture). Slime meshes
  // use shared cached geometry/materials owned by slime.js — leave them alone.
  b.group.traverse((o) => {
    if (o.isSprite && o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  emit('chat', { from: '⚔ Realm', system: true, text: b.name + ' left the realm' });
}

function joinFresh() {
  if (countActive() >= MAX_BOTS) return;
  const name = offlineName();
  if (!name) return;
  for (let tries = 0; tries < 8; tries++) {
    const a = rand(0, Math.PI * 2), r = rand(6, 15);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!okSpot(x, z)) continue;
    const bot = makeBot(name, x, z, true);
    emit('chat', { from: '⚔ Realm', system: true, text: bot.name + ' has joined the realm' });
    return;
  }
}

function doSwap() {
  const active = countActive();
  if (active > MIN_BOTS) {
    const b = randomNonParty(); // never pull a party member (or a downed ally) offline
    if (b) { b.state = 'leaving'; b.timer = LEAVE_T; }
  }
  if (active <= MAX_BOTS) schedule(rand(3, 7), joinFresh);
}

// ------------------------------------------------------------------ exports
export function initBots() {
  if (inited) return;
  inited = true;

  chatTimer = rand(8, 20); // first line lands a bit sooner than steady state
  swapTimer = rand(60, 120);

  // Initial population, scattered across all zones.
  let n = 0;
  while (n < START_COUNT) {
    const name = offlineName();
    if (!name) break;
    scatterPoint(_wp);
    makeBot(name, _wp.x, _wp.z, false);
    n++;
  }

  // --- reactions -----------------------------------------------------------
  // Player spoke -> 40% chance one bot replies in 2-6 s.
  on('chat', (d) => {
    if (!d || !d.self || !d.text || Math.random() >= 0.4) return;
    const text = String(d.text);
    schedule(rand(2, 6), () => {
      const bot = randomBot(null);
      if (!bot) return;
      let reply = null;
      if (Math.random() < 0.5) {
        // echo a word back
        const words = text.split(/\s+/);
        let word = null, cnt = 0;
        for (let i = 0; i < words.length; i++) {
          const w = words[i].replace(/[^a-zA-Z0-9']/g, '');
          if (w.length < 4) continue;
          cnt++;
          if (Math.random() < 1 / cnt) word = w.toLowerCase();
        }
        if (word) reply = pick([word + '? same tbh', 'lol ' + word, word + ' fr', 'did someone say ' + word]);
      }
      sayRaw(bot, reply || pick(GENERIC_REPLIES));
    });
  });

  // Milestone level-ups -> 1-2 bots congratulate.
  on('player:levelup', (d) => {
    const level = d && d.level;
    if (!level || level % 5 !== 0) return;
    const n2 = randInt(1, 2);
    for (let i = 0; i < n2; i++) {
      schedule(rand(1.5, 4) + i * rand(1, 2), () => {
        const bot = randomBot(null);
        if (bot) sayRaw(bot, pick(GRATS));
      });
    }
  });

  // Party ally went down -> ~30% chance a bystander (non-party) bot pays respects.
  on('ally:downed', (d) => {
    if (Math.random() >= 0.3) return;
    const downedBot = d && d.bot;
    schedule(rand(1, 3), () => {
      const bot = randomNonParty();
      if (bot && bot !== downedBot) sayRaw(bot, pick(DOWNED_REACTS));
    });
  });

  // Boss down -> small chance of a 'nice'.
  on('enemy:killed', (d) => {
    const e = d && d.enemy;
    if (!e) return;
    const isBoss = /king\s*gloop/i.test(e.name || '') || e.type === 'king' || e.type === 'boss';
    if (!isBoss || Math.random() >= 0.4) return;
    schedule(rand(1.5, 4), () => {
      const bot = randomBot(null);
      if (bot) sayRaw(bot, pick(BOSS_NICE));
    });
  });
}

export function updateBots(dt) {
  if (!G.started || !inited) return;

  // -- global timers --
  chatTimer -= dt;
  if (chatTimer <= 0) { fireChat(); chatTimer = rand(18, 45); }
  swapTimer -= dt;
  if (swapTimer <= 0) { doSwap(); swapTimer = rand(60, 120); }

  // -- delayed actions (replies, scripted answers, joins) --
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    p.t -= dt;
    if (p.t <= 0) { pending.splice(i, 1); p.fn(); }
  }

  const pg = (G.player && G.player.group) ? G.player.group.position : null;

  for (let i = G.bots.length - 1; i >= 0; i--) {
    const b = G.bots[i];

    // Party members are fully driven by party.js (movement, animation, downed
    // squash, AND their chatTimer — ticking it here too would double the decay).
    if (b.party) continue;
    if (b.chatTimer > 0) b.chatTimer -= dt;
    // roaming slimes shake off party wounds over time
    if (Number.isFinite(b.maxHp) && b.hp < b.maxHp) {
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.05 * dt);
    }

    const g = b.group, p = g.position;

    // ---- despawn / spawn transitions (own the scale; skip animateSlime) ----
    if (b.state === 'leaving') {
      b.timer -= dt;
      const t = Math.max(b.timer / LEAVE_T, 0);
      g.scale.setScalar(Math.max(t, 0.001));
      p.y = terrainHeight(p.x, p.z) - (1 - t) * 1.6;
      g.rotation.y += 4 * dt; // little farewell twirl as they sink
      if (b.timer <= 0) removeBot(i);
      continue;
    }
    if (b.state === 'joining') {
      b.timer -= dt;
      const t = 1 - Math.max(b.timer / JOIN_T, 0);
      g.scale.setScalar(Math.max(t, 0.001));
      p.y = terrainHeight(p.x, p.z);
      if (b.timer <= 0) {
        g.scale.setScalar(1);
        b.state = 'idle';
        b.timer = rand(1, 3);
      }
      continue;
    }

    // ---- simple life: idle -> walk -> (idle | emote) ----
    let moving = false;
    let yOff = 0;

    if (b.state === 'idle') {
      b.vel.set(0, 0, 0);
      b.timer -= dt;
      if (b.timer <= 0) { pickWaypoint(b); b.state = 'walk'; }
    } else if (b.state === 'walk') {
      const dx = b.target.x - p.x, dz = b.target.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.9) {
        if (Math.random() < 0.1) {
          b.state = 'emote';
          b.emote = Math.random() < 0.5 ? 0 : 1; // 0 = spin, 1 = three hops
          b.timer = b.emote === 0 ? SPIN_T : HOPS_T;
        } else {
          b.state = 'idle';
          b.timer = rand(2, 8);
        }
        b.vel.set(0, 0, 0);
      } else {
        const inv = 1 / d;
        const step = Math.min(b.speed * dt, d);
        p.x += dx * inv * step;
        p.z += dz * inv * step;
        b.vel.set(dx * inv * b.speed, 0, dz * inv * b.speed);
        b.yawTarget = Math.atan2(dx, dz);
        moving = true;
      }
    } else if (b.state === 'emote') {
      b.timer -= dt;
      if (b.emote === 0) {
        g.rotation.y += (4 * Math.PI / SPIN_T) * dt; // ~2 quick turns
      } else {
        const phase = (1 - Math.max(b.timer, 0) / HOPS_T) * Math.PI * 3;
        yOff = Math.abs(Math.sin(phase)) * 0.9;      // three excited hops
        moving = true;                                // wobble while bouncing
      }
      if (b.timer <= 0) {
        b.state = 'idle';
        b.timer = rand(2, 8);
        b.yawTarget = g.rotation.y;
      }
    }

    // ---- gentle separation from the player (no hard collision) ----
    if (pg) {
      const sx = p.x - pg.x, sz = p.z - pg.z;
      const sd2 = sx * sx + sz * sz;
      if (sd2 < 6.25 && sd2 > 1e-4) { // within 2.5 u
        const sd = Math.sqrt(sd2);
        const push = ((2.5 - sd) * 3 * dt) / sd;
        p.x += sx * push;
        p.z += sz * push;
      }
    }

    // ---- terrain clamp + follow (bob at the surface if a path clips the lake) ----
    p.x = clamp(p.x, -112, 112);
    p.z = clamp(p.z, -112, 112);
    let gy = terrainHeight(p.x, p.z);
    if (gy < WATER_LEVEL - 0.35 && inLake(p.x, p.z)) gy = WATER_LEVEL - 0.35;
    p.y = gy + yOff;

    // ---- facing (skip while spinning) ----
    if (!(b.state === 'emote' && b.emote === 0)) {
      let dy = b.yawTarget - g.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.rotation.y += dy * Math.min(1, 10 * dt);
    }

    animateSlime(g, dt, { moving, grounded: true, speed: b.speed });
  }
}
