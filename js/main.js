// main.js — boot, raw input capture, game loop. Wires all modules together.
import * as THREE from 'three';
import { G, on } from './core.js';
import { initUI, updateUI } from './ui.js';
import { initWorld, updateWorld } from './world.js';
import { initProgression } from './progression.js';
import { initPlayer, updatePlayer } from './player.js';
import { initCombat, updateCombat } from './combat.js';
import { initEnemies, updateEnemies } from './enemies.js';
import { initBots, updateBots } from './bots.js';
import { initParty, updateParty } from './party.js';
import { initNPCs, updateNPCs } from './npcs.js';

boot();

function boot() {
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fd9f6);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 700);
  camera.position.set(0, 12, 18);
  camera.lookAt(0, 2, 0);

  Object.assign(G, { canvas, renderer, scene, camera });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- raw input -> G; gameplay modules consume via G (see CONTRACT.md) ----
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!G.keys[e.code]) G.keysPressed[e.code] = true;
    G.keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { G.keys[e.code] = false; });
  window.addEventListener('blur', () => { G.keys = {}; G.mouse.down = false; G.mouse.rdown = false; });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { G.mouse.down = true; G.mouse.clicked = true; }
    if (e.button === 2) { G.mouse.rdown = true; G.mouse.rclicked = true; }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) G.mouse.down = false;
    if (e.button === 2) G.mouse.rdown = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (G.mouse.down || G.mouse.rdown) { G.mouse.mx += e.movementX; G.mouse.my += e.movementY; }
  });
  canvas.addEventListener('wheel', (e) => { G.mouse.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  initUI(); // shows the character-select screen; emits 'game:start' when the player picks a slime

  on('game:start', ({ charId, name, fromSave }) => {
    if (G.started) return;
    initProgression(charId, name, fromSave);
    initWorld();
    initPlayer();
    initCombat();
    initEnemies();
    initBots();
    initParty();
    initNPCs();
    G.started = true;
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    G.time += dt;
    if (G.started && !G.paused) {
      updatePlayer(dt);
      updateParty(dt);   // before enemies so ally targets/attacks land this frame
      updateEnemies(dt);
      updateBots(dt);
      updateNPCs(dt);
      updateCombat(dt);
      updateWorld(dt);
    }
    updateUI(dt);
    renderer.render(scene, camera);
    G.keysPressed = {};
    G.mouse.clicked = false;
    G.mouse.rclicked = false;
  });
}
