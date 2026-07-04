// slime.js — shared slime character factory.
// Exports: createSlime, animateSlime, makeNameTag, makeHpBar (see CONTRACT.md).
// Used by player.js, enemies.js and bots.js. Geometries and materials are cached
// module-wide; only color-dependent materials are created per unique color.
import * as THREE from 'three';
import { clamp } from './core.js';

// ---------------------------------------------------------------------------
// shared caches (lazy — module stays side-effect free at import time)
// ---------------------------------------------------------------------------

let _geo = null;
function geos() {
  if (_geo) return _geo;
  _geo = {
    // chunky low-poly sphere; flat shading gives the faceted jelly look
    body: new THREE.SphereGeometry(1, 12, 9),
    // cheaper sphere for eyes / specks / gloss blob
    small: new THREE.SphereGeometry(1, 8, 6),
    // open torus arc, rotated into a smile in createSlime
    mouth: new THREE.TorusGeometry(0.14, 0.032, 5, 10, Math.PI * 0.85),
  };
  return _geo;
}

const _bodyMats = new Map(); // color -> translucent outer gel material
const _coreMats = new Map(); // color -> darker solid inner-core material
let _faceMats = null;

function faceMats() {
  if (_faceMats) return _faceMats;
  _faceMats = {
    dark: new THREE.MeshBasicMaterial({ color: 0x191722 }),
    speck: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    gloss: new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  };
  return _faceMats;
}

function bodyMat(color) {
  let m = _bodyMats.get(color);
  if (!m) {
    m = new THREE.MeshPhongMaterial({
      color,
      flatShading: true,
      transparent: true,
      opacity: 0.92,
      shininess: 70,
      specular: 0x556677,
    });
    _bodyMats.set(color, m);
  }
  return m;
}

function coreMat(color) {
  let m = _coreMats.get(color);
  if (!m) {
    const c = new THREE.Color(color).multiplyScalar(0.55);
    m = new THREE.MeshPhongMaterial({
      color: c,
      flatShading: true,
      shininess: 24,
      specular: 0x222a33,
    });
    _coreMats.set(color, m);
  }
  return m;
}

// rounded-rect path helper for the canvas sprites
function pill(ctx, x, y, w, h, r) {
  w = Math.max(w, 0.001);
  h = Math.max(h, 0.001);
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = "'Trebuchet MS','Comic Sans MS','Segoe UI',sans-serif";

// ---------------------------------------------------------------------------
// createSlime — a cute gel blob. Group origin is at the slime's BOTTOM so the
// squash & stretch in animateSlime (group.scale) stays anchored to the ground.
// Faces +z; callers rotate the group for facing and own .position entirely.
// ---------------------------------------------------------------------------

export function createSlime({ color = 0x6fcf5f, size = 1 } = {}) {
  const g = geos();
  const fm = faceMats();
  const group = new THREE.Group();

  // outer translucent body — flattened sphere (y ~0.78 of width)
  const body = new THREE.Mesh(g.body, bodyMat(color));
  body.scale.set(0.8, 0.624, 0.8);
  body.position.y = 0.624;
  body.castShadow = true;
  group.add(body);

  // darker solid inner core (~60% size, sits a touch low) for the gel feel
  const core = new THREE.Mesh(g.body, coreMat(color));
  core.scale.set(0.48, 0.37, 0.48);
  core.position.y = 0.55;
  group.add(core);

  // eyes: black ovals poking just out of the gel, with white highlight specks
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? -1 : 1;
    const eye = new THREE.Mesh(g.small, fm.dark);
    eye.scale.set(0.085, 0.13, 0.05);
    eye.position.set(0.27 * sx, 0.81, 0.73);
    group.add(eye);

    const speck = new THREE.Mesh(g.small, fm.speck);
    speck.scale.setScalar(0.034);
    speck.position.set(0.27 * sx + 0.032, 0.855, 0.77);
    group.add(speck);
  }

  // tiny dark smile — torus arc rotated so the open span faces upward
  const mouth = new THREE.Mesh(g.mouth, fm.dark);
  mouth.position.set(0, 0.6, 0.78);
  mouth.rotation.z = Math.PI * 1.075;
  group.add(mouth);

  // glossy white highlight blob on the upper-left of the dome
  const shine = new THREE.Mesh(g.small, fm.gloss);
  shine.scale.set(0.28, 0.13, 0.1);
  shine.position.set(-0.3, 1.0, 0.46);
  shine.rotation.set(-0.5, 0, 0.32);
  group.add(shine);

  // face/core never move relative to the group — freeze their local matrices
  for (const child of group.children) {
    if (child !== body) {
      child.updateMatrix();
      child.matrixAutoUpdate = false;
    }
  }

  group.scale.setScalar(size);

  group.userData = {
    isSlime: true,
    color,
    baseScale: size,
    height: 1.3 * size, // handy anchor for name tags / hp bars above the head
    phase: Math.random() * Math.PI * 2, // desync wobble between slimes
    squash: 0, // landing impulse, decays
    sx: 1,
    sy: 1, // smoothed scale factors
    wasGrounded: true,
    body,
    core,
  };
  return group;
}

// ---------------------------------------------------------------------------
// animateSlime — juicy squash & stretch. Never touches position: everything is
// group.scale, anchored at the bottom. Zero allocations per call.
// ---------------------------------------------------------------------------

export function animateSlime(group, dt, { moving = false, grounded = true, speed = 0 } = {}) {
  const ud = group.userData;
  if (!ud || !ud.isSlime) return;

  let targetY;
  if (!grounded) {
    // airborne: vertical stretch
    ud.phase += dt * 3;
    targetY = 1.18;
  } else if (moving) {
    // hop wobble — frequency and amplitude scale with speed
    ud.phase += dt * clamp(5.5 + speed * 0.85, 5.5, 16);
    targetY = 1 + Math.sin(ud.phase) * clamp(0.09 + speed * 0.007, 0.09, 0.16);
  } else {
    // gentle idle breathing
    ud.phase += dt * 2.3;
    targetY = 1 + Math.sin(ud.phase) * 0.035;
  }
  if (ud.phase > 1e4) ud.phase %= Math.PI * 2;

  // landing detection -> brief squash impulse
  if (grounded && !ud.wasGrounded) ud.squash = clamp(0.2 + speed * 0.018, 0.2, 0.42);
  ud.wasGrounded = grounded;

  if (ud.squash > 0.001) {
    targetY *= 1 - ud.squash;
    ud.squash *= Math.exp(-dt * 8.5);
  } else {
    ud.squash = 0;
  }

  // rough volume conservation: widen as it flattens, narrow as it stretches
  const targetX = 1 / Math.sqrt(Math.max(0.4, targetY));

  const k = 1 - Math.exp(-dt * 16);
  ud.sy += (targetY - ud.sy) * k;
  ud.sx += (targetX - ud.sx) * k;

  const b = ud.baseScale;
  group.scale.set(b * ud.sx, b * ud.sy, b * ud.sx);
}

// ---------------------------------------------------------------------------
// makeNameTag — crisp retina canvas sprite: rounded dark pill, colored name,
// optional smaller sub-line. sprite.center = (0.5, 0): position it at head
// height and the tag floats above.
// ---------------------------------------------------------------------------

export function makeNameTag(text, { color = '#ffffff', sub = '' } = {}) {
  const SS = 3; // supersample for retina crispness
  const mainPx = 34;
  const subPx = 21;
  const padX = 20;
  const padY = 9;
  const gap = 5;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `700 ${mainPx * SS}px ${FONT}`;
  let textW = ctx.measureText(text).width / SS;
  if (sub) {
    ctx.font = `600 ${subPx * SS}px ${FONT}`;
    textW = Math.max(textW, ctx.measureText(sub).width / SS);
  }
  const w = Math.ceil(textW + padX * 2);
  const h = Math.ceil(mainPx + (sub ? gap + subPx : 0) + padY * 2);
  canvas.width = w * SS;
  canvas.height = h * SS;
  ctx.scale(SS, SS); // draw in logical units from here on

  // dark translucent pill
  pill(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.fillStyle = 'rgba(15,19,32,0.64)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  ctx.font = `700 ${mainPx}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, padY + mainPx / 2 + 1);
  if (sub) {
    ctx.font = `600 ${subPx}px ${FONT}`;
    ctx.fillStyle = 'rgba(216,228,248,0.92)';
    ctx.fillText(sub, w / 2, padY + mainPx + gap + subPx / 2 + 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  // ~2.2 world units wide for a typical name; long names widen a little
  // instead of squishing the glyphs (text height stays constant).
  const worldW = clamp(w * 0.0095, 1.9, 2.8);
  sprite.scale.set(worldW, (worldW * h) / w, 1);
  sprite.center.set(0.5, 0); // anchor at the bottom — floats above the head
  sprite.renderOrder = 10;
  return sprite;
}

// ---------------------------------------------------------------------------
// makeHpBar — tiny canvas sprite; set(frac) only redraws when the (quantized)
// fraction actually changes. Color sweeps green -> yellow -> red.
// ---------------------------------------------------------------------------

export function makeHpBar() {
  const W = 96;
  const H = 14;
  const INSET = 2.5;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  sprite.scale.set(1.15, (1.15 * H) / W, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 9;

  let last = -1;
  function set(frac) {
    frac = Number.isFinite(frac) ? clamp(frac, 0, 1) : 0;
    const q = Math.round(frac * 60) / 60; // quantize -> skip no-op redraws
    if (q === last) return;
    last = q;

    ctx.clearRect(0, 0, W, H);
    pill(ctx, 0.5, 0.5, W - 1, H - 1, 6.5);
    ctx.fillStyle = 'rgba(10,12,20,0.78)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke();

    if (q > 0) {
      const iw = (W - INSET * 2) * q;
      const ih = H - INSET * 2;
      pill(ctx, INSET, INSET, iw, ih, ih / 2);
      ctx.fillStyle = `hsl(${Math.round(4 + 116 * q)},72%,52%)`;
      ctx.fill();
      if (q > 0.05) {
        // glossy top strip
        pill(ctx, INSET + 1, INSET + 1, iw - 2, ih * 0.42, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fill();
      }
    }
    tex.needsUpdate = true;
  }

  set(1);
  return { sprite, set };
}
