import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CENTER_IN,
  DRIVER_RPM,
  MAX_DIAMETER,
  MAX_RPM,
  MIN_DIAMETER,
  MIN_RPM,
  PRESETS,
  beltLoop,
  fitSentence,
  formatFpm,
  formatInches,
  formatRpm,
  liveSentence,
  matchingPreset,
  senseSentence,
  solveBelt,
  speedSentence,
} from './belts.js';

const VOID = 0x140818;
const SCALE = 0.26;
const TAU = Math.PI * 2;
const BELT_WIDTH = 0.3;
const BELT_THICK = 0.075;

const errEl = document.getElementById('err');
const statusEl = document.getElementById('status');
const view = document.getElementById('view');
const canvas = document.getElementById('c');

function showErr() {
  errEl.style.display = 'block';
  errEl.textContent = 'The model paused. It will start again.';
}

function setStatus(message) {
  statusEl.textContent = message || '';
}

let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let userAllowsMotion = false;
try {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
    reducedMotion = event.matches;
    if (reducedMotion) userAllowsMotion = false;
    syncTransport();
  });
} catch (_) {
  /* older Safari */
}

function pixelRatioCap() {
  return Math.min(window.devicePixelRatio || 1, 1.5);
}

const state = {
  solved: solveBelt({
    driverDiameter: 4,
    drivenDiameter: 8,
    driverRpm: DRIVER_RPM,
    crossed: false,
  }),
  paused: reducedMotion,
  orbited: false,
  driverSpin: 0,
};

let renderer;
let scene;
let camera;
let controls;
let clock;
let hemi;
let keyLight;
let envMap = null;
let pmrem = null;
let rig = null;
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;
let shapeKey = '';

const labelNames = ['driver', 'driven', 'belt'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));
const anchors = {
  driver: new THREE.Vector3(),
  driven: new THREE.Vector3(),
  belt: new THREE.Vector3(),
};

const world = {
  points: [],
  cum: [],
  length: 1,
  sign: -1,
  r1: 1,
  r2: 1,
  center: 4,
};

function houseMetal(color, envMapIntensity = 0.22) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.32,
    roughness: 0.45,
    clearcoat: 0.22,
    clearcoatRoughness: 0.55,
    anisotropy: 0,
    envMapIntensity,
  });
}

function bootRenderer() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'default',
  });
  renderer.setPixelRatio(pixelRatioCap());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.setClearColor(VOID, 1);
  renderer.autoClear = false;
  renderer.domElement.style.pointerEvents = 'none';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID);
  camera = new THREE.PerspectiveCamera(30, 1, 0.05, 80);
  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.target.set(2.2, 0.1, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  frameCamera(true);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.35;
  const r1 = (state.solved.driverDiameter * 0.5) * SCALE;
  const r2 = (state.solved.drivenDiameter * 0.5) * SCALE;
  const center = CENTER_IN * SCALE;
  const targetX = center * 0.48;
  const targetY = 0.02;
  const halfW = center * 0.5 + Math.max(r1, r2) + 0.55;
  const halfH = Math.max(r1, r2) + 0.95;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  const dist = Math.max(distH, distW) * 0.98;
  controls.minDistance = dist * 0.7;
  controls.maxDistance = dist * 1.85;
  controls.target.set(targetX, targetY, 0);
  if (force || !state.orbited) {
    camera.position.set(targetX + dist * 0.36, targetY + dist * 0.2, dist * 0.68);
    controls.update();
  }
}

function buildEnvironment() {
  pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  envMap = pmrem.fromScene(room, 0.04).texture;
  scene.environment = envMap;
  room.dispose?.();
  pmrem.dispose();
  pmrem = null;
}

function buildLights() {
  hemi = new THREE.HemisphereLight(0xffe2c8, 0x120610, 0.68);
  scene.add(hemi);
  keyLight = new THREE.PointLight(0xffb07a, 190, 0, 2);
  keyLight.position.set(1.2, 4.2, 6.2);
  scene.add(keyLight);
}

function disposeMaterial(material) {
  if (!material) return;
  const list = Array.isArray(material) ? material : [material];
  for (const entry of list) {
    for (const value of Object.values(entry)) {
      if (value && value.isTexture) value.dispose();
    }
    entry.dispose();
  }
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) disposeMaterial(child.material);
  });
}

function sheaveGeometry(pitchR) {
  const flange = pitchR + 0.07;
  const groove = Math.max(0.12, pitchR - 0.012);
  const hub = Math.min(Math.max(0.1, pitchR * 0.28), groove * 0.72);
  const web = Math.min(flange * 0.78, Math.max(hub + 0.06, pitchR * 0.62));
  const half = 0.1;
  const points = [
    new THREE.Vector2(hub * 0.72, -half),
    new THREE.Vector2(hub, -half * 0.82),
    new THREE.Vector2(web, -0.055),
    new THREE.Vector2(flange, -0.048),
    new THREE.Vector2(groove, 0),
    new THREE.Vector2(flange, 0.048),
    new THREE.Vector2(web, 0.055),
    new THREE.Vector2(hub, half * 0.82),
    new THREE.Vector2(hub * 0.72, half),
  ];
  const geo = new THREE.LatheGeometry(points, 52);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

function beltRibbonGeometry(points) {
  const n = points.length;
  const frames = new Array(n);
  let prevW = null;
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    let tz = next.z - prev.z;
    const tlen = Math.hypot(tx, ty, tz) || 1;
    tx /= tlen;
    ty /= tlen;
    tz /= tlen;
    let wx = -tx * tz;
    let wy = -ty * tz;
    let wz = 1 - tz * tz;
    const wlen = Math.hypot(wx, wy, wz);
    if (wlen < 1e-5) {
      wx = 0;
      wy = 0;
      wz = 1;
    } else {
      wx /= wlen;
      wy /= wlen;
      wz /= wlen;
    }
    if (prevW && wx * prevW.x + wy * prevW.y + wz * prevW.z < 0) {
      wx = -wx;
      wy = -wy;
      wz = -wz;
    }
    prevW = { x: wx, y: wy, z: wz };
    let nx = ty * wz - tz * wy;
    let ny = tz * wx - tx * wz;
    let nz = tx * wy - ty * wx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    frames[i] = { nx, ny, nz, wx, wy, wz };
  }
  const hw = BELT_WIDTH / 2;
  const ht = BELT_THICK / 2;
  const positions = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    const f = frames[i];
    const corners = [
      [ht, hw],
      [ht, -hw],
      [-ht, -hw],
      [-ht, hw],
    ];
    for (let c = 0; c < 4; c += 1) {
      const [alongN, alongW] = corners[c];
      const o = (i * 4 + c) * 3;
      positions[o] = p.x + f.nx * alongN + f.wx * alongW;
      positions[o + 1] = p.y + f.ny * alongN + f.wy * alongW;
      positions[o + 2] = p.z + f.nz * alongN + f.wz * alongW;
    }
  }
  const index = [];
  const quads = [[0, 1], [1, 2], [2, 3], [3, 0]];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    for (const [c0, c1] of quads) {
      const a = i * 4 + c0;
      const b = i * 4 + c1;
      const c = j * 4 + c1;
      const d = j * 4 + c0;
      index.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function makeArrow(material) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.28, 0.035), material);
  shaft.position.y = 0.14;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.14, 12), material);
  head.position.y = 0.34;
  group.add(shaft, head);
  return group;
}

function travelSign(points, r1) {
  const onDriver = [];
  for (let i = 0; i < points.length; i += 1) {
    const d = Math.hypot(points[i].x, points[i].y);
    if (Math.abs(d - r1) < Math.max(0.08, r1 * 0.08)) onDriver.push(i);
  }
  if (!onDriver.length) return -1;
  const i = onDriver[Math.floor(onDriver.length / 2)];
  const p = points[i];
  const n = points[(i + 4) % points.length];
  const tx = n.x - p.x;
  const ty = n.y - p.y;
  const a = Math.atan2(p.y, p.x);
  const dot = tx * -Math.sin(a) + ty * Math.cos(a);
  return dot >= 0 ? 1 : -1;
}

function pointAlong(distance) {
  const pts = world.points;
  const cum = world.cum;
  const total = world.length;
  let d = distance % total;
  if (d < 0) d += total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cum[mid] < d) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.min(lo, pts.length - 1);
  const j = (i + 1) % pts.length;
  const span = (j === 0 ? total : cum[j]) - cum[i];
  const u = span > 1e-8 ? (d - cum[i]) / span : 0;
  const a = pts[i];
  const b = pts[j];
  return new THREE.Vector3(
    a.x + (b.x - a.x) * u,
    a.y + (b.y - a.y) * u,
    a.z + (b.z - a.z) * u,
  );
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
  }
  rig = new THREE.Group();
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x160a1c,
    metalness: 0.06,
    roughness: 0.9,
    envMapIntensity: 0.04,
  });
  const standMat = houseMetal(0x3a2a34, 0.14);
  const driverMat = houseMetal(0xf0a05a, 0.28);
  const drivenMat = houseMetal(0xd7b184, 0.24);
  const shaftMat = houseMetal(0xc9b59a, 0.2);
  const tickMat = new THREE.MeshPhysicalMaterial({
    color: 0xf4efe6,
    metalness: 0.08,
    roughness: 0.4,
    clearcoat: 0.22,
    clearcoatRoughness: 0.4,
    anisotropy: 0,
    emissive: 0xf0a05a,
    emissiveIntensity: 0.55,
  });
  const beltMat = new THREE.MeshPhysicalMaterial({
    color: 0x6a3c24,
    metalness: 0.06,
    roughness: 0.62,
    clearcoat: 0.08,
    clearcoatRoughness: 0.55,
    anisotropy: 0,
    envMapIntensity: 0.12,
    side: THREE.DoubleSide,
  });
  const arrowMat = houseMetal(0xf0a05a, 0.3);
  arrowMat.emissive = new THREE.Color(0xff8a3a);
  arrowMat.emissiveIntensity = 0.45;

  const center = CENTER_IN * SCALE;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(center + 4.2, 0.1, 2.8), floorMat);
  floor.position.set(center * 0.5, -1.82, -0.15);

  function stand(x) {
    const group = new THREE.Group();
    const postH = 1.82 - 0.16;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, postH, 0.16), standMat);
    post.position.set(0, -1.82 + postH / 2, -0.62);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.36), standMat);
    cap.position.set(0, -0.08, -0.62);
    group.add(post, cap);
    group.position.x = x;
    return group;
  }

  function pulleyGroup(material) {
    const group = new THREE.Group();
    const sheave = new THREE.Mesh(sheaveGeometry(0.6), material);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.95, 20), shaftMat);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -0.32;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.05), tickMat);
    group.add(sheave, shaft, tick);
    group.userData = { sheave, tick };
    return group;
  }

  const driver = pulleyGroup(driverMat);
  const driven = pulleyGroup(drivenMat);
  const belt = new THREE.Mesh(new THREE.BufferGeometry(), beltMat);
  const marks = new THREE.Group();
  const markMat = tickMat;
  for (let i = 0; i < 8; i += 1) {
    marks.add(new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), markMat));
  }
  const driverArrow = makeArrow(arrowMat);
  const drivenArrow = makeArrow(arrowMat.clone());

  rig.add(floor, stand(0), stand(center), driver, driven, belt, marks, driverArrow, drivenArrow);
  rig.userData = { driver, driven, belt, marks, driverArrow, drivenArrow };
  scene.add(rig);
  shapeKey = '';
  reshape();
}

function reshape() {
  const solved = state.solved;
  const key = `${solved.driverDiameter.toFixed(3)}:${solved.drivenDiameter.toFixed(3)}:${solved.crossed ? 1 : 0}`;
  if (key === shapeKey) return;
  shapeKey = key;

  const r1in = solved.driverDiameter / 2;
  const r2in = solved.drivenDiameter / 2;
  const loop = beltLoop(r1in, r2in, CENTER_IN, solved.crossed);
  const points = loop.points.map((p) => ({
    x: p.x * SCALE,
    y: p.y * SCALE,
    z: p.z * SCALE,
  }));
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const last = points[points.length - 1];
  const first = points[0];
  const length = cum[cum.length - 1] + Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);
  world.points = points;
  world.cum = cum;
  world.length = Math.max(length, 0.001);
  world.sign = travelSign(loop.points, r1in);
  world.r1 = r1in * SCALE;
  world.r2 = r2in * SCALE;
  world.center = CENTER_IN * SCALE;

  const parts = rig.userData;
  parts.driver.userData.sheave.geometry.dispose();
  parts.driven.userData.sheave.geometry.dispose();
  parts.driver.userData.sheave.geometry = sheaveGeometry(world.r1);
  parts.driven.userData.sheave.geometry = sheaveGeometry(world.r2);
  parts.driver.position.set(0, 0, 0);
  parts.driven.position.set(world.center, 0, 0);
  parts.driver.userData.tick.position.set(world.r1 - 0.02, 0, 0.12);
  parts.driven.userData.tick.position.set(world.r2 - 0.02, 0, 0.12);

  parts.belt.geometry.dispose();
  parts.belt.geometry = beltRibbonGeometry(points);

  const dir = solved.crossed ? 1 : -1;
  aimArrow(parts.driverArrow, 0, world.r1 + 0.2, -1);
  aimArrow(parts.drivenArrow, world.center, world.r2 + 0.2, dir);

  anchors.driver.set(0, world.r1 + 0.02, 0.1);
  anchors.driven.set(world.center, world.r2 + 0.02, 0.1);
  anchors.belt.set(world.center * 0.5, Math.max(world.r1, world.r2) * 0.15, 0.35);

  if (!state.orbited) frameCamera(true);
}

function aimArrow(arrow, x, y, dirX) {
  arrow.position.set(x, y, 0.2);
  const direction = new THREE.Vector3(dirX, 0, 0).normalize();
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
}

function motionAllowed() {
  if (state.paused) return false;
  if (reducedMotion && !userAllowsMotion) return false;
  return true;
}

function syncTransport() {
  const playBtn = document.getElementById('play-toggle');
  if (reducedMotion && !userAllowsMotion) {
    state.paused = true;
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-pressed', 'false');
    setStatus('Paused. Change a pulley diameter or the driver rpm.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (state.paused) setStatus('Paused. Change a pulley diameter or the driver rpm.');
  else setStatus(senseSentence(state.solved));
}

function syncTurns() {
  const solved = state.solved;
  const driverTurns = state.driverSpin / TAU;
  const drivenTurns = Math.abs(driverTurns * (solved.driverDiameter / solved.drivenDiameter));
  const text = `driver <b>${driverTurns.toFixed(2)}</b><br>driven <b>${drivenTurns.toFixed(2)}</b>`;
  const el = document.getElementById('meter-turns');
  if (el.dataset.shown !== text) {
    el.dataset.shown = text;
    el.innerHTML = text;
  }
}

function syncHud() {
  const solved = state.solved;
  document.getElementById('ratio-readout').innerHTML = `<em>${solved.speedRatio.toFixed(2)}</em> : 1`;
  document.getElementById('rpm-line').innerHTML =
    `<b>${formatRpm(solved.drivenRpm)}</b> <span>driven</span> · ${formatRpm(solved.driverRpm)} <span>driver</span>`;
  document.getElementById('ratio-sub').textContent =
    `${formatInches(solved.drivenDiameter)} ÷ ${formatInches(solved.driverDiameter)} · ${solved.crossed ? 'crossed belt' : 'open belt'}`;
  document.getElementById('meter-driver').innerHTML = `<b>${formatInches(solved.driverDiameter)}</b>`;
  document.getElementById('meter-driven').innerHTML = `<b>${formatInches(solved.drivenDiameter)}</b>`;
  document.getElementById('meter-belt').innerHTML = `<b>${formatFpm(solved.beltSpeedFpm)}</b>`;
  document.getElementById('live-line').textContent = liveSentence(solved);
  document.getElementById('lesson-speed').textContent = speedSentence(solved);
  document.getElementById('lesson-sense').textContent = senseSentence(solved);
  document.getElementById('lesson-fit').textContent = fitSentence(solved);
  document.getElementById('driver-out').textContent = formatInches(solved.driverDiameter);
  document.getElementById('driven-out').textContent = formatInches(solved.drivenDiameter);
  document.getElementById('rpm-out').textContent = formatRpm(solved.driverRpm);
  labels.driver.querySelector('span').textContent = formatInches(solved.driverDiameter);
  labels.driven.querySelector('span').textContent = `${formatInches(solved.drivenDiameter)} · ${formatRpm(solved.drivenRpm)}`;
  labels.belt.querySelector('span').textContent = solved.crossed ? 'Crossed' : 'Open';
  markPreset();
  syncTurns();
  if (!state.paused && !(reducedMotion && !userAllowsMotion)) setStatus(senseSentence(solved));
}

function syncSliders() {
  const solved = state.solved;
  const driverEl = document.getElementById('driver-dia');
  const drivenEl = document.getElementById('driven-dia');
  const rpmEl = document.getElementById('driver-rpm');
  if (document.activeElement !== driverEl) driverEl.value = String(solved.driverDiameter);
  if (document.activeElement !== drivenEl) drivenEl.value = String(solved.drivenDiameter);
  if (document.activeElement !== rpmEl) rpmEl.value = String(solved.driverRpm);
}

function markPreset() {
  const solved = state.solved;
  const id = matchingPreset(solved.driverDiameter, solved.drivenDiameter);
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.preset === id ? 'true' : 'false');
  });
  document.querySelectorAll('[data-path]').forEach((button) => {
    const on = button.dataset.path === (solved.crossed ? 'crossed' : 'open');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function commitSolved(solved) {
  state.solved = solved;
  syncSliders();
  syncHud();
  if (rig) reshape();
}

function projectLabels() {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && name === 'belt') {
      el.hidden = true;
      continue;
    }
    const anchor = anchors[name].clone().project(camera);
    if (anchor.z > 1) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    const x = (anchor.x * 0.5 + 0.5) * rect.width;
    const y = (-anchor.y * 0.5 + 0.5) * rect.height;
    const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
    el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, x))}px`;
    el.style.top = `${Math.min(rect.height - 8, Math.max(22, y))}px`;
  }
}

function updateRendererSize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pr = pixelRatioCap();
  if (canvas.width !== Math.floor(width * pr) || canvas.height !== Math.floor(height * pr)) {
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
  }
}

function renderView() {
  updateRendererSize();
  const rect = view.getBoundingClientRect();
  const canvasH = renderer.domElement.clientHeight;
  const canvasW = renderer.domElement.clientWidth;
  if (rect.width > 2 && rect.height > 2) {
    const aspect = rect.width / rect.height;
    if (Math.abs(aspect - camera.aspect) > 0.02) frameCamera(false);
  }
  renderer.setScissorTest(false);
  renderer.setClearColor(VOID, 1);
  renderer.clear();
  renderer.setScissorTest(true);
  if (
    rect.bottom < 0 || rect.top > canvasH || rect.right < 0 || rect.left > canvasW
    || rect.width < 2 || rect.height < 2
  ) return;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setViewport(rect.left, canvasH - rect.bottom, rect.width, rect.height);
  renderer.setScissor(rect.left, canvasH - rect.bottom, rect.width, rect.height);
  renderer.render(scene, camera);
  view.classList.add('is-ready');
}

function animate() {
  if (!visible || contextLost || tornDown) return;
  const dt = Math.min(0.05, clock.getDelta());
  if (motionAllowed()) {
    const omega = (state.solved.driverRpm / DRIVER_RPM) * 0.85;
    state.driverSpin += dt * omega;
  }
  if (rig) {
    const parts = rig.userData;
    parts.driver.rotation.z = state.driverSpin;
    parts.driven.rotation.z = state.driverSpin * state.solved.spinFactor;
    const marks = parts.marks.children;
    for (let i = 0; i < marks.length; i += 1) {
      const along = world.sign * state.driverSpin * world.r1 + (world.length * i) / marks.length;
      marks[i].position.copy(pointAlong(along));
    }
  }
  controls.update();
  syncTurns();
  projectLabels();
  renderView();
}

function readSolved() {
  return solveBelt({
    driverDiameter: Number(document.getElementById('driver-dia').value),
    drivenDiameter: Number(document.getElementById('driven-dia').value),
    driverRpm: Number(document.getElementById('driver-rpm').value),
    crossed: state.solved.crossed,
  });
}

function bindUi() {
  document.getElementById('driver-dia').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('driven-dia').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('driver-rpm').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.preset] || PRESETS.reducer;
      const next = solveBelt({
        driverDiameter: preset.driver,
        drivenDiameter: preset.driven,
        driverRpm: state.solved.driverRpm,
        crossed: state.solved.crossed,
      });
      state.driverSpin = 0;
      commitSolved(next);
    });
  });
  document.querySelectorAll('[data-path]').forEach((button) => {
    button.addEventListener('click', () => {
      commitSolved(solveBelt({
        driverDiameter: state.solved.driverDiameter,
        drivenDiameter: state.solved.drivenDiameter,
        driverRpm: state.solved.driverRpm,
        crossed: button.dataset.path === 'crossed',
      }));
    });
  });
  document.getElementById('play-toggle').addEventListener('click', () => {
    if (reducedMotion && !userAllowsMotion) {
      userAllowsMotion = true;
      state.paused = false;
    } else {
      state.paused = !state.paused;
    }
    syncTransport();
  });
  document.getElementById('reset-turns').addEventListener('click', () => {
    state.driverSpin = 0;
    syncTurns();
  });
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    event.preventDefault();
    state.paused = !state.paused;
    if (reducedMotion && !state.paused) userAllowsMotion = true;
    syncTransport();
  });
}

function disposeEnvironment() {
  if (scene) scene.environment = null;
  if (envMap) {
    envMap.dispose();
    envMap = null;
  }
  if (pmrem) {
    pmrem.dispose();
    pmrem = null;
  }
}

function disposeAll() {
  if (tornDown) return;
  tornDown = true;
  visible = false;
  if (renderer) renderer.setAnimationLoop(null);
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
  }
  disposeEnvironment();
  if (hemi) scene.remove(hemi);
  if (keyLight) scene.remove(keyLight);
  if (controls) controls.dispose();
  if (renderer) renderer.dispose();
}

function onContextLost(event) {
  event.preventDefault();
  contextLost = true;
  if (renderer) renderer.setAnimationLoop(null);
  setStatus('The model paused. It will start again in a moment.');
}

function onContextRestored() {
  window.setTimeout(() => {
    if (tornDown) return;
    try {
      if (rig) {
        scene.remove(rig);
        disposeObject(rig);
        rig = null;
      }
      disposeEnvironment();
      if (hemi) scene.remove(hemi);
      if (keyLight) scene.remove(keyLight);
      buildEnvironment();
      buildLights();
      buildRig();
      contextLost = false;
      clock.getDelta();
      setStatus('');
      syncTransport();
      if (!document.hidden) renderer.setAnimationLoop(animate);
    } catch (error) {
      showErr(error);
    }
  }, 0);
}

function onVisibility() {
  visible = !document.hidden;
  if (!renderer || tornDown) return;
  if (visible && !contextLost) {
    clock.getDelta();
    renderer.setAnimationLoop(animate);
  } else {
    renderer.setAnimationLoop(null);
  }
}

bootRenderer();
buildEnvironment();
buildLights();
buildRig();
bindUi();
syncTransport();
syncSliders();
syncHud();
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
window.addEventListener('resize', () => frameCamera(false));
renderer.setAnimationLoop(animate);

window.__BELT = {
  state,
  solveBelt,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  solved: () => state.solved,
  MIN_DIAMETER,
  MAX_DIAMETER,
  MIN_RPM,
  MAX_RPM,
};
