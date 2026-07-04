# 🟢 Slime Realms

A 3D slime MMORPG that runs entirely in your browser. No install, no build step, no internet
required — Three.js is bundled locally.

![genre](https://img.shields.io/badge/genre-slime%20MMO-7ee787) ![engine](https://img.shields.io/badge/engine-three.js%20r160-blue) ![server](https://img.shields.io/badge/server-none%20needed-orange)

## How to play

Browsers block ES modules from `file://` pages, so serve the folder with any static server:

```bash
cd slime-realms
python3 -m http.server 8000
# then open http://localhost:8000
```

(or `npx serve`, or VS Code's Live Server — anything works.)

Your character auto-saves to the browser (localStorage) — close the tab and Continue later.

## Controls

| Input | Action |
|---|---|
| **WASD / arrows** | Move |
| **Space** | Jump (double-jump with Spring Coil 🦘) |
| **Left click / 1** | Bounce Strike (melee) |
| **Right click / 2** | Slime Shot 🟢 (unlock in tree) |
| **3** | Goo Slam 🌊 (unlock in tree) |
| **4 / Shift** | Slip Dash 💨 (unlock in tree) |
| **Drag mouse** | Orbit camera · **wheel** zoom |
| **E** | 🤝 Invite a nearby slime to your party (max 3) |
| **K** | Upgrade tree |
| **Enter** | Chat |
| **H** | Help |

## The game

- **4 playable slimes** — 🌿 Verdant (balanced), 🔥 Ember (bruiser), 💧 Aqua (caster, starts with
  Slime Shot), 🌑 Umbra (fast & critty, fragile).
- **An island with 5 zones** — Slime Plaza (safe spawn village) → Green Fields (Wild Slimes lv 1–3)
  → Whisperwood (Spike Slimes & Mushroom Brutes lv 4–8) → Crystal Hollows (Crystal Slimes lv 9–11,
  in the corners) → **King's Arena**, where **King Gloop 👑** (lv 13 world boss) waits. There's a
  lake. You can swim. Slowly. You're a slime.
- **Upgrade tree** — 3 branches (Vitality 🌿 / Ferocity 💥 / Arcana 🔮), ~22 nodes / 36 ranks:
  stat boosts, double jump, dash, AOE slam, triple-shot, piercing shots, and a capstone that makes
  you visibly bigger.
- **XP, levels, gold, crits, knockback, floating damage numbers, squishy sound effects** — the
  full MMO juice kit.
- **Party up!** — walk up to any of the ~23 slimes roaming the realm and press **E** to invite
  them (party of up to 3 + you). They follow in formation, pick their own targets, deal real
  damage, pull aggro off you, get knocked out ("KO"), and bounce back up 8 seconds later
  ("im ok lol"). Party frames with HP bars live under your portrait; your team shows green on
  the minimap. The boss's slam hits them too — bring friends, it's a real fight.
- **A living island** — bunnies that flee when you bounce at them, butterflies over the flowers,
  birds, lake frogs, snails; villagers (Old Tom, Hazel, Poppy, Bram) strolling Slime Plaza,
  Merchant Bo at his market stall, and three sword-swinging adventurers (Sir Reginald ⚔,
  Scout Fen 🏹, Mira the Bold 🗡) patrolling the roads and heroically shooing slimes around.
- **Other players™** — fellow slimes roam the island, grind mobs, chat about the boss, answer
  your questions, join and leave the realm. They are, to be honest, bots. There is no server —
  the multiplayer is lovingly simulated so the world feels alive offline. (A real WebSocket
  backend would slot into `js/bots.js`'s place if you ever want true multiplayer.)

## Code tour

| File | What it owns |
|---|---|
| `js/main.js` | Boot, input capture, game loop |
| `js/core.js` | Shared state (`G`), event bus |
| `js/world.js` | Procedural island, zones, lighting, vegetation |
| `js/slime.js` | Slime mesh factory + squash & stretch |
| `js/progression.js` | Classes, XP/levels, skill tree, saves |
| `js/combat.js` | Abilities, projectiles, damage, FX, synth audio |
| `js/player.js` | Movement physics, third-person camera |
| `js/enemies.js` | 5 mob types, multi-target AI, the boss |
| `js/bots.js` | The simulated fellow players |
| `js/party.js` | Party co-op: invites, formation follow, ally combat, KO/revive |
| `js/npcs.js` | Animals (bunnies, birds, frogs…) + humans (villagers, adventurers) |
| `js/ui.js` | Character select, HUD, party frames, minimap, chat, skill tree |

`CONTRACT.md` documents the module contracts everything was built against.

## Ideas for later

- A gold sink — potions / cosmetic hats at the Slime Plaza merchant
- Quests from a village elder slime
- Real multiplayer via a small WebSocket server
- More bosses (the lake is suspiciously deep)
