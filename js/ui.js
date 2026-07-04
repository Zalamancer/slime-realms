// ui.js — ALL DOM UI for Slime Realms: character select, HUD, hotbar, minimap,
// chat, skill tree, death screen, level banner, damage vignette, help overlay.
// Builds everything inside <div id="ui-root"> appended to document.body in initUI().
// Never touches the #game canvas or G.scene/G.camera.
import { G, on, emit, clamp, lerp, pick } from './core.js';
import { terrainHeight, WATER_LEVEL } from './world.js';
import { CHARACTERS, SKILL_TREE, canLearn, learnSkill, getRank, hasSave } from './progression.js';
import { ABILITIES, getCooldown, playSound } from './combat.js';
import { getInviteTarget, removeFromParty } from './party.js';

// ---------------------------------------------------------------- constants

const RANDOM_NAMES = [
  'Goober', 'Wobbles', 'SirSquish', 'Puddles', 'Boba', 'Jellybean', 'Mochi',
  'Gloopert', 'Bloop', 'Dewdrop', 'Squidge', 'Tofu', 'Wiggles', 'Pip',
  'Slimon', 'Gelbert', 'Plorp', 'Nugget', 'Drizzle', 'Bouncy',
];

// Fallback presentation data per class id (used if progression.CHARACTERS
// entries don't carry tagline / bonus strings of their own).
const CHAR_META = {
  verdant: { tag: 'the balanced bouncer', bonuses: ['+25% HP regen', '+1 starting skill point'] },
  ember: { tag: 'the spicy bruiser', bonuses: ['+25% damage', '−15% max HP'] },
  aqua: { tag: 'the bubbly caster', bonuses: ['Starts with Slime Shot', '+30 max mana'] },
  umbra: { tag: 'the sneaky rogue', bonuses: ['+10% move speed', '+10% crit', '−20% max HP'] },
};

const BRANCH_FALLBACK = [
  { name: 'Vitality', icon: '\u{1F33F}', color: '#7ee787' },
  { name: 'Ferocity', icon: '\u{1F4A5}', color: '#ff7066' },
  { name: 'Arcana', icon: '\u{1F52E}', color: '#6fb7ff' },
];

const ZONE_ROWS = [
  ['Slime Plaza', 'Safe spawn village — no enemies'],
  ['Green Fields', 'Wild Slimes · Lv 1–3'],
  ['Whisperwood', 'Spike Slimes & Mushroom Brutes · Lv 4–8'],
  ['Crystal Hollows', 'Crystal Slimes in the far corners · Lv 9–11'],
  ["King's Arena", 'King Gloop \u{1F451} · Lv 13 world boss, due north'],
];

const HELP_ROWS = [
  ['WASD / Arrows', 'Move'],
  ['Space', 'Jump (double jump with Spring Coil)'],
  ['LMB / 1', 'Bounce Strike'],
  ['RMB / 2', 'Slime Shot'],
  ['3', 'Goo Slam'],
  ['4 / Shift', 'Slip Dash'],
  ['E', 'Invite a nearby slime to your party (max 3)'],
  ['Drag mouse', 'Orbit camera'],
  ['Mouse wheel', 'Zoom'],
  ['K', 'Skill tree'],
  ['Enter', 'Chat'],
  ['H', 'This help'],
  ['Esc', 'Close panels'],
];

const HALF = 120;           // world half-extent for the minimap
const MM_SIZE = 170;        // minimap canvas px
const MM_RES = 96;          // terrain bitmap resolution
const CHAT_MAX = 50;
const CHAT_FADE_AFTER = 8;  // seconds

const CSS = `
#ui-root, #ui-root * { box-sizing: border-box; margin: 0; padding: 0; }
#ui-root {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: 'Trebuchet MS', 'Segoe UI', 'Lucida Grande', system-ui, -apple-system, sans-serif;
  -webkit-user-select: none; user-select: none; color: #eef3fb;
}
#ui-root .panel {
  background: rgba(10,16,32,.78); border: 1px solid rgba(255,255,255,.09);
  border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
#ui-root button { font-family: inherit; }

/* ============================ character select ============================ */
#cs {
  position: absolute; inset: 0; z-index: 100; pointer-events: auto; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16px; padding: 20px;
  background: linear-gradient(160deg, #58b3e8 0%, #6fd0a2 52%, #ffd98a 135%);
  transition: opacity .55s ease;
}
#cs.gone { opacity: 0; pointer-events: none; }
.csblob {
  position: absolute; pointer-events: none; background: rgba(255,255,255,.16);
  border-radius: 53% 47% 58% 42% / 60% 55% 45% 40%; filter: blur(2px);
  animation: csfloat ease-in-out infinite;
}
@keyframes csfloat {
  0%, 100% { transform: translate(0, 0) rotate(0deg) scale(1); }
  33% { transform: translate(22px, -30px) rotate(8deg) scale(1.06); }
  66% { transform: translate(-16px, 14px) rotate(-6deg) scale(.96); }
}
#cs-title { font-size: clamp(40px, 7vw, 72px); font-weight: 900; letter-spacing: 3px; color: #fff;
  text-shadow: 0 4px 0 rgba(28,82,58,.4), 0 12px 28px rgba(0,0,0,.3); line-height: 1; }
#cs-title .tl { display: inline-block; animation: tbounce 1.9s ease-in-out infinite; }
@keyframes tbounce {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  35% { transform: translateY(-12px) rotate(-2.5deg) scaleY(1.06); }
  55% { transform: translateY(2px) rotate(1deg) scaleY(.94); }
}
#cs-sub { font-size: 15px; font-weight: 700; letter-spacing: 5px; color: rgba(255,255,255,.92);
  text-shadow: 0 2px 6px rgba(0,0,0,.25); margin-top: -6px; }
#cs-cards { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; max-width: 860px; }
.ccard {
  width: 176px; padding: 14px 12px 12px; border-radius: 22px; text-align: center;
  background: rgba(10,16,32,.55); border: 3px solid transparent; cursor: pointer;
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, background .16s ease;
}
.ccard:hover { transform: translateY(-5px); background: rgba(10,16,32,.65); }
.ccard.sel { border-color: var(--c); background: rgba(10,16,32,.74);
  box-shadow: 0 0 24px -3px var(--c), 0 10px 24px rgba(0,0,0,.3); transform: translateY(-5px); }
.cname { font-weight: 900; font-size: 17px; color: #fff; }
.ctag { font-size: 11px; font-style: italic; color: rgba(255,255,255,.72); margin: 2px 0 8px; }
.cbon { list-style: none; text-align: left; font-size: 11px; color: #c9ecd0; min-height: 48px; }
.cbon li { padding: 2px 0 2px 2px; }
.cbon li::before { content: '✦ '; color: var(--c); }
.cblob {
  position: relative; width: 76px; height: 58px; margin: 4px auto 10px;
  background: radial-gradient(circle at 36% 28%, rgba(255,255,255,.55), rgba(255,255,255,0) 48%), var(--c);
  border-radius: 53% 47% 55% 45% / 62% 60% 40% 38%;
  box-shadow: inset 0 -9px 12px rgba(0,0,0,.18), 0 7px 12px rgba(0,0,0,.28);
  animation: blobidle 2.3s ease-in-out infinite; animation-delay: var(--d, 0s);
}
@keyframes blobidle {
  0%, 100% { transform: scale(1, 1); border-radius: 53% 47% 55% 45% / 62% 60% 40% 38%; }
  50% { transform: scale(1.08, .9) translateY(3px); border-radius: 50% 50% 52% 48% / 55% 56% 44% 45%; }
}
.beye { position: absolute; top: 36%; width: 8px; height: 11px; border-radius: 50%; background: #20262e; }
.beye.l { left: 29%; } .beye.r { right: 29%; }
.beye::after { content: ''; position: absolute; top: 1.5px; left: 1.5px; width: 3px; height: 3px;
  border-radius: 50%; background: #fff; opacity: .95; }
.bmouth { position: absolute; top: 60%; left: 50%; width: 11px; height: 6px; margin-left: -5.5px;
  border-bottom: 2.5px solid rgba(18,28,38,.65); border-radius: 0 0 12px 12px; }
#cs-namerow { display: flex; gap: 9px; align-items: center; padding: 10px 16px; border-radius: 999px;
  background: rgba(10,16,32,.55); }
#cs-namerow label { font-size: 13px; font-weight: 800; color: #fff; }
#cs-name { width: 190px; padding: 8px 13px; border-radius: 999px; border: 2px solid rgba(255,255,255,.18);
  background: rgba(255,255,255,.12); color: #fff; font-size: 14px; font-weight: 700; font-family: inherit;
  outline: none; transition: border-color .15s; }
#cs-name:focus { border-color: #7ee787; }
#cs-dice { border: none; background: rgba(255,255,255,.15); border-radius: 50%; width: 34px; height: 34px;
  font-size: 17px; cursor: pointer; transition: transform .15s, background .15s; }
#cs-dice:hover { transform: rotate(25deg) scale(1.12); background: rgba(255,255,255,.28); }
#cs-start {
  border: none; cursor: pointer; padding: 15px 48px; border-radius: 999px; font-size: 20px; font-weight: 900;
  letter-spacing: 1px; color: #0e3018; background: linear-gradient(180deg, #97f2a4, #50c468);
  box-shadow: 0 7px 0 #2e8c46, 0 14px 26px rgba(0,0,0,.3); transition: transform .12s, box-shadow .12s;
}
#cs-start:hover { transform: translateY(-2px); box-shadow: 0 9px 0 #2e8c46, 0 16px 30px rgba(0,0,0,.32); }
#cs-start:active { transform: translateY(3px); box-shadow: 0 3px 0 #2e8c46, 0 8px 16px rgba(0,0,0,.3); }
#cs-cont {
  border: 2px solid #7ee787; cursor: pointer; padding: 9px 26px; border-radius: 999px;
  font-size: 13.5px; font-weight: 800; color: #7ee787; background: rgba(10,16,32,.55);
  transition: background .15s, transform .12s;
}
#cs-cont:hover { background: rgba(20,42,30,.8); transform: translateY(-1px); }

/* ================================== HUD ================================== */
#hud { position: absolute; inset: 0; pointer-events: none; }
#hud.hidden, .hidden { display: none !important; }

/* player frame */
#pframe { position: absolute; top: 14px; left: 14px; display: flex; gap: 13px; align-items: center;
  padding: 11px 18px 13px 13px; }
.pwrap { position: relative; width: 58px; flex: none; }
#pblob { width: 56px; height: 44px; }
#plvl { position: absolute; right: -8px; bottom: -8px; min-width: 22px; height: 22px; padding: 0 4px;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #ffe9a3, #ffc94d); color: #5c3d04; font-size: 11.5px; font-weight: 900;
  border: 2px solid rgba(10,16,32,.92); box-shadow: 0 2px 6px rgba(0,0,0,.4); }
#pnamerow { display: flex; align-items: baseline; gap: 9px; }
#pname { font-weight: 900; font-size: 15px; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
#pgold { font-size: 12px; font-weight: 800; color: #ffd75e; text-shadow: 0 1px 2px rgba(0,0,0,.7); }
.bar { position: relative; width: 192px; height: 16px; margin-top: 5px; border-radius: 9px;
  background: rgba(0,0,0,.48); border: 1px solid rgba(255,255,255,.08); overflow: hidden; }
.bar.mana { height: 12px; margin-top: 4px; }
.bar .fill { height: 100%; width: 0%; border-radius: 8px; }
.bar.mana .fill { background: linear-gradient(180deg, #65c6ff, #3a86d6); }
.bar .btxt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.9); letter-spacing: .4px; }

/* party frames (column under the player frame) */
#pframes { position: absolute; top: 106px; left: 14px; display: flex; flex-direction: column;
  gap: 8px; width: 204px; }
.pmframe { display: flex; gap: 9px; align-items: center; position: relative; padding: 7px 9px;
  border-radius: 13px; transition: filter .3s ease, opacity .3s ease; animation: pmin .25s ease; }
@keyframes pmin { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
.pmframe .cblob { flex: none; margin: 0; }
.pmframe .beye { width: 5px; height: 7px; }
.pmframe .beye::after { width: 2px; height: 2px; top: 1px; left: 1px; }
.pmframe .bmouth { width: 8px; height: 4px; margin-left: -4px; border-bottom-width: 2px; }
.pmframe.ko { filter: grayscale(.9) brightness(.62); }
.pminfo { flex: 1; min-width: 0; }
.pmnamerow { display: flex; align-items: baseline; gap: 6px; }
.pmname { flex: 1; min-width: 0; font-weight: 800; font-size: 12px; color: #7ec8ff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,.7); }
.pmlvl { flex: none; font-size: 10px; font-weight: 800; color: #ffd75e;
  text-shadow: 0 1px 2px rgba(0,0,0,.7); }
.pmhp { position: relative; height: 7px; margin-top: 4px; border-radius: 5px;
  background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.07); overflow: hidden; }
.pmhp .fill { height: 100%; width: 100%; border-radius: 4px;
  background: linear-gradient(180deg, #8ceb96, #46a957); transition: background .25s; }
.pmhp .fill.low { background: linear-gradient(180deg, #ff9a8a, #d9534f); }
.pmx { flex: none; width: 18px; height: 18px; border: none; border-radius: 50%; pointer-events: auto;
  cursor: pointer; background: rgba(255,255,255,.08); color: #b9c5d8; font-size: 10px; font-weight: 900;
  line-height: 1; display: flex; align-items: center; justify-content: center; padding: 0;
  transition: background .15s, color .15s, transform .12s; }
.pmx:hover { background: rgba(255,120,120,.4); color: #fff; transform: scale(1.12); }
.pmko { position: absolute; top: -7px; left: -6px; display: none; padding: 2px 7px; border-radius: 8px;
  font-size: 9px; font-weight: 900; letter-spacing: .5px; color: #fff;
  background: linear-gradient(180deg, #ff8a7a, #d44545); border: 1px solid rgba(10,16,32,.8);
  box-shadow: 0 2px 6px rgba(0,0,0,.45); }
.pmframe.ko .pmko { display: block; }

/* invite prompt pill */
#invpill { position: absolute; left: 50%; bottom: 156px; white-space: nowrap; pointer-events: none;
  font-size: 12.5px; font-weight: 800; color: #e8f2ff; padding: 8px 18px; border-radius: 999px;
  background: rgba(10,16,32,.85); border: 1px solid rgba(126,200,255,.35);
  box-shadow: 0 8px 18px rgba(0,0,0,.4), 0 0 16px rgba(126,200,255,.16);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; transform: translateX(-50%) translateY(10px) scale(.88);
  transition: opacity .16s ease, transform .2s cubic-bezier(.34,1.56,.64,1); }
#invpill.show { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
#invpill .invkey { display: inline-block; margin: 0 1px; padding: 1px 8px 2px; border-radius: 7px;
  background: #25345a; color: #cfe2ff; border: 1px solid rgba(255,255,255,.18); font-weight: 900; }
#invpill .invname { color: #7ec8ff; }

/* hotbar */
#hotbar { position: absolute; left: 50%; bottom: 46px; transform: translateX(-50%);
  display: flex; gap: 11px; pointer-events: auto; }
.slot { position: relative; width: 58px; height: 58px; border-radius: 15px; font-size: 26px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(10,16,32,.78); border: 2px solid rgba(255,255,255,.11);
  box-shadow: 0 6px 14px rgba(0,0,0,.35); transition: filter .2s, opacity .2s; }
.slot .key { position: absolute; top: -8px; left: -7px; font-size: 9px; font-weight: 800; z-index: 2;
  background: #25345a; color: #cfe2ff; padding: 2px 6px; border-radius: 8px; white-space: nowrap;
  border: 1px solid rgba(255,255,255,.16); box-shadow: 0 2px 5px rgba(0,0,0,.4); }
.slot .mc { position: absolute; bottom: -7px; right: -6px; font-size: 10px; font-weight: 900; z-index: 2;
  background: #1c4066; color: #9fd2ff; padding: 1px 6px; border-radius: 8px;
  border: 1px solid rgba(140,200,255,.32); box-shadow: 0 2px 5px rgba(0,0,0,.4); }
.slot .mc.low { background: #5a2030; color: #ff9aa6; border-color: rgba(255,140,160,.35); }
.slot .cdov { position: absolute; inset: 0; border-radius: 13px; display: none; pointer-events: none; }
.slot .cdt { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 900; color: #fff; text-shadow: 0 1px 4px #000; pointer-events: none; }
.slot .lock { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  font-size: 20px; border-radius: 13px; background: rgba(8,10,20,.55); }
.slot.locked { filter: grayscale(.85); opacity: .55; }
.slot.locked .lock { display: flex; }
.slot.flash { animation: slotflash .3s ease; }
@keyframes slotflash {
  0% { transform: scale(1.14); border-color: #7ee787; box-shadow: 0 0 20px rgba(126,231,135,.8); }
  100% { transform: scale(1); }
}
.slot .tip { position: absolute; bottom: 70px; left: 50%; transform: translateX(-50%); white-space: nowrap;
  background: rgba(10,16,32,.92); border: 1px solid rgba(255,255,255,.12); color: #dfe7f5;
  font-size: 11px; font-weight: 700; padding: 5px 10px; border-radius: 9px; opacity: 0;
  transition: opacity .15s; pointer-events: none; box-shadow: 0 6px 14px rgba(0,0,0,.4); }
.slot:hover .tip { opacity: 1; }

/* skill point badge */
#spbadge { position: absolute; left: 50%; bottom: 118px; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer; border: none; font-size: 12.5px; font-weight: 900;
  padding: 7px 17px; border-radius: 999px; color: #0c2913; letter-spacing: .3px;
  background: linear-gradient(180deg, #97f2a4, #50c468); box-shadow: 0 0 20px rgba(126,231,135,.55);
  animation: sppulse 1.4s ease-in-out infinite; }
@keyframes sppulse { 0%, 100% { transform: translateX(-50%) scale(1); } 50% { transform: translateX(-50%) scale(1.08); } }

/* minimap */
#mmwrap { position: absolute; top: 14px; right: 14px; display: flex; flex-direction: column;
  align-items: center; gap: 7px; }
#mmring { width: ${MM_SIZE}px; height: ${MM_SIZE}px; border-radius: 50%; overflow: hidden;
  border: 3px solid rgba(255,255,255,.2); box-shadow: 0 8px 22px rgba(0,0,0,.45); background: #0b1020; }
#mmcanvas { display: block; }
#mmonline { font-size: 11.5px; font-weight: 700; color: #cfe7d2; background: rgba(10,16,32,.78);
  padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(255,255,255,.08); }

/* chat */
#chat { position: absolute; left: 14px; bottom: 30px; width: 344px; pointer-events: auto;
  display: flex; flex-direction: column; gap: 6px; }
#chatlog { max-height: 212px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
  padding: 4px 6px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
.cline { font-size: 12.5px; line-height: 1.4; color: #e7edf7;
  text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 6px rgba(0,0,0,.5);
  opacity: 1; transition: opacity 1s ease; overflow-wrap: break-word; }
.cline.dim { opacity: 0; }
#chat:hover .cline.dim, #chat.cfocus .cline.dim { opacity: .96; transition: opacity .15s ease; }
.cline.sys { font-style: italic; color: #9aa7bd; }
.cfrom { font-weight: 800; }
#chatin { width: 100%; padding: 7px 11px; border-radius: 10px; font-size: 12.5px; font-family: inherit;
  background: rgba(10,16,32,.66); border: 1px solid rgba(255,255,255,.11); color: #fff; outline: none;
  opacity: .55; transition: opacity .2s, border-color .2s, background .2s; }
#chatin:focus { opacity: 1; border-color: #7ee787; background: rgba(10,16,32,.88); }

/* XP bar */
#xpwrap { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; pointer-events: auto; }
#xpbar { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; background: rgba(255,255,255,.07); }
#xpfill { height: 100%; width: 0%; background: linear-gradient(90deg, #54d364, #7ee787);
  box-shadow: 0 0 7px rgba(126,231,135,.45); transition: width .3s ease, box-shadow .3s, filter .3s;
  border-radius: 0 4px 4px 0; }
#xpfill.glow { box-shadow: 0 0 16px #7ee787, 0 -3px 12px rgba(126,231,135,.85); filter: brightness(1.35); }
#xptip { position: absolute; bottom: 15px; left: 50%; transform: translateX(-50%); white-space: nowrap;
  background: rgba(10,16,32,.92); border: 1px solid rgba(255,255,255,.12); color: #cfe7d2;
  font-size: 11px; font-weight: 700; padding: 4px 11px; border-radius: 9px; opacity: 0;
  transition: opacity .15s; pointer-events: none; }
#xpwrap:hover #xptip { opacity: 1; }

/* hint footer */
#hint { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); white-space: nowrap;
  font-size: 11px; font-weight: 700; color: rgba(255,255,255,.5); pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,.8); letter-spacing: .3px; }

/* damage vignette */
#vig { position: absolute; inset: 0; pointer-events: none; opacity: 0; z-index: 25;
  background: radial-gradient(ellipse at center, rgba(255,40,40,0) 46%, rgba(255,26,26,.6) 100%); }

/* level-up banner */
#banner { position: absolute; top: 16%; left: 50%; transform: translateX(-50%); opacity: 0; z-index: 40;
  pointer-events: none; font-size: 30px; font-weight: 900; letter-spacing: 1.5px; padding: 11px 42px;
  border-radius: 999px; color: #5a3c00; background: linear-gradient(180deg, #ffeeab, #ffc94d);
  box-shadow: 0 0 36px rgba(255,202,80,.65), 0 10px 26px rgba(0,0,0,.35);
  text-shadow: 0 1px 0 rgba(255,255,255,.5); }
#banner.show { animation: bannerin 2.5s ease forwards; }
@keyframes bannerin {
  0% { opacity: 0; transform: translate(-50%, -30px) scale(.75); }
  12% { opacity: 1; transform: translate(-50%, 0) scale(1.07); }
  20% { transform: translate(-50%, 0) scale(1); }
  80% { opacity: 1; transform: translate(-50%, 0) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -16px) scale(.94); }
}

/* overlays (skill tree / help / death) */
.overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(4,8,18,.55); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  pointer-events: auto; z-index: 60; }
.opanel { position: relative; padding: 18px 24px 22px; max-height: 86vh; overflow-y: auto;
  scrollbar-width: thin; }
.oclose { position: absolute; top: 12px; right: 14px; width: 30px; height: 30px; border: none;
  border-radius: 50%; background: rgba(255,255,255,.1); color: #dfe7f5; font-size: 14px; font-weight: 900;
  cursor: pointer; transition: background .15s, transform .12s; }
.oclose:hover { background: rgba(255,120,120,.35); transform: scale(1.1); }
.otitle { font-size: 21px; font-weight: 900; color: #fff; text-align: center; margin-bottom: 4px;
  letter-spacing: .5px; }

/* skill tree */
#tree .opanel { width: min(910px, 93vw); }
#treepts { text-align: center; font-size: 13px; font-weight: 800; color: #7ee787; margin-bottom: 14px; }
#treecols { display: flex; gap: 14px; align-items: stretch; justify-content: center; }
.branch { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center;
  padding: 13px 8px 16px; border-radius: 16px; background: rgba(255,255,255,.035);
  border: 1px solid rgba(255,255,255,.05); }
.bhead { font-size: 13.5px; font-weight: 900; color: #0c1322; padding: 5px 17px; border-radius: 999px;
  background: var(--bc); margin-bottom: 12px; box-shadow: 0 0 14px -3px var(--bc); white-space: nowrap; }
.trow { display: flex; gap: 16px; justify-content: center; }
.nwrap { display: flex; flex-direction: column; align-items: center; width: 96px; }
.node { position: relative; width: 54px; height: 54px; border-radius: 50%; font-size: 22px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(16,24,44,.92); border: 3px solid rgba(255,255,255,.13);
  transition: transform .13s ease, box-shadow .13s ease, border-color .13s ease, filter .13s ease; }
.node.locked { filter: grayscale(.75) brightness(.55); }
.node.learned { border-color: var(--bc); }
.node.avail { border-color: var(--bc); cursor: pointer; box-shadow: 0 0 9px rgba(255,255,255,.07); }
.node.avail:hover { transform: translateY(-3px) scale(1.07); box-shadow: 0 0 18px var(--bc); }
.node.maxed { border-color: #ffd75e; background: rgba(44,38,16,.94);
  box-shadow: 0 0 15px rgba(255,215,94,.55); }
.node.pop { animation: nodepop .55s ease; }
@keyframes nodepop {
  0% { transform: scale(1.35); box-shadow: 0 0 28px var(--bc); }
  60% { transform: scale(.95); }
  100% { transform: scale(1); }
}
.pips { display: flex; gap: 3px; justify-content: center; margin-top: 5px; min-height: 6px; }
.pip { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.16); }
.pip.on { background: var(--bc); box-shadow: 0 0 5px var(--bc); }
.nlabel { font-size: 10.5px; font-weight: 700; color: rgba(255,255,255,.78); text-align: center;
  margin-top: 3px; line-height: 1.2; }
.conn { width: 4px; height: 20px; margin: 3px auto; border-radius: 2px; background: rgba(255,255,255,.1); }
.conn.lit { background: var(--bc); box-shadow: 0 0 7px var(--bc); }
#stip { position: fixed; display: none; max-width: 246px; padding: 11px 14px; z-index: 90;
  pointer-events: none; background: rgba(10,16,32,.96); border: 1px solid rgba(255,255,255,.14);
  border-radius: 13px; box-shadow: 0 10px 26px rgba(0,0,0,.5); }
#stip .tname { font-size: 13.5px; font-weight: 900; margin-bottom: 2px; }
#stip .trank { font-size: 11px; font-weight: 800; color: #ffd75e; margin-bottom: 5px; }
#stip .tdesc { font-size: 11.5px; color: #cdd7e6; line-height: 1.45; margin-bottom: 6px; }
#stip .tcost { font-size: 11px; font-weight: 800; }
#stip .treq { font-size: 11px; font-weight: 800; color: #ff8896; margin-top: 3px; }

/* help */
#help .opanel { width: min(440px, 92vw); }
.krow { display: flex; justify-content: space-between; gap: 26px; padding: 6px 2px;
  border-bottom: 1px solid rgba(255,255,255,.06); font-size: 12.5px; }
.krow:last-child { border-bottom: none; }
.kkey { font-weight: 900; color: #7ee787; white-space: nowrap; }
.kact { color: #dfe7f5; text-align: right; }

/* death screen */
#death { position: absolute; inset: 0; z-index: 70; pointer-events: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: radial-gradient(ellipse at center, rgba(70,8,22,.35), rgba(12,2,8,.82));
  animation: deathin .9s ease; }
@keyframes deathin { from { opacity: 0; } to { opacity: 1; } }
#death .dtitle { font-size: 38px; font-weight: 900; color: #ffd9e0;
  text-shadow: 0 4px 18px rgba(0,0,0,.7); animation: deathin 1.6s ease; }
#death .dsub { font-size: 13px; color: rgba(255,255,255,.6); margin-bottom: 8px; }
#respawn { border: none; cursor: pointer; padding: 14px 46px; border-radius: 999px; font-size: 18px;
  font-weight: 900; letter-spacing: 1px; color: #471018;
  background: linear-gradient(180deg, #ffa9b8, #f0607c);
  box-shadow: 0 6px 0 #b03551, 0 14px 26px rgba(0,0,0,.4); transition: transform .12s, box-shadow .12s; }
#respawn:hover { transform: translateY(-2px); }
#respawn:active { transform: translateY(3px); box-shadow: 0 2px 0 #b03551, 0 8px 16px rgba(0,0,0,.4); }
`;

// ---------------------------------------------------------------- state

let root = null;
let selectEl = null, hudEl = null, treeEl = null, helpEl = null, deathEl = null;
let bannerEl = null, vignetteEl = null, hintEl = null, badgeEl = null;
let bannerTimer = 0, xpGlowTimer = 0;

const frame = { blob: null, name: null, gold: null, lvl: null, hpFill: null, hpText: null, manaFill: null, manaText: null };
const xpUI = { fill: null, tip: null };
const hotbar = [];   // { ab, el, cdov, cdt, lock, mcEl, tipEl, lastQ, lastCd, lastTxt, lastLocked, lastLow, cdMax, flashTimer }
const minimap = { canvas: null, ctx: null, bmp: null, ready: false, onlineEl: null, lastOnline: -1 };
const chat = { box: null, log: null, input: null };
const pframes = { wrap: null, recs: [] }; // recs: { bot, el, fill, hpDisp, hq, lastLow }
const invite = { el: null, nameEl: null, lastName: '', visible: false };
const tree = { title: null, pts: null, cols: null };
const tip = { el: null, name: null, rank: null, desc: null, cost: null, req: null };

let selectedCharId = null;
let saveInfo = null;
let startedOnce = false;
let treeOpen = false, helpOpen = false;
let vigAlpha = 0;
let tMini = 0, tFade = 0, tSlow = 0, tInv = 0;

const disp = {
  hp: 0, mana: 0, hq: -1, mq: -1, hue: -1, htxt: '', mtxt: '',
  gold: -1, lvl: -1, xp: -1, xpNeeded: -1, badgeTxt: '',
};

// ---------------------------------------------------------------- tiny DOM helpers

function div(cls, parent, text) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  if (parent) parent.appendChild(d);
  return d;
}

function btn(id, parent, text) {
  const b = document.createElement('button');
  if (id) b.id = id;
  if (text !== undefined) b.textContent = text;
  if (parent) parent.appendChild(b);
  return b;
}

function cssColor(c, fallback = '#7ee787') {
  if (typeof c === 'number' && isFinite(c)) return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
  if (typeof c === 'string' && c.length) {
    if (c[0] === '#' || c.startsWith('rgb') || c.startsWith('hsl')) return c;
    const named = { green: '#7ee787', red: '#ff7066', blue: '#6fb7ff', purple: '#c39df6', gold: '#ffd75e' };
    return named[c.toLowerCase()] || c;
  }
  return fallback;
}

function makeBlob(parent, color, sizeW, sizeH, delay) {
  const b = div('cblob', parent);
  b.style.setProperty('--c', color);
  if (delay) b.style.setProperty('--d', delay);
  if (sizeW) { b.style.width = sizeW + 'px'; b.style.height = sizeH + 'px'; }
  div('beye l', b); div('beye r', b); div('bmouth', b);
  return b;
}

function safeCanLearn(id) {
  try { return canLearn(id) || { ok: false }; } catch (e) { return { ok: false }; }
}

function safeSound(name) {
  try { playSound(name); } catch (e) { /* audio is best-effort */ }
}

// ================================================================= initUI

export function initUI() {
  if (root) return;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.id = 'ui-root';
  document.body.appendChild(root);

  buildCharSelect();
  buildHUD();
  buildOverlays();
  wireEvents();
  wireKeys();
}

// ------------------------------------------------------------ char select

function buildCharSelect() {
  selectEl = div(null, root);
  selectEl.id = 'cs';

  // floating background blobs
  for (let i = 0; i < 7; i++) {
    const b = div('csblob', selectEl);
    const s = 60 + Math.random() * 180;
    b.style.width = s + 'px';
    b.style.height = s * (0.7 + Math.random() * 0.3) + 'px';
    b.style.left = Math.random() * 95 + '%';
    b.style.top = Math.random() * 90 + '%';
    b.style.animationDuration = (8 + Math.random() * 7).toFixed(1) + 's';
    b.style.animationDelay = (-Math.random() * 8).toFixed(1) + 's';
  }

  // bouncy title
  const title = div(null, selectEl);
  title.id = 'cs-title';
  const letters = 'SLIME REALMS';
  for (let i = 0; i < letters.length; i++) {
    const span = document.createElement('span');
    span.className = 'tl';
    span.textContent = letters[i] === ' ' ? ' ' : letters[i];
    span.style.animationDelay = (i * 0.07).toFixed(2) + 's';
    title.appendChild(span);
  }
  div(null, selectEl, 'a tiny slime MMO').id = 'cs-sub';

  // class cards
  const cards = div(null, selectEl);
  cards.id = 'cs-cards';
  const chars = Array.isArray(CHARACTERS) ? CHARACTERS : [];
  const cardEls = new Map();
  chars.forEach((c, i) => {
    const meta = CHAR_META[c.id] || {};
    const col = cssColor(c.color);
    const card = div('ccard', cards);
    card.style.setProperty('--c', col);
    const blob = makeBlob(card, col);
    blob.style.setProperty('--d', (i * 0.3).toFixed(1) + 's');
    div('cname', card, c.name || (c.id ? c.id.charAt(0).toUpperCase() + c.id.slice(1) : 'Slime'));
    div('ctag', card, c.tagline || c.flavor || c.desc || meta.tag || '');
    const ul = document.createElement('ul');
    ul.className = 'cbon';
    let bonuses = Array.isArray(c.bonuses) ? c.bonuses
      : Array.isArray(c.perks) ? c.perks
      : (meta.bonuses || []);
    for (const b of bonuses) {
      const li = document.createElement('li');
      li.textContent = String(b);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    card.addEventListener('click', () => {
      selectedCharId = c.id;
      for (const [, el] of cardEls) el.classList.remove('sel');
      card.classList.add('sel');
      safeSound('squish');
    });
    cardEls.set(c.id, card);
  });
  if (chars.length) {
    selectedCharId = chars[0].id;
    const first = cardEls.get(selectedCharId);
    if (first) first.classList.add('sel');
  }

  // name row
  const nrow = div(null, selectEl);
  nrow.id = 'cs-namerow';
  const label = document.createElement('label');
  label.textContent = 'Name your slime';
  label.htmlFor = 'cs-name';
  nrow.appendChild(label);
  const nameInput = document.createElement('input');
  nameInput.id = 'cs-name';
  nameInput.maxLength = 16;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.value = pick(RANDOM_NAMES);
  nrow.appendChild(nameInput);
  const dice = btn('cs-dice', nrow, '\u{1F3B2}');
  dice.title = 'Random name';
  dice.addEventListener('click', () => { nameInput.value = pick(RANDOM_NAMES); });

  // start + continue — starting fresh overwrites the single save slot, so a
  // returning player must click twice before their character is wiped
  const start = btn('cs-start', selectEl, 'START ADVENTURE');
  let wipeArmed = false, wipeTimer = 0;
  const startFresh = () => {
    if (saveInfo && saveInfo.name && !wipeArmed) {
      wipeArmed = true;
      start.textContent = `Overwrite ${saveInfo.name} (Lv ${saveInfo.level})? Click again`;
      start.style.background = '#ff8d7a';
      clearTimeout(wipeTimer);
      wipeTimer = setTimeout(() => {
        wipeArmed = false;
        start.textContent = 'START ADVENTURE';
        start.style.background = '';
      }, 3500);
      return;
    }
    clearTimeout(wipeTimer);
    startGame(false, nameInput);
  };
  start.addEventListener('click', startFresh);
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); startFresh(); }
  });

  try { saveInfo = hasSave(); } catch (e) { saveInfo = null; }
  if (saveInfo && saveInfo.name) {
    const cont = btn('cs-cont', selectEl, `Continue as ${saveInfo.name} (Lv ${saveInfo.level})`);
    cont.addEventListener('click', () => startGame(true, nameInput));
  }
}

function startGame(fromSave, nameInput) {
  if (startedOnce || G.started) return;
  let charId, name;
  if (fromSave && saveInfo) {
    charId = saveInfo.charId;
    name = saveInfo.name;
  } else {
    charId = selectedCharId || (Array.isArray(CHARACTERS) && CHARACTERS[0] ? CHARACTERS[0].id : 'verdant');
    name = (nameInput.value || '').trim().slice(0, 16) || pick(RANDOM_NAMES);
  }
  startedOnce = true;

  // main.js's listener runs synchronously here: progression/world/player/... all init.
  emit('game:start', { charId, name, fromSave: !!fromSave });

  selectEl.classList.add('gone');
  setTimeout(() => { selectEl.style.display = 'none'; }, 600);

  populateHUD();
  hudEl.classList.remove('hidden');
  safeSound('level');
  emit('chat', { from: '⚔ Realm', system: true, text: `Welcome to Slime Realms, ${(G.player && G.player.name) || name}! Press H for help.` });
  emit('chat', { from: '⚔ Realm', system: true, text: 'Wild Slimes in the meadow are your speed — the glowing corners are Lv 9+. King Gloop \u{1F451} waits up north…' });
}

// ------------------------------------------------------------------- HUD

function buildHUD() {
  hudEl = div('hidden', root);
  hudEl.id = 'hud';

  // --- player frame
  const pf = div('panel', hudEl);
  pf.id = 'pframe';
  const pwrap = div('pwrap', pf);
  frame.blob = makeBlob(pwrap, '#6fcf5f');
  frame.blob.id = 'pblob';
  frame.lvl = div(null, pwrap, '1');
  frame.lvl.id = 'plvl';
  const pcol = div(null, pf);
  const pnr = div(null, pcol);
  pnr.id = 'pnamerow';
  frame.name = div(null, pnr, '');
  frame.name.id = 'pname';
  frame.gold = div(null, pnr, '\u{1FA99} 0');
  frame.gold.id = 'pgold';
  const hpBar = div('bar', pcol);
  frame.hpFill = div('fill', hpBar);
  frame.hpText = div('btxt', hpBar, '');
  const manaBar = div('bar mana', pcol);
  frame.manaFill = div('fill', manaBar);
  frame.manaText = div('btxt', manaBar, '');

  // --- party member frames (rebuilt on 'party:changed')
  pframes.wrap = div(null, hudEl);
  pframes.wrap.id = 'pframes';

  // --- hotbar
  const hb = div(null, hudEl);
  hb.id = 'hotbar';
  const abilities = Array.isArray(ABILITIES) ? [...ABILITIES].sort((a, b) => (a.slot || 0) - (b.slot || 0)) : [];
  for (const ab of abilities) {
    const slot = div('slot', hb, ab.icon || '✨');
    div('key', slot, ab.keyLabel || String(ab.slot || ''));
    let mcEl = null;
    if (ab.mana > 0) mcEl = div('mc', slot, String(ab.mana));
    const cdov = div('cdov', slot);
    const cdt = div('cdt', slot);
    const lock = div('lock', slot, '\u{1F512}');
    const tipEl = div('tip', slot, ab.name || ab.id);
    hotbar.push({
      ab, el: slot, cdov, cdt, lock, mcEl, tipEl,
      lastQ: -1, lastCd: 0, lastTxt: '', lastLocked: null, lastLow: false, cdMax: 1, flashTimer: 0,
      cost: ab.mana || 0, lastCost: '',
    });
  }

  // --- invite prompt pill ("🤝 Press E — invite <name> to your party")
  invite.el = div(null, hudEl);
  invite.el.id = 'invpill';
  const span = (cls, text) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    invite.el.appendChild(s);
    return s;
  };
  span(null, '\u{1F91D} Press ');
  span('invkey', 'E');
  span(null, ' — invite ');
  invite.nameEl = span('invname', '');
  span(null, ' to your party');

  // --- skill point badge
  badgeEl = btn('spbadge', hudEl, '');
  badgeEl.classList.add('hidden');
  badgeEl.addEventListener('click', () => { if (G.started) openTree(); });

  // --- minimap
  const mmwrap = div(null, hudEl);
  mmwrap.id = 'mmwrap';
  const ring = div(null, mmwrap);
  ring.id = 'mmring';
  minimap.canvas = document.createElement('canvas');
  minimap.canvas.id = 'mmcanvas';
  minimap.canvas.width = MM_SIZE;
  minimap.canvas.height = MM_SIZE;
  ring.appendChild(minimap.canvas);
  minimap.ctx = minimap.canvas.getContext('2d');
  minimap.onlineEl = div(null, mmwrap, '\u{1F7E2} 1 online');
  minimap.onlineEl.id = 'mmonline';

  // --- chat
  chat.box = div(null, hudEl);
  chat.box.id = 'chat';
  chat.log = div(null, chat.box);
  chat.log.id = 'chatlog';
  chat.input = document.createElement('input');
  chat.input.id = 'chatin';
  chat.input.maxLength = 120;
  chat.input.autocomplete = 'off';
  chat.input.spellcheck = false;
  chat.input.placeholder = 'Press Enter to chat…';
  chat.box.appendChild(chat.input);
  chat.input.addEventListener('focus', () => { G.chatFocus = true; chat.box.classList.add('cfocus'); });
  chat.input.addEventListener('blur', () => { G.chatFocus = false; chat.box.classList.remove('cfocus'); });
  chat.input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = chat.input.value.trim().slice(0, 120);
      chat.input.value = '';
      if (text && G.player) emit('chat', { from: G.player.name, text, self: true });
      chat.input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      chat.input.value = '';
      chat.input.blur();
    }
  });

  // --- XP bar
  const xpwrap = div(null, hudEl);
  xpwrap.id = 'xpwrap';
  const xpbar = div(null, xpwrap);
  xpbar.id = 'xpbar';
  xpUI.fill = div(null, xpbar);
  xpUI.fill.id = 'xpfill';
  xpUI.tip = div(null, xpwrap, '0% to level 2');
  xpUI.tip.id = 'xptip';

  // --- hint footer
  hintEl = div(null, hudEl, 'WASD move · Space jump · LMB attack · E party · K skills · Enter chat · H help');
  hintEl.id = 'hint';
}

function populateHUD() {
  const p = G.player;
  if (!p) return;
  frame.name.textContent = p.name || 'Slime';
  frame.blob.style.setProperty('--c', cssColor(p.color));
  disp.hp = p.hp;
  disp.mana = p.mana;
  refreshLocks();
  refreshBadge();
  refreshOnline();
}

// --------------------------------------------------------------- overlays

function buildOverlays() {
  // damage vignette
  vignetteEl = div(null, root);
  vignetteEl.id = 'vig';

  // level-up banner
  bannerEl = div(null, root, '');
  bannerEl.id = 'banner';

  // skill tree
  treeEl = div('overlay hidden', root);
  treeEl.id = 'tree';
  const tpanel = div('panel opanel', treeEl);
  const tclose = btn(null, tpanel, '✕');
  tclose.className = 'oclose';
  tclose.addEventListener('click', closeTree);
  tree.title = div('otitle', tpanel, 'Upgrade Tree');
  tree.pts = div(null, tpanel, '');
  tree.pts.id = 'treepts';
  tree.cols = div(null, tpanel);
  tree.cols.id = 'treecols';
  treeEl.addEventListener('mousedown', (e) => { if (e.target === treeEl) closeTree(); });

  // skill tooltip
  tip.el = div(null, root);
  tip.el.id = 'stip';
  tip.name = div('tname', tip.el, '');
  tip.rank = div('trank', tip.el, '');
  tip.desc = div('tdesc', tip.el, '');
  tip.cost = div('tcost', tip.el, '');
  tip.req = div('treq', tip.el, '');

  // help
  helpEl = div('overlay hidden', root);
  helpEl.id = 'help';
  const hpanel = div('panel opanel', helpEl);
  const hclose = btn(null, hpanel, '✕');
  hclose.className = 'oclose';
  hclose.addEventListener('click', closeHelp);
  div('otitle', hpanel, '\u{1F4D6} How to Slime');
  for (const [key, act] of HELP_ROWS) {
    const row = div('krow', hpanel);
    div('kkey', row, key);
    div('kact', row, act);
  }
  const ztitle = div('otitle', hpanel, '\u{1F5FA}\u{FE0F} Where to go');
  ztitle.style.marginTop = '14px';
  for (const [zone, desc] of ZONE_ROWS) {
    const row = div('krow', hpanel);
    div('kkey', row, zone);
    div('kact', row, desc);
  }
  helpEl.addEventListener('mousedown', (e) => { if (e.target === helpEl) closeHelp(); });

  // death screen
  deathEl = div('hidden', root);
  deathEl.id = 'death';
  div('dtitle', deathEl, 'You dissolved… \u{1F4A7}');
  div('dsub', deathEl, 'Even the squishiest heroes bounce back.');
  const respawn = btn('respawn', deathEl, 'RESPAWN');
  respawn.addEventListener('click', () => {
    deathEl.classList.add('hidden');
    emit('player:respawn', {});
  });
}

// ------------------------------------------------------------- event wiring

function wireEvents() {
  on('chat', addChatLine);

  on('player:damaged', (d) => {
    if (!G.started) return;
    const amt = (d && d.amount) || 5;
    vigAlpha = Math.min(0.75, 0.32 + amt * 0.014);
  });

  on('player:died', () => {
    if (!G.started) return;
    closeTree();
    closeHelp();
    if (chat.input) chat.input.blur();
    hideInvitePill();
    deathEl.classList.remove('hidden');
  });

  on('party:changed', rebuildPartyFrames);
  on('ally:downed', (d) => togglePartyKO(d && d.bot, true));
  on('ally:up', (d) => togglePartyKO(d && d.bot, false));

  on('player:respawn', () => {
    deathEl.classList.add('hidden');
    closeTree();
    closeHelp();
    vigAlpha = 0;
    vignetteEl.style.opacity = '0';
  });

  on('player:levelup', (d) => {
    if (!G.started) return;
    // no golden fanfare over the death screen (party kills grant XP while dead)
    if (!(G.player && G.player.dead)) showBanner((d && d.level) || (G.player && G.player.level) || 1);
    refreshBadge();
    if (treeOpen) renderTree();
  });

  on('stats:changed', () => {
    refreshLocks();
    refreshBadge();
    if (treeOpen) renderTree();
  });

  on('skill:learned', () => {
    refreshLocks();
    refreshBadge();
    if (treeOpen) renderTree();
  });

  on('xp:gained', () => {
    if (!xpUI.fill) return;
    xpUI.fill.classList.add('glow');
    clearTimeout(xpGlowTimer);
    xpGlowTimer = setTimeout(() => xpUI.fill.classList.remove('glow'), 650);
  });
}

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // inputs handle their own keys
    if (!G.started) return;
    if (G.player && G.player.dead) return; // death screen owns the keyboard — panels would open beneath it
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!treeOpen && !helpOpen) {
        e.preventDefault();
        chat.input.focus();
      }
    } else if (e.code === 'KeyK') {
      if (treeOpen) closeTree(); else { closeHelp(); openTree(); }
    } else if (e.code === 'KeyH') {
      if (helpOpen) closeHelp(); else { closeTree(); openHelp(); }
    } else if (e.code === 'Escape') {
      if (treeOpen) closeTree();
      else if (helpOpen) closeHelp();
    }
  });
}

// ------------------------------------------------------------------- chat

function addChatLine(msg) {
  if (!chat.log || !msg) return;
  const line = document.createElement('div');
  line.className = msg.system ? 'cline sys' : 'cline';
  const from = document.createElement('span');
  from.className = 'cfrom';
  from.textContent = (msg.from == null ? '???' : String(msg.from)) + ': ';
  let col = '#cfd8ea';
  if (msg.system) col = '#9aa7bd';
  else if (msg.self) col = '#7ee787';
  else if (msg.color !== undefined && msg.color !== null) col = cssColor(msg.color, '#7ec8ff');
  from.style.color = col;
  line.appendChild(from);
  line.appendChild(document.createTextNode(msg.text == null ? '' : String(msg.text)));
  line._t = G.time;
  line._dim = false;
  chat.log.appendChild(line);
  while (chat.log.children.length > CHAT_MAX) chat.log.removeChild(chat.log.firstChild);
  chat.log.scrollTop = chat.log.scrollHeight;
}

function fadeChatLines() {
  const kids = chat.log.children;
  for (let i = 0; i < kids.length; i++) {
    const line = kids[i];
    if (!line._dim && G.time - line._t > CHAT_FADE_AFTER) {
      line._dim = true;
      line.classList.add('dim');
    }
  }
}

// ------------------------------------------------------------ party frames

function rebuildPartyFrames() {
  if (!pframes.wrap) return;
  pframes.wrap.textContent = '';
  pframes.recs.length = 0;
  const list = Array.isArray(G.party) ? G.party : [];
  for (let i = 0; i < list.length; i++) {
    const bot = list[i];
    if (!bot) continue;
    const fr = div('panel pmframe', pframes.wrap);
    if (bot.downed) fr.classList.add('ko');
    const blob = makeBlob(fr, cssColor(bot.color, '#7ec8ff'), 36, 28);
    blob.style.setProperty('--d', (i * 0.35).toFixed(2) + 's');
    const info = div('pminfo', fr);
    const nrow = div('pmnamerow', info);
    div('pmname', nrow, String(bot.name || 'Slime'));
    div('pmlvl', nrow, 'Lv ' + (bot.level || 1));
    const hpb = div('pmhp', info);
    const fill = div('fill', hpb);
    const x = btn(null, fr, '✕');
    x.className = 'pmx';
    x.title = 'Remove from party';
    x.addEventListener('click', () => {
      try { removeFromParty(bot); } catch (e) { /* party.js owns membership */ }
    });
    div('pmko', fr, 'KO');
    const maxHp = Math.max(1, bot.maxHp || 1);
    pframes.recs.push({
      bot, el: fr, fill,
      hpDisp: clamp(typeof bot.hp === 'number' ? bot.hp : maxHp, 0, maxHp),
      hq: -1, lastLow: false,
    });
  }
}

function togglePartyKO(bot, down) {
  if (!bot) return;
  const recs = pframes.recs;
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].bot === bot) {
      recs[i].el.classList.toggle('ko', !!down);
      return;
    }
  }
}

function updatePartyBars(dt) {
  const recs = pframes.recs;
  if (!recs.length) return;
  const k = Math.min(1, dt * 11);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const bot = rec.bot;
    const maxHp = Math.max(1, bot.maxHp || 1);
    const hp = clamp(typeof bot.hp === 'number' ? bot.hp : maxHp, 0, maxHp);
    rec.hpDisp += (hp - rec.hpDisp) * k;
    if (Math.abs(hp - rec.hpDisp) < 0.25) rec.hpDisp = hp;
    const f = clamp(rec.hpDisp / maxHp, 0, 1);
    const q = Math.round(f * 200);
    if (q !== rec.hq) {
      rec.hq = q;
      rec.fill.style.width = (q / 2) + '%';
      const low = f < 0.3;
      if (low !== rec.lastLow) {
        rec.lastLow = low;
        rec.fill.classList.toggle('low', low);
      }
    }
  }
}

// ------------------------------------------------------------ invite prompt

function hideInvitePill() {
  if (!invite.visible) return;
  invite.visible = false;
  if (invite.el) invite.el.classList.remove('show');
}

function refreshInvitePill(p) {
  if (!invite.el) return;
  let target = null;
  const full = Array.isArray(G.party) && G.party.length >= 3;
  if (G.started && !p.dead && !full) {
    try { target = getInviteTarget(); } catch (e) { target = null; }
  }
  if (target) {
    const nm = String(target.name || 'slime');
    if (nm !== invite.lastName) {
      invite.lastName = nm;
      invite.nameEl.textContent = nm;
    }
    if (!invite.visible) {
      invite.visible = true;
      invite.el.classList.add('show');
    }
  } else {
    hideInvitePill();
  }
}

// --------------------------------------------------------------- skill tree

function openTree() {
  if (!G.started || !G.player || treeOpen) return;
  treeOpen = true;
  treeEl.classList.remove('hidden');
  renderTree();
  syncPause();
}

function closeTree() {
  if (!treeOpen) return;
  treeOpen = false;
  treeEl.classList.add('hidden');
  hideTip();
  syncPause();
}

function openHelp() {
  if (!G.started || helpOpen) return;
  helpOpen = true;
  helpEl.classList.remove('hidden');
  syncPause();
}

function closeHelp() {
  if (!helpOpen) return;
  helpOpen = false;
  helpEl.classList.add('hidden');
  syncPause();
}

function syncPause() {
  G.paused = treeOpen || helpOpen;
}

function renderTree() {
  const p = G.player;
  if (!p) return;
  const n = p.skillPoints || 0;
  tree.title.textContent = `Upgrade Tree — ${n} point${n === 1 ? '' : 's'}`;
  tree.pts.textContent = n > 0
    ? 'Click a glowing node to spend a point'
    : 'Slay slimes to earn more skill points';
  tree.cols.textContent = '';

  const branches = (SKILL_TREE && Array.isArray(SKILL_TREE.branches)) ? SKILL_TREE.branches : [];
  branches.forEach((br, bi) => {
    const fb = BRANCH_FALLBACK[bi % BRANCH_FALLBACK.length];
    const bc = cssColor(br.color, fb.color);
    const col = div('branch', tree.cols);
    col.style.setProperty('--bc', bc);
    div('bhead', col, `${br.icon || fb.icon} ${br.name || fb.name}`);

    const nodes = Array.isArray(br.nodes) ? br.nodes : (Array.isArray(br.skills) ? br.skills : []);
    const tiers = new Map();
    for (const node of nodes) {
      const t = node.tier || 1;
      if (!tiers.has(t)) tiers.set(t, []);
      tiers.get(t).push(node);
    }
    const order = [...tiers.keys()].sort((a, b) => a - b);
    let prevLearned = false;
    let first = true;
    for (const tk of order) {
      if (!first) {
        const conn = div('conn', col);
        if (prevLearned) conn.classList.add('lit');
      }
      first = false;
      const trow = div('trow', col);
      let anyLearned = false;
      for (const node of tiers.get(tk)) {
        let rank = 0;
        try { rank = getRank(node.id) || 0; } catch (e) { rank = 0; }
        if (rank > 0) anyLearned = true;
        buildNode(trow, node, rank, bc);
      }
      prevLearned = anyLearned;
    }
  });
}

function buildNode(parent, node, rank, bc) {
  const wrap = div('nwrap', parent);
  const el = div('node', wrap, node.icon || '✦');
  el.dataset.node = node.id;
  el.style.setProperty('--bc', bc);
  const maxRank = node.maxRank || 1;
  const learn = safeCanLearn(node.id);
  if (rank >= maxRank) el.classList.add('maxed');
  else if (learn.ok) el.classList.add('avail');
  else el.classList.add('locked');
  if (rank > 0) el.classList.add('learned');

  const pips = div('pips', wrap);
  for (let i = 0; i < maxRank; i++) {
    const pip = div('pip', pips);
    if (i < rank) pip.classList.add('on');
  }
  div('nlabel', wrap, node.name || node.id);

  el.addEventListener('mouseenter', () => showTip(el, node, bc));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', () => {
    const check = safeCanLearn(node.id);
    if (!check.ok) return;
    let learned = false;
    try { learned = !!learnSkill(node.id); } catch (e) { learned = false; }
    if (!learned) return;
    safeSound('learn');
    // skill:learned already triggered a re-render; flash the fresh node + refresh tooltip
    const id = (window.CSS && CSS.escape) ? CSS.escape(String(node.id)) : String(node.id);
    const fresh = tree.cols.querySelector(`[data-node="${id}"]`);
    if (fresh) {
      fresh.classList.add('pop');
      showTip(fresh, node, bc);
    }
  });
}

function showTip(nodeEl, node, bc) {
  if (!tip.el) return;
  tip.name.textContent = `${node.icon || ''} ${node.name || node.id}`.trim();
  tip.name.style.color = bc;
  let rank = 0;
  try { rank = getRank(node.id) || 0; } catch (e) { rank = 0; }
  const maxRank = node.maxRank || 1;
  tip.rank.textContent = `Rank ${rank} / ${maxRank}`;
  tip.desc.textContent = node.desc || '';
  if (rank >= maxRank) {
    tip.cost.textContent = 'Fully mastered ✨';
    tip.cost.style.color = '#ffd75e';
    tip.req.style.display = 'none';
  } else {
    tip.cost.textContent = 'Cost: 1 skill point';
    const check = safeCanLearn(node.id);
    tip.cost.style.color = check.ok ? '#7ee787' : '#aab4c8';
    if (!check.ok && check.reason) {
      tip.req.style.display = '';
      tip.req.textContent = check.reason;
    } else {
      tip.req.style.display = 'none';
    }
  }
  tip.el.style.display = 'block';
  const r = nodeEl.getBoundingClientRect();
  const tw = tip.el.offsetWidth;
  const th = tip.el.offsetHeight;
  let x = r.right + 12;
  if (x + tw > window.innerWidth - 8) x = r.left - tw - 12;
  x = clamp(x, 8, window.innerWidth - tw - 8);
  const y = clamp(r.top - 6, 8, window.innerHeight - th - 8);
  tip.el.style.left = x + 'px';
  tip.el.style.top = y + 'px';
}

function hideTip() {
  if (tip.el) tip.el.style.display = 'none';
}

// ----------------------------------------------------------------- banner

function showBanner(level) {
  bannerEl.textContent = `✨ LEVEL ${level}! ✨`;
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth; // restart the CSS animation
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- minimap

function heightRGB(h, out) {
  if (h < WATER_LEVEL - 1.4) { out[0] = 44; out[1] = 100; out[2] = 172; }       // deep water
  else if (h < WATER_LEVEL) { out[0] = 62; out[1] = 138; out[2] = 204; }        // shallows
  else if (h < WATER_LEVEL + 0.7) { out[0] = 229; out[1] = 212; out[2] = 152; } // sand
  else if (h < 9) {                                                             // greens by height
    const t = clamp((h - (WATER_LEVEL + 0.7)) / (9 - WATER_LEVEL - 0.7), 0, 1);
    out[0] = (126 + (74 - 126) * t) | 0;
    out[1] = (201 + (138 - 201) * t) | 0;
    out[2] = (110 + (82 - 110) * t) | 0;
  } else if (h < 11.8) { out[0] = 138; out[1] = 145; out[2] = 156; }            // stone
  else { out[0] = 204; out[1] = 209; out[2] = 218; }                            // high stone
}

function buildMinimapBitmap() {
  const bmp = document.createElement('canvas');
  bmp.width = MM_RES;
  bmp.height = MM_RES;
  const bctx = bmp.getContext('2d');
  const img = bctx.createImageData(MM_RES, MM_RES);
  const data = img.data;
  const rgb = [0, 0, 0];
  let k = 0;
  for (let j = 0; j < MM_RES; j++) {
    const z = (j / (MM_RES - 1)) * HALF * 2 - HALF;
    for (let i = 0; i < MM_RES; i++) {
      const x = (i / (MM_RES - 1)) * HALF * 2 - HALF;
      let h = 0;
      try { h = terrainHeight(x, z); } catch (e) { h = 2; }
      heightRGB(h, rgb);
      data[k++] = rgb[0];
      data[k++] = rgb[1];
      data[k++] = rgb[2];
      data[k++] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
  minimap.bmp = bmp;
  minimap.ctx.imageSmoothingEnabled = false;
  minimap.ready = true;
}

function isBoss(e) {
  return /king|boss/i.test(String(e.type || '')) || /king gloop/i.test(String(e.name || ''));
}

function drawMinimap(p) {
  if (!minimap.ready) buildMinimapBitmap();
  const ctx = minimap.ctx;
  const S = MM_SIZE;
  const scale = S / (HALF * 2);
  ctx.drawImage(minimap.bmp, 0, 0, S, S);

  // enemy dots (red) + boss star (gold)
  let bossX = null, bossZ = null;
  ctx.fillStyle = '#ff5a52';
  const enemies = G.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || e.dead || !e.group) continue;
    const ex = (e.group.position.x + HALF) * scale;
    const ez = (e.group.position.z + HALF) * scale;
    if (isBoss(e)) { bossX = ex; bossZ = ez; continue; }
    ctx.fillRect(ex - 1.5, ez - 1.5, 3, 3);
  }
  if (bossX !== null) {
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', bossX, bossZ);
  }

  // bot dots (bot blue); party members drawn after, brighter green + bigger so the team stands out
  ctx.fillStyle = '#7ec8ff';
  const bots = G.bots;
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    if (!b || !b.group || b.party) continue;
    const bx = (b.group.position.x + HALF) * scale;
    const bz = (b.group.position.z + HALF) * scale;
    ctx.fillRect(bx - 1.5, bz - 1.5, 3, 3);
  }
  ctx.fillStyle = '#7ee787';
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    if (!b || !b.group || !b.party) continue;
    const bx = (b.group.position.x + HALF) * scale;
    const bz = (b.group.position.z + HALF) * scale;
    ctx.fillRect(bx - 2, bz - 2, 4, 4);
  }

  // player arrow (white, rotated to facing; facing 0 = +z = map-down)
  if (p.group) {
    const px = (p.group.position.x + HALF) * scale;
    const pz = (p.group.position.z + HALF) * scale;
    const f = p.facing || 0;
    const rot = Math.atan2(Math.sin(f), -Math.cos(f));
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(rot);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(4, 4.5);
    ctx.lineTo(0, 2.2);
    ctx.lineTo(-4, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function refreshOnline() {
  const n = (G.bots ? G.bots.length : 0) + 1;
  if (n !== minimap.lastOnline) {
    minimap.lastOnline = n;
    minimap.onlineEl.textContent = `\u{1F7E2} ${n} online`;
  }
}

// ------------------------------------------------------------ HUD refresh

function refreshLocks() {
  const p = G.player;
  for (const rec of hotbar) {
    let unlocked = true;
    try { unlocked = typeof rec.ab.unlocked === 'function' ? !!rec.ab.unlocked() : true; } catch (e) { unlocked = true; }
    if (unlocked !== rec.lastLocked) {
      rec.lastLocked = unlocked;
      rec.el.classList.toggle('locked', !unlocked);
      rec.tipEl.textContent = unlocked
        ? `${rec.ab.name || rec.ab.id}${rec.ab.mana > 0 ? ` · ${Math.round(rec.cost || rec.ab.mana)} mana` : ''}`
        : 'Unlock in the skill tree (K)';
    }
    try { rec.cdMax = Math.max(0.01, typeof rec.ab.cdMax === 'function' ? rec.ab.cdMax() : (rec.ab.cdMax || 1)); }
    catch (e) { rec.cdMax = 1; }
    if (rec.mcEl && p) {
      // effective cost mirrors combat.js: ab.mana * stats.manaCost (Echo discount)
      rec.cost = rec.ab.mana * ((p.stats && p.stats.manaCost) || 1);
      const costTxt = String(Math.round(rec.cost));
      if (costTxt !== rec.lastCost) {
        rec.lastCost = costTxt;
        rec.mcEl.textContent = costTxt;
        if (unlocked) {
          rec.tipEl.textContent = `${rec.ab.name || rec.ab.id} · ${costTxt} mana`;
        }
      }
      const low = p.mana < rec.cost - 1e-4;
      if (low !== rec.lastLow) {
        rec.lastLow = low;
        rec.mcEl.classList.toggle('low', low);
      }
    }
  }
}

function refreshBadge() {
  const p = G.player;
  if (!p || !badgeEl) return;
  const sp = p.skillPoints || 0;
  if (sp > 0) {
    const txt = `K · ${sp} skill point${sp === 1 ? '' : 's'}!`;
    if (txt !== disp.badgeTxt) {
      disp.badgeTxt = txt;
      badgeEl.textContent = txt;
    }
    badgeEl.classList.remove('hidden');
  } else if (disp.badgeTxt !== '') {
    disp.badgeTxt = '';
    badgeEl.classList.add('hidden');
  }
}

function updateBars(dt, p) {
  const stats = p.stats || {};
  const maxHp = Math.max(1, stats.maxHp || 100);
  const maxMana = Math.max(1, stats.maxMana || 40);
  const k = Math.min(1, dt * 11);

  // HP (smooth lerp; width/color/text only updated on change)
  disp.hp += (p.hp - disp.hp) * k;
  if (Math.abs(p.hp - disp.hp) < 0.25) disp.hp = p.hp;
  const hf = clamp(disp.hp / maxHp, 0, 1);
  const hq = Math.round(hf * 500);
  if (hq !== disp.hq) {
    disp.hq = hq;
    frame.hpFill.style.width = (hq / 5) + '%';
    const hue = Math.round(115 * hf);
    if (hue !== disp.hue) {
      disp.hue = hue;
      frame.hpFill.style.background = `linear-gradient(180deg, hsl(${hue},72%,56%), hsl(${hue},68%,42%))`;
    }
  }
  const htxt = `${Math.max(0, Math.round(p.hp))} / ${Math.round(maxHp)}`;
  if (htxt !== disp.htxt) { disp.htxt = htxt; frame.hpText.textContent = htxt; }

  // Mana
  disp.mana += (p.mana - disp.mana) * k;
  if (Math.abs(p.mana - disp.mana) < 0.25) disp.mana = p.mana;
  const mf = clamp(disp.mana / maxMana, 0, 1);
  const mq = Math.round(mf * 500);
  if (mq !== disp.mq) { disp.mq = mq; frame.manaFill.style.width = (mq / 5) + '%'; }
  const mtxt = `${Math.max(0, Math.round(p.mana))} / ${Math.round(maxMana)}`;
  if (mtxt !== disp.mtxt) { disp.mtxt = mtxt; frame.manaText.textContent = mtxt; }

  // gold / level
  const gold = Math.round(p.gold || 0);
  if (gold !== disp.gold) { disp.gold = gold; frame.gold.textContent = `\u{1FA99} ${gold}`; }
  if (p.level !== disp.lvl) { disp.lvl = p.level; frame.lvl.textContent = String(p.level); }

  // XP
  if (p.xp !== disp.xp || p.xpNeeded !== disp.xpNeeded) {
    disp.xp = p.xp;
    disp.xpNeeded = p.xpNeeded;
    const f = clamp(p.xp / Math.max(1, p.xpNeeded), 0, 1);
    xpUI.fill.style.width = (f * 100).toFixed(2) + '%';
    xpUI.tip.textContent = `${Math.floor(f * 100)}% to level ${p.level + 1}`;
  }
}

function updateCooldowns() {
  for (const rec of hotbar) {
    let cd = 0;
    try { cd = getCooldown(rec.ab.id) || 0; } catch (e) { cd = 0; }

    // press flash: the cooldown jumped up since last frame
    if (cd > rec.lastCd + 0.2) {
      rec.el.classList.remove('flash');
      void rec.el.offsetWidth;
      rec.el.classList.add('flash');
      clearTimeout(rec.flashTimer);
      rec.flashTimer = setTimeout(() => rec.el.classList.remove('flash'), 320);
    }
    rec.lastCd = cd;

    if (cd > 0.01) {
      const frac = clamp(cd / rec.cdMax, 0, 1);
      const q = Math.ceil(frac * 60);
      if (q !== rec.lastQ) {
        rec.lastQ = q;
        const pct = (q / 60) * 100;
        rec.cdov.style.display = 'block';
        rec.cdov.style.background = `conic-gradient(rgba(6,10,22,.82) ${pct}%, rgba(6,10,22,0) ${pct}% 100%)`;
      }
      const txt = cd >= 3 ? String(Math.ceil(cd)) : cd.toFixed(1);
      if (txt !== rec.lastTxt) {
        rec.lastTxt = txt;
        rec.cdt.textContent = txt;
        rec.cdt.style.display = 'flex';
      }
    } else if (rec.lastQ !== -1) {
      rec.lastQ = -1;
      rec.lastTxt = '';
      rec.cdov.style.display = 'none';
      rec.cdt.style.display = 'none';
    }
  }
}

// ================================================================ updateUI

export function updateUI(dt) {
  if (!root) return;
  if (!G.started) return; // before the game begins, only the (CSS-animated) char select is live
  const p = G.player;
  if (!p) return;

  // damage vignette decay
  if (vigAlpha > 0) {
    vigAlpha = Math.max(0, vigAlpha - dt * 1.5);
    vignetteEl.style.opacity = vigAlpha < 0.004 ? '0' : vigAlpha.toFixed(3);
  }

  updateBars(dt, p);
  updatePartyBars(dt);
  updateCooldowns();

  tInv += dt;
  if (tInv >= 0.2) { // ~5 Hz invite-target poll
    tInv = 0;
    refreshInvitePill(p);
  }

  tMini += dt;
  if (tMini >= 0.1) { // ~10 Hz minimap
    tMini = 0;
    drawMinimap(p);
  }

  tFade += dt;
  if (tFade >= 0.25) { // ~4 Hz chat fade + mana affordability tint
    tFade = 0;
    fadeChatLines();
    for (const rec of hotbar) {
      if (!rec.mcEl) continue;
      const low = p.mana < rec.cost - 1e-4;
      if (low !== rec.lastLow) {
        rec.lastLow = low;
        rec.mcEl.classList.toggle('low', low);
      }
    }
  }

  tSlow += dt;
  if (tSlow >= 0.5) { // ~2 Hz slow refresh
    tSlow = 0;
    refreshLocks();
    refreshBadge();
    refreshOnline();
  }
}
