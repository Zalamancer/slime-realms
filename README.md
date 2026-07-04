# Slime Realms

A 3D slime MMORPG that runs entirely in your browser. No install, no build step, no internet required — Three.js is bundled locally.

## Run

Browsers block ES modules from `file://` pages, so serve the folder with any static server:

```bash
cd slime-realms
python3 -m http.server 8000
# then open http://localhost:8000
```

(or `npx serve`, or VS Code's Live Server — anything works.)

Your character auto-saves to the browser (localStorage) — close the tab and continue later.

## Structure

- `index.html` — entry point, canvas + script loader
- `package.json` — minimal metadata (no dependencies)
- `js/main.js` — boot, input capture, game loop
- `js/core.js` — shared state (G), event bus
- `js/world.js` — procedural island, 5 zones, lighting, vegetation
- `js/slime.js` — slime mesh factory, squash & stretch animation
- `js/progression.js` — character classes, XP/levels, skill tree (3 branches, ~22 nodes)
- `js/combat.js` — 4 abilities, projectiles, damage, FX, synth audio
- `js/player.js` — movement physics, third-person camera, terrain follow
- `js/enemies.js` — 5 mob types, AI, world boss (King Gloop)
- `js/party.js` — co-op: invite bots, formation follow, ally combat, KO/revive
- `js/bots.js` — ~22 simulated players with chat, roaming, join/leave cycles
- `js/npcs.js` — ambient animals (bunnies, butterflies, birds, frogs, snails) + friendly NPCs (villagers, merchant, adventurers)
- `js/ui.js` — character select, HUD, party frames, minimap, chat, skill tree
- `libs/three.module.js` — Three.js r160, bundled
- `CONTRACT.md` — detailed integration contracts and module documentation

## Features

- **4 playable slimes** — Verdant (balanced), Ember (bruiser), Aqua (caster), Umbra (rogue)
- **Skill tree** — 3 branches (Vitality/Ferocity/Arcana), ~22 nodes unlocking double-jump, dash, AOE slam, pierce shots, and more
- **5 zones** — Slime Plaza (safe spawn), Green Fields, Whisperwood, Crystal Hollows, King's Arena with world boss
- **Party co-op** — invite nearby bots (max 3) to fight alongside you; they follow in formation, engage enemies, and can be knocked down/revived
- **Living world** — bots roaming and chatting, animals fleeing or grazing, adventurers patrolling and picking fights with mobs
- **Full MMO juice** — XP, gold, crits, knockback, floating damage numbers, smooth animations, synth sound effects
- **Offline** — all multiplayer is simulated locally; no server, no WebSocket needed

## Notes

- No `node_modules` or build artifacts — Three.js is vendored at `libs/three.module.js`
- Character data persists to `localStorage` under key `slime-realms-save-v1`
- Module import DAG is acyclic and documented in `CONTRACT.md`; no external CDN dependencies
- Plain ES modules — no build step, TypeScript, or transpilation required