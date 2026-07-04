# SLIME REALMS — Integration Contract

A 3D slime MMORPG in the browser. Three.js (r160, vendored at `libs/three.module.js`, importmap name `three`),
ES modules, **no build step, no external network resources**. Cute low-poly pastel aesthetic, flat shading,
60 fps target on an integrated GPU.

Multiplayer is **simulated locally** (bots that look/chat like players). There is no server.

## Files & ownership

| File | Owner | Imports allowed (besides `three`) |
|---|---|---|
| `js/core.js` | done | — |
| `js/main.js` | done | everything |
| `js/world.js` | builder | core |
| `js/slime.js` | builder | core |
| `js/progression.js` | builder | core |
| `js/combat.js` | builder | core, world, progression |
| `js/player.js` | builder | core, world, slime, combat, progression |
| `js/enemies.js` | builder | core, world, slime, combat |
| `js/bots.js` | builder | core, world, slime |
| `js/ui.js` | builder | core, world, progression, combat |

This import DAG is acyclic — **do not add other cross-module imports** (would create cycles).
No module may touch `G.scene` / `G.camera` / DOM at import time — only inside its `init*` / `update*`
functions (top-level constants and data tables are fine). Every module must tolerate being imported
before the game starts.

Coding style: plain ES modules, no TypeScript syntax, no dependencies. Reuse scratch `Vector3`s in hot
loops instead of allocating per frame. `node --check js/<file>.js` must pass (package.json sets ESM).

## Shared state `G` (see core.js)

`G.scene/camera/renderer/canvas` are set before any `init*` runs.

Input contract (main.js writes, gameplay reads):
- `G.keys[code]` held; `G.keysPressed[code]` true only on the press frame (cleared by main each frame).
- `G.mouse.clicked / rclicked` frame flags; `.down / .rdown` held;
  `.mx / .my` accumulated drag deltas and `.wheel` accumulated wheel delta — **player.js consumes these
  and zeroes them** each frame (camera orbit/zoom).
- When `G.chatFocus` or `G.paused` is true, player.js must ignore gameplay input.
- `G.shake`: any module may `G.shake += n` (n ≈ 0.2–1.5); player.js applies it to the camera and decays it.

## Events (core.on / core.emit)

| event | payload | emitted by | consumed by |
|---|---|---|---|
| `game:start` | `{charId, name, fromSave}` | ui | main |
| `enemy:killed` | `{enemy}` | enemies | progression (xp/gold), bots (banter) |
| `player:damaged` | `{amount}` | combat | ui (red vignette) |
| `player:died` | `{}` | combat | ui (death screen), player |
| `player:respawn` | `{}` | ui (button) | player (reset hp/pos), combat |
| `player:levelup` | `{level}` | progression | ui (banner), combat (FX+sound), bots |
| `stats:changed` | `{}` | progression | ui |
| `skill:learned` | `{id, rank}` | progression | ui |
| `chat` | `{from, text, color?, system?, self?}` | bots / ui / enemies (boss announce) | ui (render), bots (replies) |
| `xp:gained` | `{amount}` | progression | ui (optional popup) |

## `G.player` shape

Created by `progression.initProgression()`; `group/vel/...` attached by `player.initPlayer()`.

```js
{
  name: 'Goober', charId: 'verdant', color: 0x6fcf5f,      // identity
  level: 1, xp: 0, xpNeeded: 25, gold: 0, skillPoints: 0,  // progression.js owns
  skills: Map<nodeId, rank>,
  hp: 100, mana: 40,                                       // current pools
  stats: { maxHp, maxMana, damage, attackSpeed, moveSpeed, regen, manaRegen,
           crit, armor, manaCost, scale },                 // derived; ONLY progression recomputes
  group: null /* THREE.Group */, vel: new THREE.Vector3(),
  grounded: false, dead: false, facing: 0 /* yaw rad */,   // player.js owns
  cooldowns: { melee: 0, shot: 0, slam: 0, dash: 0 },      // seconds left; combat.js owns
  invuln: 0,                                               // i-frame seconds left; combat.js owns
}
```

Base stats at level 1 (before class modifiers / skills): maxHp 100, maxMana 40, damage 10,
attackSpeed 1.0, moveSpeed 9, regen 1, manaRegen 3, crit 0.05, armor 0, manaCost 1.0, scale 1.0.
Per level (automatic): +9 maxHp, +1.8 damage, +4 maxMana, +0.1 regen.
Level-up: +1 skill point (+1 extra every 5th level), full heal, emit `player:levelup`.
XP curve: `xpNeeded = Math.round(25 * Math.pow(level, 1.5))`.

## Enemy shape (G.enemies entries)

```js
{ group, type, name, level, hp, maxHp, damage, speed, xpValue, goldValue,
  state /* 'idle'|'wander'|'chase'|'windup'|'return'|'dying' */,
  homePos: Vector3, aggroRange, attackRange, attackTimer,
  vel: Vector3, dead: false, hitFlash: 0, hpBar /* {sprite,set(frac)}|null */ }
```

Division of labor: `combat.damageEnemy()` mutates `hp`, sets `hitFlash`, FX; when hp ≤ 0 it sets
`enemy.dead = true` (nothing else). `enemies.updateEnemies()` notices `dead`, plays the death,
emits `enemy:killed` {enemy}, removes it from scene + `G.enemies`, schedules a respawn.

## Bot shape (G.bots entries)

`{ group, name, level, color, vel, state, target: Vector3, timer, chatTimer }` — cosmetic only
(never fight, never take damage). Online count shown by ui = `G.bots.length + 1`.

## World layout (world.js is the source of truth)

Square world, half-extent 120 (`WORLD_SIZE = 240`). Zones by distance r from origin:

- **r < 18 — Slime Plaza** (spawn village; safe, no enemies; mushroom houses, lanterns).
- **18 ≤ r < 55 — Green Fields** — gentle meadow. Wild Slimes lv 1–3.
- **55 ≤ r < 95 — Whisperwood** — denser trees, glow mushrooms. Spike Slimes lv 4–6, Mushroom Brutes lv 6–8.
- **Corners (|x| > 80 AND |z| > 80) — Crystal Hollows** — emissive crystals. Crystal Slimes lv 9–11.
- **(0, 92) radius 18 — King's Arena** — flattened, ring of standing stones. King Gloop lv 13 (boss).
- **Lake** centered ≈ (−70, 40), radius ≈ 24 (terrain dips below water there).

`terrainHeight(x, z)` is **pure, deterministic, cheap** (hash-based value noise — NO Math.random inside),
range ≈ [−2.5, 14]. Flat-ish (gentle, ≤ ~2.5) within r 16 of (0,0) and r 18 of (0, 92). Terrain rises
steeply beyond |x|,|z| ≈ 112 (boundary cliffs); player.js additionally clamps position to ±118.

### world.js exports
```js
export const WORLD_SIZE = 240;
export const WATER_LEVEL = 0.9;            // world y of the water surface
export function terrainHeight(x, z): number  // pure; usable before initWorld()
export function getSpawnPos(): THREE.Vector3 // fresh vector at Slime Plaza ground
export function initWorld(): void
export function updateWorld(dt): void        // water bob, clouds, subtle ambience
```
Lighting (hemisphere + one shadow-casting directional whose shadow box follows `G.player.group` when it
exists), fog + sky color, ground mesh with vertex colors by zone, instanced/merged vegetation,
village + arena + crystals + boundary shards. Budget: ≤ ~150 draw calls, shadow map 2048.

### slime.js exports
```js
export function createSlime({ color = 0x6fcf5f, size = 1 }): THREE.Group
// group.userData reserved for animation state; caller sets .position freely
export function animateSlime(group, dt, { moving, grounded, speed }): void
// squash & stretch: hop wobble while moving, stretch airborne, squash on landing, idle breathing
export function makeNameTag(text, { color = '#ffffff', sub = '' }): THREE.Sprite  // canvas sprite, crisp
export function makeHpBar(): { sprite: THREE.Sprite, set(frac: number): void }
```
Slimes: flattened flat-shaded sphere, glossy highlight, simple dark eyes + white specks + tiny smile,
slightly darker inner core for a gel feel. Cache shared geometries/materials.

### progression.js exports
```js
export const CHARACTERS = [ /* 4 classes, see below */ ];
export const SKILL_TREE = { branches: [ /* 3 branches, see below */ ] };
export function initProgression(charId, name, fromSave): void  // builds G.player (loads save if fromSave)
export function gainXP(n): void;  export function gainGold(n): void;
export function canLearn(id): { ok: boolean, reason?: string };
export function learnSkill(id): boolean;     // spends point, recomputes, emits, saves
export function getRank(id): number;
export function hasAbility(key): boolean;    // 'shot' | 'slam' | 'dash' | 'doubleJump'
export function recomputeStats(): void;      // base + levels + class + skills -> G.player.stats
export function hasSave(): { charId, name, level } | null;   // localStorage 'slime-realms-save-v1'
```
Listens for `enemy:killed` → `gainXP(enemy.xpValue); gainGold(enemy.goldValue)`. Auto-saves on
level/skill/gold changes.

**Classes** (id, color, flavor + modifiers):
- `verdant` 0x6fcf5f — balanced; +25% regen, +1 starting skill point.
- `ember` 0xff7043 — bruiser; +25% damage, −15% maxHp.
- `aqua` 0x4fc3f7 — caster; starts with the `shot` ability node already learned, +30 maxMana.
- `umbra` 0xab7df6 — rogue; +10% moveSpeed, +10% crit, −20% maxHp.

**Skill tree**: 3 branches × ~7 nodes ≈ 36 total ranks. Node shape:
`{ id, name, icon (emoji), desc, maxRank, tier (1..5), requires: [nodeIds — all must have rank ≥ 1] }`.
Cost: 1 point per rank. Stat math lives in `recomputeStats()` (switch on node id).
- **Vitality** (green 🌿): Gel Membrane (+20 maxHp ×3), Osmosis (+0.5 regen ×3), Spring Coil
  (**doubleJump**), Thick Goo (+2 armor ×3), Royal Jelly (+60 maxHp +1 regen), Second Skin (heal 5 on
  kill), capstone Titan Gel (+100 maxHp, +15% scale — visibly bigger slime!).
- **Ferocity** (red 💥): Sharp Bounce (+3 dmg ×3), Quick Squish (+10% atk speed ×3), Slip Dash
  (**dash**), Hardened Core (+10% crit ×2), Goo Slam (**slam**), Momentum (+10% moveSpeed ×2),
  capstone Berserk Ooze (+20% dmg, +10% crit).
- **Arcana** (blue 🔮): Slime Shot (**shot**), Inner Pool (+15 maxMana ×3), Flow (+1.5 manaRegen ×2),
  Splitter (shot fires 3 in a spread), Heavy Slug (shot +50% dmg & knockback), Echo (abilities cost
  20% less mana → `stats.manaCost = 0.8`), capstone Overflow (+40 maxMana, shots pierce).
Tier gating comes from `requires` chains within each branch.

### combat.js exports
```js
export const ABILITIES = [   // ui renders the hotbar from this, in slot order
  { id:'melee', slot:1, keyLabel:'1 / LMB',  name:'Bounce Strike', icon:'💥', mana:0,
    cdMax():number, unlocked():boolean /* always true */ },
  { id:'shot',  slot:2, keyLabel:'2 / RMB',  name:'Slime Shot',    icon:'🟢', mana:8,  ... },
  { id:'slam',  slot:3, keyLabel:'3',        name:'Goo Slam',      icon:'🌊', mana:22, ... },
  { id:'dash',  slot:4, keyLabel:'4 / Shift',name:'Slip Dash',     icon:'💨', mana:12, ... },
];
export function initCombat(): void
export function updateCombat(dt): void      // projectiles, particles, damage numbers, cooldowns, regen ticks
export function tryAbility(id): boolean     // validates unlock+cooldown+mana; fires FX; true if it fired
                                            // for 'dash' it only validates/cooldowns/FX — player.js applies the impulse
export function getCooldown(id): number     // seconds left (0 = ready)
export function damageEnemy(enemy, amount, { crit = false, knockback = 0, fromPos = null } = {}): void
export function damagePlayer(amount, fromPos = null): void  // armor, 0.6s i-frames, knockback, shake, death
export function spawnDamageNumber(pos, text, color?): void
export function spawnBurst(pos, color, count?, speed?): void   // pooled particle puff
export function spawnRing(pos, color, radius?): void           // expanding ground ring FX
export function playSound(name): void  // WebAudio synth: 'hit','squish','shot','slam','dash','hurt',
                                       // 'level','learn','die','coin','jump' — lazy ctx, try/catch safe
```
Melee: range ~3.2, ~100° arc in facing direction, crit ×2 (gold numbers). Shot: projectile speed ~28,
life ~1.6 s, Splitter → 3-way ±12°, Overflow → pierce. Slam: radius 6, 1.6× damage, knock-up.
Player HP/mana regen ticks live in `updateCombat`. Cap pooled particles ≈ 200.

### player.js exports
```js
export function initPlayer(): void   // slime mesh (class color, stats.scale), name tag "<name> · Lv N",
                                     // spawn at world.getSpawnPos(), camera behind
export function updatePlayer(dt): void
```
WASD/arrows move relative to camera yaw (accel ~60, ground friction ~10, air ~2), Space jump (v≈11,
gravity≈28; double jump if `hasAbility('doubleJump')`), terrain follow via `terrainHeight`, water
(below `WATER_LEVEL`) slows to ×0.55 with a bob. Camera: third-person orbit — drag (held LMB or RMB)
consumes `G.mouse.mx/my`, wheel zoom 6–26, pitch clamp; smooth follow; applies + decays `G.shake`.
Abilities: `keysPressed` Digit1/`G.mouse.clicked` → `tryAbility('melee')`; Digit2/`rclicked` → 'shot';
Digit3 → 'slam'; Digit4/ShiftLeft → 'dash' (on true, apply impulse ≈ 26 in move/facing dir).
Respects `G.paused`/`G.chatFocus`/`dead`. Listens `player:respawn` → reset hp/pos/vel at spawn.
Updates the name tag when `player:levelup` fires. Clamp |x|,|z| ≤ 118.

### enemies.js exports
```js
export function initEnemies(): void
export function updateEnemies(dt): void
```
Types (built from slime.js parts + extra meshes): Wild Slime (lv1–3, ~10 alive, Green Fields),
Spike Slime (lv4–6, ~8, cone spikes, faster), Mushroom Brute (lv6–8, ~6, cap hat, slow, hits hard),
Crystal Slime (lv9–11, ~5, emissive shards, corners), **King Gloop** (lv13 boss, size ~3.2, crown,
hp ~600, telegraphed AOE slam — expanding `spawnRing` warning then `damagePlayer` if close; at 50% hp
spawns 2 Wild minions once; on death emit `chat` `{from:'⚔ Realm', system:true, text:'<player> has
slain King Gloop!'}` and a long respawn ≈ 90 s).
Stat curve: hp ≈ 20+8·lv, damage ≈ 3+1.5·lv, xpValue ≈ 8+4·lv, goldValue ≈ lv + rand.
AI: wander near homePos → chase when player within aggroRange (and alive) → windup 0.4 s telegraph
(squash + darken) → strike via `damagePlayer` if still in attackRange → give up beyond 1.6× aggro and
return (heal). Separation push between enemies, terrain stick, `animateSlime`, hp bar visible when
hurt/aggro, boss gets a name tag. Respawn 12–25 s. No enemies inside r 18 of spawn.

### bots.js exports
```js
export function initBots(): void
export function updateBots(dt): void
```
~9 fake players: name pool (GooberTTV, moss_maiden, BlobRoss, xX_SlimeLord_Xx, JellyJim, drip_drop,
SlimeShady, kingwobble, oozelord99, pebblewort, …), pastel colors, level 3–34, name tags in
party-blue `#7ec8ff` with `Lv N` sub. Roam waypoints across zones (terrain-following, hop while
moving via `animateSlime`, idle pauses, occasional spin emote). Chat: one bot speaks every ~18–45 s
from a pool of ~40 MMO-flavored lines referencing real zones/boss ("lfg King Gloop, need 2 more",
"selling royal jelly at the plaza", "how do I open the skill tree lol" → another bot answers
"press K" a few seconds later). Join/leave cycle every 60–120 s with a system chat line
("BlobRoss has joined the realm"). Reacts (40%, 2–6 s delay) to player chat (`self:true`) and to
`player:levelup` on multiples of 5 ("grats!").

### ui.js exports
```js
export function initUI(): void   // builds ALL its DOM inside <div id="ui-root"> appended to body,
                                 // injects its own <style>; never touches the #game canvas
export function updateUI(dt): void
```
- **Character select** (boot): title "SLIME REALMS", animated CSS slime blobs per class, class cards
  (name, tagline, bonus list), name input with a fun random default, Start; Continue button if
  `hasSave()` (→ emit `game:start` with `fromSave: true`).
- **HUD**: top-left frame (blob portrait, name, level badge, HP + mana bars with numbers, gold 🪙);
  thin XP bar across the bottom; bottom-center hotbar of 4 slots from `combat.ABILITIES` (icon, key
  label, mana cost, radial cooldown sweep, 🔒 + "unlock in skill tree (K)" tooltip when locked);
  pulsing "K — skill points!" badge when `skillPoints > 0`; top-right round minimap (precompute a
  96×96 terrain bitmap from `terrainHeight` colors at init; live dots — red enemies, ⭐ boss, blue
  bots, white player arrow with heading) + "🟢 N online".
- **Chat** bottom-left: log (fades after ~8 s, solid on hover), Enter focuses input (set
  `G.chatFocus`), send → emit `chat` `{from: player.name, text, self: true}`; renders all `chat`
  events (system lines italic).
- **Skill tree** (K toggles, Esc closes; sets `G.paused`): points header, 3 colored branch columns,
  nodes as circles (icon, rank pips, connector lines), hover tooltip (desc, cost, requirement),
  click → `learnSkill` (flash + `playSound('learn')`); locked/available/maxed visual states.
- **Death screen** ("You dissolved… 💧" + Respawn button → emit `player:respawn`), **level-up banner**,
  red damage vignette on `player:damaged`, controls/help overlay on H plus a one-line hint footer.
Look: chunky rounded cute-MMO HUD, soft shadows, dark translucent panels, accent `#7ee787`.
Guard everything pre-`G.started` (HUD hidden until the game begins).

## Keybinds (canonical)

WASD/arrows move · Space jump (×2 with Spring Coil) · LMB/1 Bounce Strike · RMB/2 Slime Shot ·
3 Goo Slam · 4/Shift Slip Dash · drag orbit camera · wheel zoom · K skill tree · Enter chat ·
H help · Esc close panels

---

# V2 ADDENDUM — Party system, NPCs, density

New goals: the player can **team up with bot slimes and fight together**; the world is **much
denser** (more bots, more enemies, more vegetation); **animals and humans** populate the island.

## New shared state & events

`G.party = []` — bot objects currently in the player's party (max 3). Owned by `party.js`.
Bot objects gain combat fields (set in `bots.js` makeBot): `hp`, `maxHp` (= 60 + 10·level),
`dmg` (= 4 + 1.2·level), `downed: false`, `party: false`.

| new event | payload | emitted by | consumed by |
|---|---|---|---|
| `party:changed` | `{}` | party.js | ui (re-render frames) |
| `ally:downed` | `{bot}` | party.js | ui (grey frame), bots (sad chat chance) |
| `ally:up` | `{bot}` | party.js | ui |

## New module: party.js (owner: builder)

Imports allowed: core, world (terrainHeight), slime (animateSlime), combat (damageEnemy,
spawnBurst, spawnRing, spawnDamageNumber, playSound). Does NOT import enemies/bots (reads
`G.enemies`, bot objects arrive via invite).

```js
export function initParty(): void
export function updateParty(dt): void          // E-key invites + drives all party-bot AI
export function getInviteTarget(): bot | null  // nearest invitable bot within 6u (ui polls this)
export function removeFromParty(bot): void     // ui ✕ button; bot says thanks, resumes roaming
export function disband(): void
export function damageAlly(bot, amount, fromPos): void  // enemies.js calls this when striking a bot
```

- **Invite**: `G.keysPressed['KeyE']` (ignore while paused/chatFocus/dead). Target = nearest bot
  within 6u that is not in party, not downed, not mid join/leave. Party full (3) → system chat
  'Your party is full.' (throttled). On invite: `bot.party = true`, hp = maxHp, push to G.party,
  emit `party:changed`, bot chats acceptance after ~0.6s ('inv accepted, omw!', 'sure lol', …).
- **Follow AI** (party.js fully drives partied bots — bots.js must skip them): formation slots
  behind/beside the player (offsets ~2.2u apart); walk at 7.5 u/s toward slot, sprint ×1.5 when
  >18u away, teleport to player if >60u; terrain-follow, face movement, `animateSlime` hops.
- **Combat AI**: engage rule — any enemy that is aggroed (state 'chase'/'windup') within 16u of
  the player, or any enemy within 10u of the bot itself. Move into melee range (~2.6), bounce
  attack every 1.0–1.4s: `damageEnemy(target, bot.dmg, { fromPos: botPos, knockback: 5 })` +
  squash impulse (`group.userData.squash`) + small `spawnBurst`. Spread targets (prefer the
  enemy fewest allies already target). Occasional kill quips via `chat` ('get rekt', 'ez').
- **Downed**: `damageAlly` reduces hp (floating number via spawnDamageNumber, red-ish), at 0 →
  `downed = true`, emit `ally:downed`, squash flat (own the scale while downed; skip
  animateSlime), bot chats ('oof', 'rip me'); after 8s revive at 60% hp, emit `ally:up`,
  'im ok lol'. Downed bots are NOT valid enemy targets and don't fight.
- Party is not persisted across reloads. On `player:died`, party stays (they keep fighting!).

## enemies.js changes (owner: builder, edits existing file)

1. **Density**: counts wild 10→20, spike 8→15, brute 6→11, crystal 8→13 (boss still 1).
2. **Multi-target AI**: replace the implicit player-only target with: candidates = player
   (alive) + `G.party` bots (`!downed`). Aggro check = nearest candidate within aggroRange;
   chase/windup/strike track that candidate (re-evaluate nearest each frame is fine); leash
   logic vs homePos unchanged. Strike: player → `combat.damagePlayer(...)` as today; party bot →
   `party.damageAlly(bot, enemy.damage, enemyPos)` (import party.js — no cycle: party.js never
   imports enemies.js). Boss slam damages ALL candidates within its radius (player via
   damagePlayer, allies via damageAlly).

## bots.js changes (owner: builder, edits existing file)

1. **Density**: START_COUNT 9→22, MIN_BOTS 8→20, MAX_BOTS 10→24.
2. makeBot adds the combat fields listed above (hp/maxHp/dmg/downed/party).
3. The update loop **skips bots with `bot.party === true`** (party.js drives them) — but party
   members still participate in the chat engine (they're chatty teammates).
4. Join/leave cycle must NEVER pick a bot that is `party || downed` to leave.
5. New chat lines about parties ('anyone wanna party up?', 'press E on a slime to invite them
   btw'), occasional reaction to `ally:downed` ('F').

## New module: npcs.js (owner: builder)

Imports allowed: core, world (terrainHeight, WATER_LEVEL), combat (spawnBurst only, playSound).
Builds all its own low-poly meshes (shared module-level geometries/materials; flatShading; no
slime.js dependency). `export function initNPCs(): void; export function updateNPCs(dt): void`

- **Animals** (~30, ambient, non-combat, never in G.enemies): bunnies ×10 (idle nibble, random
  hops; FLEE in fast hops when player/any bot within 4u, ears back), butterflies ×8 (sine-flutter
  loops near flowers/meadow, 0.5–1.5u altitude), birds ×6 (fly wide arcs at y 8–18, occasionally
  land and peck, flush when approached), frogs ×4 (lake shore, periodic hops, throat-bob),
  snails ×3 (near-stationary, tiny eye-stalks). All terrain-clamped, ≤5 meshes each.
- **Humans** (~8, friendly, invulnerable, gold name tags `#ffd87a` — classic NPC color, canvas
  sprite like slime.js's makeNameTag but built locally): 5 villagers in Slime Plaza (blocky
  low-poly: legs/tunic torso/head/hair-or-hat, ~7 meshes; stroll between the mushroom houses,
  pause, occasionally wave an arm), 'Merchant Bo' stands near a tiny market-stall prop npcs.js
  adds beside a house; 3 adventurers ('Sir Reginald ⚔', 'Scout Fen 🏹', 'Mira the Bold 🗡')
  with a simple sword mesh who walk long patrol loops plaza → Green Fields → Whisperwood; when
  within 3u of a non-boss enemy they do a THEATRICAL swing every ~1.5s: small lunge, spawnBurst
  at the enemy, set `enemy.hitFlash = 0.3` and nudge `enemy.vel` away ~3 — **no real damage**
  (real damage would feed the player XP via 'enemy:killed' and despawn zones).
- Gentle walk-cycle bob/limb swing; no per-frame allocations; everything outside the lake.

## world.js changes (owner: builder, edits existing file)

Vegetation density up: trees ≈×1.6, flowers ≈×1.8, glow-mushrooms ≈×1.6, rocks ≈×1.4 (keep
plaza/arena/lake exclusion rules and the deterministic seeded placement; instanced as before).

## ui.js changes (owner: builder, edits existing file)

1. **Party frames** under the player frame (left column): per member — small blob portrait in
   bot color, name, 'Lv N', hp bar (lerped), ✕ leave button → `party.removeFromParty(bot)`;
   downed → grey frame + 'KO' badge; re-render on `party:changed`/`ally:downed`/`ally:up`,
   hp bars updated in updateUI.
2. **Invite prompt**: fixed pill above the hotbar, visible when `party.getInviteTarget()`
   returns a bot (poll ~5Hz in updateUI): '🤝 Press E — invite <name> to your party'. When the
   party is full, don't show it.
3. Help overlay: add row ['E', 'Invite a nearby slime to your party (max 3)']; hint footer:
   add 'E party'.
4. ui.js may now import party.js (getInviteTarget/removeFromParty only). No cycle: party.js
   never imports ui.
