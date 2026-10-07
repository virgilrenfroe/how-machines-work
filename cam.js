import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CHART_MAX,
  PRESETS,
  ROLLER_RADIUS,
  SHAFT_RADIUS,
  camOutline,
  displacementSamples,
  followerCenter,
  formatAngle,
  formatLift,
  formatRpm,
  liveSentence,
  phaseBands,
  readCam,
  wrapAngle,
} from './cams.js';

const VOID = 0x140818;
const PLATE = 0.36;

const errEl = document.getElementById('err');
const statusEl = document.getElementById('status');
const view = document.getElementById('view');
const canvas = document.getElementById('c');

function showErr() {
  errEl.style.display = 'block';
  errEl.textContent = 'The model paused. It will start again.';
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
  preset: 'eccentric',
  angle: 120,
  rpm: 8,
  paused: reducedMotion,
  orbited: false,
  cycles: 0,
  rollerSpin: 0,
  phase: '',
  shownAngle: null,
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
let camGroup = null;
let follower = null;
let rollerMesh = null;
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;

const labelNames = ['cam', 'follower', 'mark'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));
const anchors = {
  cam: new THREE.Vector3(1.85, 0.35, 0.4),
  follower: new THREE.Vector3(),
  mark: new THREE.Vector3(),
};
const markLocal = new THREE.Vector3();

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
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = Math.PI / 1.85;
  controls.target.set(0, 0.35, 0);
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
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const halfH = 2.35;
  const halfW = 1.85;
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.4, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  const dist = Math.max(distH, distW) * 0.96;
  controls.minDistance = dist * 0.7;
  controls.maxDistance = dist * 1.85;
  controls.target.set(0, 0.08, 0);
  if (force || !state.orbited) {
    camera.position.set(0.72, 0.85, dist);
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
  keyLight = new THREE.PointLight(0xffb07a, 170, 0, 2);
  keyLight.position.set(2.4, 4.2, 5.6);
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

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i].x * next.y - next.x * points[i].y;
  }
  return area / 2;
}

function plateShape(points) {
  const ring = signedArea(points) < 0 ? points.slice().reverse() : points.slice();
  const shape = new THREE.Shape();
  shape.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i].x, ring[i].y);
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, SHAFT_RADIUS + 0.04, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return { shape, ring };
}

function buildCam(presetId) {
  if (!rig) return;
  if (camGroup) {
    rig.remove(camGroup);
    disposeObject(camGroup);
    camGroup = null;
  }
  const points = camOutline(presetId, 480);
  const { shape, ring } = plateShape(points);
  camGroup = new THREE.Group();
  camGroup.name = 'cam';

  const plate = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: PLATE, bevelEnabled: false, curveSegments: 12 }),
    houseMetal(0xc4844c, 0.28),
  );
  plate.position.z = -PLATE / 2;

  const rimPts = ring.map((point) => new THREE.Vector3(point.x, point.y, PLATE / 2 + 0.012));
  const rim = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(rimPts),
    new THREE.LineBasicMaterial({ color: 0xf0a05a }),
  );

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, 1.35, 28),
    houseMetal(0x8a5a32, 0.2),
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.22;

  let top = points[0];
  for (const point of points) {
    if (point.y > top.y) top = point;
  }
  markLocal.set(top.x * 0.78, top.y * 0.78, PLATE / 2 + 0.06);
  const mark = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.11, 0.07, 18),
    houseMetal(0xf4efe6, 0.24),
  );
  mark.material.emissive = new THREE.Color(0xf0a05a);
  mark.material.emissiveIntensity = 0.18;
  mark.rotation.x = Math.PI / 2;
  mark.position.copy(markLocal);

  camGroup.add(plate, rim, shaft, mark);
  camGroup.rotation.z = -THREE.MathUtils.degToRad(wrapAngle(state.angle));
  rig.add(camGroup);
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
    camGroup = null;
    follower = null;
    rollerMesh = null;
  }
  rig = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(8.2, 0.1, 4.6),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  floor.position.set(0, -2.42, 0.15);

  const back = new THREE.Mesh(
    new THREE.BoxGeometry(5.8, 6.15, 0.14),
    houseMetal(0x24141c, 0.08),
  );
  back.position.set(0, 0.55, -0.86);

  const bearing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.52, 0.28, 28),
    houseMetal(0x3a241c, 0.16),
  );
  bearing.rotation.x = Math.PI / 2;
  bearing.position.set(0, 0, -0.62);

  follower = new THREE.Group();
  const rollerMat = houseMetal(0xf4efe6, 0.26);
  rollerMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(ROLLER_RADIUS, ROLLER_RADIUS, 0.42, 28),
    rollerMat,
  );
  rollerMesh.rotation.order = 'YXZ';
  rollerMesh.rotation.x = Math.PI / 2;
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1.9, 16),
    houseMetal(0xe7d7c8, 0.18),
  );
  stem.position.y = 0.16 + 0.95;
  const yoke = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.14, 0.46),
    houseMetal(0xc4844c, 0.24),
  );
  yoke.position.y = 0.16;
  follower.add(rollerMesh, stem, yoke);

  const guideMat = houseMetal(0x8a5a32, 0.18);
  const cheekL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.55, 0.36), guideMat);
  const cheekR = cheekL.clone();
  cheekL.position.set(-0.24, 2.68, 0);
  cheekR.position.set(0.24, 2.68, 0);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.12, 0.36), guideMat);
  cap.position.set(0, 2.96, 0);
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.22, 0.78),
    houseMetal(0x3a241c, 0.12),
  );
  arm.position.set(0, 2.68, -0.42);

  rig.add(floor, back, bearing, follower, cheekL, cheekR, cap, arm);
  scene.add(rig);
  buildCam(state.preset);
  placeFollower();
}

function placeFollower() {
  if (!follower) return;
  follower.position.set(0, followerCenter(state.preset, state.angle), 0);
  anchors.follower.set(0.62, follower.position.y + 0.85, 0.2);
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
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
}

function bandFill(phase) {
  if (phase === 'dwell-high') return 'rgba(240,160,90,0.28)';
  if (phase === 'rise') return 'rgba(240,160,90,0.16)';
  if (phase === 'return') return 'rgba(240,160,90,0.10)';
  return 'rgba(244,239,230,0.06)';
}

function buildDiagram(presetId) {
  const host = document.getElementById('trace');
  const samples = displacementSamples(presetId, 361);
  const yOf = (lift) => 92 - (Math.min(CHART_MAX, lift) / CHART_MAX) * 76;
  const bands = phaseBands(presetId).map((band) => {
    const width = band.end - band.start;
    return `<rect x="${band.start}" y="14" width="${width}" height="78" fill="${bandFill(band.phase)}"></rect>`;
  }).join('');
  const line = samples.map((sample, index) => {
    const command = index === 0 ? 'M' : 'L';
    return `${command}${sample.angle.toFixed(2)},${yOf(sample.lift).toFixed(2)}`;
  }).join(' ');
  host.innerHTML = `<svg class="trace" viewBox="0 0 360 100" preserveAspectRatio="none" aria-hidden="true">
    ${bands}
    <line x1="0" y1="92" x2="360" y2="92" stroke="rgba(244,239,230,0.28)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
    <path d="${line}" fill="none" stroke="#f0a05a" stroke-width="2" vector-effect="non-scaling-stroke"></path>
    <line id="trace-cursor" x1="0" y1="8" x2="0" y2="96" stroke="#f4efe6" stroke-width="1.25" vector-effect="non-scaling-stroke"></line>
    <circle id="trace-dot" r="3.2" cy="92" cx="0" fill="#f4efe6" vector-effect="non-scaling-stroke"></circle>
  </svg>`;
}

function moveDiagram(read) {
  const cursor = document.getElementById('trace-cursor');
  const dot = document.getElementById('trace-dot');
  if (!cursor || !dot) return;
  const y = 92 - (Math.min(CHART_MAX, read.lift) / CHART_MAX) * 76;
  cursor.setAttribute('x1', String(read.angle));
  cursor.setAttribute('x2', String(read.angle));
  dot.setAttribute('cx', String(read.angle));
  dot.setAttribute('cy', y.toFixed(2));
}

function syncHud() {
  const read = readCam(state.preset, state.angle);
  document.getElementById('lift-num').textContent = read.lift.toFixed(2);
  document.getElementById('angle-num').textContent = formatAngle(read.angle);
  document.getElementById('meter-angle').innerHTML = `<b>${formatAngle(read.angle)}</b>`;
  document.getElementById('meter-lift').innerHTML = `<b>${formatLift(read.lift)}</b>`;
  document.getElementById('meter-phase').innerHTML = `<b>${read.label}</b>`;
  document.getElementById('meter-cycles').innerHTML = `<b>${state.cycles}</b>`;
  document.getElementById('lesson-now').textContent =
    `${PRESETS[state.preset].label} cam, ${formatAngle(read.angle)}, follower lift ${formatLift(read.lift)}. ${read.sentence}`;
  const rounded = Math.round(read.angle);
  if (rounded !== state.shownAngle || read.phase !== state.phase) {
    state.shownAngle = rounded;
    document.getElementById('live-line').textContent = liveSentence(read, state.rpm);
  }
  if (read.phase !== state.phase) {
    state.phase = read.phase;
    statusEl.textContent = read.label;
  }
  labels.follower.querySelector('span').textContent = formatLift(read.lift);
  moveDiagram(read);
  markPreset();
}

function syncSliders() {
  const angleEl = document.getElementById('angle');
  const speedEl = document.getElementById('speed');
  if (document.activeElement !== angleEl) angleEl.value = String(Math.round(wrapAngle(state.angle)));
  if (document.activeElement !== speedEl) speedEl.value = String(state.rpm);
  document.getElementById('angle-out').textContent = formatAngle(state.angle);
  document.getElementById('speed-out').textContent = formatRpm(state.rpm);
}

function markPreset() {
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.preset === state.preset ? 'true' : 'false');
  });
}

function applyPreset(presetId) {
  if (!PRESETS[presetId]) return;
  state.preset = presetId;
  state.shownAngle = null;
  state.phase = '';
  buildCam(presetId);
  buildDiagram(presetId);
  placeFollower();
  syncSliders();
  syncHud();
}

function setAngle(deg, fromSlider) {
  state.angle = wrapAngle(deg);
  if (fromSlider) state.paused = true;
  if (camGroup) camGroup.rotation.z = -THREE.MathUtils.degToRad(state.angle);
  placeFollower();
  syncTransport();
  syncSliders();
  syncHud();
}

function projectLabels() {
  if (!camera || !camGroup) return;
  camGroup.updateWorldMatrix(true, false);
  anchors.mark.copy(markLocal).applyMatrix4(camGroup.matrixWorld);
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 560;
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && name === 'mark') {
      el.hidden = true;
      continue;
    }
    const anchor = anchors[name].clone().project(camera);
    if (anchor.z > 1) {
      el.hidden = true;
      continue;
    }
    const x = (anchor.x * 0.5 + 0.5) * rect.width;
    const y = (-anchor.y * 0.5 + 0.5) * rect.height;
    if (y < 28 || y > rect.height - 12) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
    el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, x))}px`;
    el.style.top = `${y}px`;
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
    const next = state.angle + state.rpm * 6 * dt;
    if (next >= 360) state.cycles += 1;
    state.angle = wrapAngle(next);
    state.rollerSpin += (state.rpm * Math.PI * 2 * dt) / 60 * (1.15 / ROLLER_RADIUS);
    if (rollerMesh) rollerMesh.rotation.y = state.rollerSpin;
  }
  if (camGroup) camGroup.rotation.z = -THREE.MathUtils.degToRad(state.angle);
  placeFollower();
  controls.update();
  syncSliders();
  syncHud();
  projectLabels();
  renderView();
}

function bindUi() {
  document.getElementById('angle').addEventListener('input', (event) => {
    setAngle(Number(event.target.value), true);
  });
  document.getElementById('speed').addEventListener('input', (event) => {
    state.rpm = Number(event.target.value);
    state.shownAngle = null;
    syncSliders();
    syncHud();
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
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
    camGroup = null;
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
  statusEl.textContent = 'The model paused. It will start again in a moment.';
}

function onContextRestored() {
  window.setTimeout(() => {
    if (tornDown) return;
    try {
      if (rig) {
        scene.remove(rig);
        disposeObject(rig);
        rig = null;
        camGroup = null;
      }
      disposeEnvironment();
      if (hemi) scene.remove(hemi);
      if (keyLight) scene.remove(keyLight);
      buildEnvironment();
      buildLights();
      buildRig();
      buildDiagram(state.preset);
      contextLost = false;
      state.phase = '';
      clock.getDelta();
      syncTransport();
      syncHud();
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
buildDiagram(state.preset);
bindUi();
syncTransport();
syncSliders();
syncHud();
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
window.addEventListener('resize', () => frameCamera(false));
renderer.setAnimationLoop(animate);

window.__CAM = {
  state,
  readCam,
  liftOf: (preset, angle) => readCam(preset, angle).lift,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatioCap,
  setAngle: (deg) => setAngle(deg, true),
  setPreset: (id) => applyPreset(id),
};
