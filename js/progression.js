// progression.js — characters, XP/levels, gold, skill tree, derived stats, save/load.
// Owns: G.player creation, the stats object (ONLY this module recomputes it), persistence.
// See CONTRACT.md. Imports: three + core only.
import * as THREE from 'three';
import { G, on, emit, clamp } from './core.js';

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------
// `mods` is pure data the recompute applies: `flat` adds before `mult` scales
// the running total. `startSkillPoints` / `startSkills` apply on fresh init only.
export const CHARACTERS = [
  {
    id: 'verdant',
    name: 'Verdant',
    icon: '🌱',
    color: 0x6fcf5f,
    colorCss: '#6fcf5f',
    tagline: 'Balanced & bouncy',
    desc: 'A sun-grown slime that shrugs off scrapes and never stops sprouting.',
    bonuses: ['+25% HP regen', '+1 starting skill point'],
    mods: { flat: {}, mult: { regen: 1.25 } },
    startSkillPoints: 1,
    startSkills: [],
  },
  {
    id: 'ember',
    name: 'Ember',
    icon: '🔥',
    color: 0xff7043,
    colorCss: '#ff7043',
    tagline: 'Hot-headed bruiser',
    desc: 'A smoldering slime that hits like a meteor but cooks off some of its own goo.',
    bonuses: ['+25% damage', '-15% max HP'],
    mods: { flat: {}, mult: { damage: 1.25, maxHp: 0.85 } },
    startSkillPoints: 0,
    startSkills: [],
  },
  {
    id: 'aqua',
    name: 'Aqua',
    icon: '💧',
    color: 0x4fc3f7,
    colorCss: '#4fc3f7',
    tagline: 'Tidal spellcaster',
    desc: 'A dewy slime that channels the lake itself, lobbing globs from afar.',
    bonuses: ['Starts with Slime Shot', '+30 max mana'],
    mods: { flat: { maxMana: 30 }, mult: {} },
    startSkillPoints: 0,
    startSkills: ['slime_shot'],
  },
  {
    id: 'umbra',
    name: 'Umbra',
    icon: '🌙',
    color: 0xab7df6,
    colorCss: '#ab7df6',
    tagline: 'Slippery night rogue',
    desc: 'A moonlit slime that strikes fast and fades before anyone wobbles back.',
    bonuses: ['+10% move speed', '+15% crit chance', '-10% max HP'],
    mods: { flat: { crit: 0.15 }, mult: { moveSpeed: 1.10, maxHp: 0.90 } },
    startSkillPoints: 0,
    startSkills: [],
  },
];

// ---------------------------------------------------------------------------
// Skill tree
// ---------------------------------------------------------------------------
// Node: { id, name, icon, desc, maxRank, tier (1..5), requires: [ids, all rank>=1] }.
// Cost: 1 point per rank. Stat math lives in recomputeStats() (switch on id).
export const SKILL_TREE = {
  branches: [
    {
      id: 'vitality',
      name: 'Vitality',
      icon: '🌿',
      color: 0x5fd068,
      colorCss: '#5fd068',
      nodes: [
        { id: 'gel_membrane', name: 'Gel Membrane', icon: '🫧',
          desc: '+20 max HP per rank (up to +60).',
          maxRank: 3, tier: 1, requires: [] },
        { id: 'osmosis', name: 'Osmosis', icon: '💧',
          desc: '+0.5 HP regen per second per rank (up to +1.5).',
          maxRank: 3, tier: 2, requires: ['gel_membrane'] },
        { id: 'spring_coil', name: 'Spring Coil', icon: '🦘',
          desc: 'Unlocks Double Jump — press Space again in mid-air.',
          maxRank: 1, tier: 2, requires: ['gel_membrane'] },
        { id: 'thick_goo', name: 'Thick Goo', icon: '🛡️',
          desc: '+2 armor per rank (up to +6 flat damage soaked per hit).',
          maxRank: 3, tier: 3, requires: ['osmosis'] },
        { id: 'royal_jelly', name: 'Royal Jelly', icon: '🍯',
          desc: '+60 max HP and +1 HP regen per second.',
          maxRank: 1, tier: 4, requires: ['thick_goo'] },
        { id: 'second_skin', name: 'Second Skin', icon: '💖',
          desc: 'Recover 5 HP every time you defeat an enemy.',
          maxRank: 1, tier: 4, requires: ['spring_coil'] },
        { id: 'titan_gel', name: 'Titan Gel', icon: '💪',
          desc: 'Capstone: +100 max HP and your slime grows 15% bigger.',
          maxRank: 1, tier: 5, requires: ['royal_jelly'] },
      ],
    },
    {
      id: 'ferocity',
      name: 'Ferocity',
      icon: '💥',
      color: 0xff6b6b,
      colorCss: '#ff6b6b',
      nodes: [
        { id: 'sharp_bounce', name: 'Sharp Bounce', icon: '🗡️',
          desc: '+3 damage per rank (up to +9).',
          maxRank: 3, tier: 1, requires: [] },
        { id: 'quick_squish', name: 'Quick Squish', icon: '⚡',
          desc: '+10% attack speed per rank (up to +30%).',
          maxRank: 3, tier: 2, requires: ['sharp_bounce'] },
        { id: 'slip_dash', name: 'Slip Dash', icon: '💨',
          desc: 'Unlocks Slip Dash (4 / Shift) — a slick burst of speed. 12 mana.',
          maxRank: 1, tier: 2, requires: ['sharp_bounce'] },
        { id: 'hardened_core', name: 'Hardened Core', icon: '💎',
          desc: '+10% critical strike chance per rank (up to +20%).',
          maxRank: 2, tier: 3, requires: ['quick_squish'] },
        { id: 'momentum', name: 'Momentum', icon: '🏃',
          desc: '+10% move speed per rank (up to +20%).',
          maxRank: 2, tier: 3, requires: ['slip_dash'] },
        { id: 'goo_slam', name: 'Goo Slam', icon: '🌊',
          desc: 'Unlocks Goo Slam (3) — slam the ground for 160% damage in a 6m ring. 22 mana.',
          maxRank: 1, tier: 4, requires: ['hardened_core'] },
        { id: 'berserk_ooze', name: 'Berserk Ooze', icon: '😤',
          desc: 'Capstone: +20% damage and +10% critical strike chance.',
          maxRank: 1, tier: 5, requires: ['goo_slam'] },
      ],
    },
    {
      id: 'arcana',
      name: 'Arcana',
      icon: '🔮',
      color: 0x6ea8ff,
      colorCss: '#6ea8ff',
      nodes: [
        { id: 'slime_shot', name: 'Slime Shot', icon: '🟢',
          desc: 'Unlocks Slime Shot (2 / RMB) — lob a goo projectile. 8 mana.',
          maxRank: 1, tier: 1, requires: [] },
        { id: 'inner_pool', name: 'Inner Pool', icon: '🔵',
          desc: '+15 max mana per rank (up to +45).',
          maxRank: 3, tier: 2, requires: ['slime_shot'] },
        { id: 'flow', name: 'Flow', icon: '🌀',
          desc: '+1.5 mana regen per second per rank (up to +3).',
          maxRank: 2, tier: 2, requires: ['slime_shot'] },
        { id: 'splitter', name: 'Splitter', icon: '🔱',
          desc: 'Slime Shot fires 3 globs in a spread.',
          maxRank: 1, tier: 3, requires: ['inner_pool'] },
        { id: 'heavy_slug', name: 'Heavy Slug', icon: '🪨',
          desc: 'Slime Shot deals +50% damage and knocks enemies back.',
          maxRank: 1, tier: 3, requires: ['flow'] },
        { id: 'echo', name: 'Echo', icon: '🔁',
          desc: 'All abilities cost 20% less mana.',
          maxRank: 1, tier: 4, requires: ['splitter'] },
        { id: 'overflow', name: 'Overflow', icon: '🌌',
          desc: 'Capstone: +40 max mana and your shots pierce through enemies.',
          maxRank: 1, tier: 5, requires: ['echo'] },
      ],
    },
  ],
};

// Fast lookups (pure data, built once at import).
const CHAR_BY_ID = {};
for (const c of CHARACTERS) CHAR_BY_ID[c.id] = c;
const NODE_BY_ID = {};
for (const b of SKILL_TREE.branches) for (const n of b.nodes) NODE_BY_ID[n.id] = n;

// Ability nodes -> hasAbility keys.
const ABILITY_NODE = {
  doubleJump: 'spring_coil',
  dash: 'slip_dash',
  slam: 'goo_slam',
  shot: 'slime_shot',
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
const BASE = {
  maxHp: 100, maxMana: 40, damage: 10, attackSpeed: 1.0, moveSpeed: 9,
  regen: 1, manaRegen: 3, crit: 0.05, armor: 0, manaCost: 1.0, scale: 1.0,
};
const PER_LEVEL = { maxHp: 9, damage: 1.8, maxMana: 4, regen: 0.1 };
const STAT_KEYS = Object.keys(BASE);

// Scratch accumulators reused across recomputes (no per-call object churn).
const FLAT = {};
const MULT = {};

function applySkillNode(id, rank, flat, mult) {
  switch (id) {
    // --- vitality ---
    case 'gel_membrane': flat.maxHp += 20 * rank; break;
    case 'osmosis': flat.regen += 0.5 * rank; break;
    case 'thick_goo': flat.armor += 2 * rank; break;
    case 'royal_jelly': flat.maxHp += 60; flat.regen += 1; break;
    case 'titan_gel': flat.maxHp += 100; mult.scale *= 1.15; break;
    // --- ferocity ---
    case 'sharp_bounce': flat.damage += 3 * rank; break;
    case 'quick_squish': mult.attackSpeed *= 1 + 0.10 * rank; break;
    case 'hardened_core': flat.crit += 0.10 * rank; break;
    case 'momentum': mult.moveSpeed *= 1 + 0.10 * rank; break;
    case 'berserk_ooze': mult.damage *= 1.20; flat.crit += 0.10; break;
    // --- arcana ---
    case 'inner_pool': flat.maxMana += 15 * rank; break;
    case 'flow': flat.manaRegen += 1.5 * rank; break;
    case 'echo': mult.manaCost *= 0.8; break;
    case 'overflow': flat.maxMana += 40; break;
    // spring_coil / slip_dash / goo_slam / slime_shot / second_skin /
    // splitter / heavy_slug: behavior nodes — combat/player read them via
    // hasAbility()/getRank(); no passive stat changes here.
  }
}

export function recomputeStats() {
  const p = G.player;
  if (!p) return;

  for (let i = 0; i < STAT_KEYS.length; i++) {
    const k = STAT_KEYS[i];
    FLAT[k] = 0;
    MULT[k] = 1;
  }

  // Class modifiers.
  const c = CHAR_BY_ID[p.charId] || CHARACTERS[0];
  for (const k in c.mods.flat) FLAT[k] += c.mods.flat[k];
  for (const k in c.mods.mult) MULT[k] *= c.mods.mult[k];

  // Every learned skill rank.
  for (const [id, rank] of p.skills) applySkillNode(id, rank, FLAT, MULT);

  // base -> + per-level growth -> + flats -> x percentage bonuses.
  const lv = p.level - 1;
  const s = p.stats || (p.stats = {});
  for (let i = 0; i < STAT_KEYS.length; i++) {
    const k = STAT_KEYS[i];
    s[k] = (BASE[k] + (PER_LEVEL[k] || 0) * lv + FLAT[k]) * MULT[k];
  }

  // Friendly rounding for UI-facing pools / damage.
  s.maxHp = Math.round(s.maxHp);
  s.maxMana = Math.round(s.maxMana);
  s.damage = Math.round(s.damage * 10) / 10;
  s.regen = Math.round(s.regen * 100) / 100;
  s.crit = clamp(s.crit, 0, 0.95);

  // Clamp current pools to the (possibly lower) new maxes.
  p.hp = clamp(typeof p.hp === 'number' ? p.hp : s.maxHp, 0, s.maxHp);
  p.mana = clamp(typeof p.mana === 'number' ? p.mana : s.maxMana, 0, s.maxMana);

  emit('stats:changed', {});
}

// ---------------------------------------------------------------------------
// XP / gold / levels
// ---------------------------------------------------------------------------
function xpFor(level) {
  return Math.round(25 * Math.pow(level, 1.5));
}

export function gainXP(n) {
  const p = G.player;
  if (!p) return;
  n = Math.round(n);
  if (!(n > 0)) return;
  p.xp += n;
  while (p.xp >= p.xpNeeded) {
    p.xp -= p.xpNeeded;
    p.level += 1;
    p.xpNeeded = xpFor(p.level);
    p.skillPoints += (p.level % 5 === 0) ? 2 : 1; // +1, +1 extra every 5th
    recomputeStats();
    if (!p.dead) {          // full heal on level — but not on a corpse (ally kills
      p.hp = p.stats.maxHp; // keep granting XP while the death screen is up)
      p.mana = p.stats.maxMana;
    }
    emit('player:levelup', { level: p.level });
  }
  emit('xp:gained', { amount: n });
  scheduleSave();
}

export function gainGold(n) {
  const p = G.player;
  if (!p) return;
  p.gold = Math.max(0, p.gold + Math.round(n || 0));
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Skill learning
// ---------------------------------------------------------------------------
export function getRank(id) {
  const p = G.player;
  return p ? (p.skills.get(id) || 0) : 0;
}

export function hasAbility(key) {
  const id = ABILITY_NODE[key];
  return !!id && getRank(id) > 0;
}

export function canLearn(id) {
  const node = NODE_BY_ID[id];
  if (!node) return { ok: false, reason: 'Unknown skill' };
  const p = G.player;
  if (!p) return { ok: false, reason: 'No character yet' };
  if ((p.skills.get(id) || 0) >= node.maxRank) return { ok: false, reason: 'Already at max rank' };
  for (let i = 0; i < node.requires.length; i++) {
    const reqId = node.requires[i];
    if ((p.skills.get(reqId) || 0) < 1) {
      const reqNode = NODE_BY_ID[reqId];
      return { ok: false, reason: 'Requires ' + (reqNode ? reqNode.name : reqId) };
    }
  }
  if (p.skillPoints < 1) return { ok: false, reason: 'Not enough skill points' };
  return { ok: true };
}

export function learnSkill(id) {
  if (!canLearn(id).ok) return false;
  const p = G.player;
  p.skillPoints -= 1;
  const rank = (p.skills.get(id) || 0) + 1;
  p.skills.set(id, rank);
  recomputeStats();
  emit('skill:learned', { id, rank });
  scheduleSave();
  return true;
}

// ---------------------------------------------------------------------------
// Save / load — localStorage, try/catch everywhere (private browsing safe)
// ---------------------------------------------------------------------------
const SAVE_KEY = 'slime-realms-save-v1';
let saveTimer = 0;
let unloadHooked = false;

function saveNow() {
  const p = G.player;
  if (!p) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  try {
    const skills = [];
    for (const [id, rank] of p.skills) skills.push([id, rank]);
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      charId: p.charId,
      name: p.name,
      level: p.level,
      xp: p.xp,
      gold: p.gold,
      skillPoints: p.skillPoints,
      skills,
    }));
  } catch (e) { /* storage unavailable — play on without persistence */ }
}

function scheduleSave() {
  if (saveTimer) return;
  try {
    saveTimer = setTimeout(() => { saveTimer = 0; saveNow(); }, 400);
  } catch (e) {
    saveNow();
  }
}

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    if (!CHAR_BY_ID[d.charId]) return null;
    if (typeof d.name !== 'string' || !d.name) return null;
    if (!(+d.level >= 1)) return null;
    return d;
  } catch (e) {
    return null;
  }
}

export function hasSave() {
  const d = readSave();
  if (!d) return null;
  return { charId: d.charId, name: d.name, level: clamp(Math.round(+d.level), 1, 99) };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export function initProgression(charId, name, fromSave) {
  const data = fromSave ? readSave() : null;
  const c = CHAR_BY_ID[data ? data.charId : charId] || CHARACTERS[0];

  const p = {
    // identity
    name: String((data ? data.name : name) || 'Goober').slice(0, 16),
    charId: c.id,
    color: c.color,
    // progression
    level: 1,
    xp: 0,
    xpNeeded: xpFor(1),
    gold: 0,
    skillPoints: 0,
    skills: new Map(),
    // pools + derived (filled below)
    hp: 0,
    mana: 0,
    stats: {},
    // attached / owned by other modules, pre-shaped per contract
    group: null,
    vel: new THREE.Vector3(),
    grounded: false,
    dead: false,
    facing: 0,
    cooldowns: { melee: 0, shot: 0, slam: 0, dash: 0 },
    invuln: 0,
  };

  if (data) {
    p.level = clamp(Math.round(+data.level) || 1, 1, 99);
    p.xpNeeded = xpFor(p.level);
    p.xp = clamp(Math.round(+data.xp) || 0, 0, p.xpNeeded - 1);
    p.gold = Math.max(0, Math.round(+data.gold) || 0);
    p.skillPoints = Math.max(0, Math.round(+data.skillPoints) || 0);
    if (Array.isArray(data.skills)) {
      for (const entry of data.skills) {
        if (!Array.isArray(entry)) continue;
        const node = NODE_BY_ID[entry[0]];
        if (!node) continue;
        const rank = clamp(Math.round(+entry[1]) || 0, 0, node.maxRank);
        if (rank > 0) p.skills.set(node.id, rank);
      }
    }
  } else {
    p.skillPoints = c.startSkillPoints || 0;
    for (const id of c.startSkills || []) {
      if (NODE_BY_ID[id]) p.skills.set(id, 1);
    }
  }

  G.player = p;
  recomputeStats();
  p.hp = p.stats.maxHp;
  p.mana = p.stats.maxMana;

  saveNow(); // fresh start overwrites the old save; resume rewrites identical data

  if (!unloadHooked) {
    unloadHooked = true;
    try { window.addEventListener('beforeunload', saveNow); } catch (e) { /* non-browser */ }
  }
}

// ---------------------------------------------------------------------------
// Kill rewards (module-level wiring per contract)
// ---------------------------------------------------------------------------
on('enemy:killed', (e) => {
  const enemy = e && e.enemy;
  if (!G.player || !enemy) return;
  gainXP(enemy.xpValue || 0);
  gainGold(enemy.goldValue || 0);
  // Second Skin: recover 5 HP on every kill.
  const p = G.player;
  if (!p.dead && getRank('second_skin') > 0 && p.hp > 0 && p.hp < p.stats.maxHp) {
    p.hp = Math.min(p.stats.maxHp, p.hp + 5);
  }
});
