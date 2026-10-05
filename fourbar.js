import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DEFAULT_LINKS,
  rockerRange,
  sampleRevolution,
  solvePose,
  toDegrees,
  tracerPoint,
} from './linkage.js';

const TAU = Math.PI * 2;
const VOID = 0x140818;
const LINKS = DEFAULT_LINKS;
const Z = { ground: -0.06, crank: 0.04, coupler: 0.14, rocker: 0.24, trace: 0.32 };

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

const narrowQuery = window.matchMedia('(max-width: 800px)');
function pixelRatioCap() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, narrowQuery.matches ? 1.5 : 2);
}

const state = {
  theta: 0.9,
  rpm: 8,
  paused: reducedMotion,
  showPath: true,
  lastRocker: null,
};

const cycle = sampleRevolution(LINKS, 240);
const swing = rockerRange(cycle);

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
let bars = null;
let joints = null;
let tracer = null;
let pathLine = null;
let pose = null;
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;

const labelIds = ['a', 'b', 'c', 'd', 'ground', 'crank', 'coupler', 'rocker'];
const labels = Object.fromEntries(labelIds.map((id) => [id, document.getElementById(`label-${id}`)]));

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
  camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);
  const mid = LINKS.ground * 0.5;
  camera.position.set(mid + 0.15, 1.55, 7.1);
  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI / 1.65;
  controls.target.set(mid, 0.85, 0);
  controls.minDistance = 3.2;
  controls.maxDistance = 14;
  controls.update();
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
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
  hemi = new THREE.HemisphereLight(0xffe2c8, 0x120610, 0.62);
  scene.add(hemi);
  keyLight = new THREE.PointLight(0xffb07a, 9.5 * 36, 0, 2);
  keyLight.position.set(LINKS.ground * 0.35, 3.2, 4.4);
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

function makeBar(color, thickness, depth) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, thickness, depth), houseMetal(color));
  mesh.userData.base = { thickness, depth };
  return mesh;
}

function placeBar(mesh, from, to, z) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(0.001, Math.hypot(dx, dy));
  mesh.scale.set(len, 1, 1);
  mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, z);
  mesh.rotation.z = Math.atan2(dy, dx);
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
  }
  rig = new THREE.Group();
  bars = {
    ground: makeBar(0x5c463f, 0.16, 0.08),
    crank: makeBar(0xe2c08a, 0.12, 0.07),
    coupler: makeBar(0xd0aa74, 0.1, 0.07),
    rocker: makeBar(0xc49a68, 0.12, 0.07),
  };
  rig.add(bars.ground, bars.crank, bars.coupler, bars.rocker);

  const pinMat = houseMetal(0x3a2a36);
  const movingMat = houseMetal(0xffc48a);
  movingMat.emissive = new THREE.Color(0xff8a3a);
  movingMat.emissiveIntensity = 0.35;
  joints = {
    A: new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 20), pinMat),
    D: new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 20), pinMat),
    B: new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.22, 20), movingMat),
    C: new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.22, 20), movingMat.clone()),
  };
  for (const joint of Object.values(joints)) {
    joint.rotation.x = Math.PI / 2;
    rig.add(joint);
  }

  tracer = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 12),
    new THREE.MeshPhysicalMaterial({
      color: 0xffc48a,
      metalness: 0.05,
      roughness: 0.48,
      clearcoat: 0.22,
      clearcoatRoughness: 0.45,
      anisotropy: 0,
      emissive: 0xff8a3a,
      emissiveIntensity: 0.7,
    }),
  );
  rig.add(tracer);

  const positions = new Float32Array(cycle.length * 3);
  cycle.forEach((sample, index) => {
    const point = tracerPoint(sample);
    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = Z.trace;
  });
  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pathLine = new THREE.LineLoop(
    pathGeo,
    new THREE.LineBasicMaterial({ color: 0xf0a05a, transparent: true, opacity: 0.9 }),
  );
  pathLine.visible = state.showPath;
  rig.add(pathLine);

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(LINKS.ground + 2.4, 0.08, 1.35),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  plate.position.set(LINKS.ground * 0.45, -0.28, 0.15);
  rig.add(plate);

  scene.add(rig);
  applyPose(solvePose(state.theta, LINKS));
}

function applyPose(next) {
  if (!next) return;
  pose = next;
  placeBar(bars.ground, next.A, next.D, Z.ground);
  placeBar(bars.crank, next.A, next.B, Z.crank);
  placeBar(bars.coupler, next.B, next.C, Z.coupler);
  placeBar(bars.rocker, next.D, next.C, Z.rocker);
  joints.A.position.set(next.A.x, next.A.y, 0.02);
  joints.D.position.set(next.D.x, next.D.y, 0.02);
  joints.B.position.set(next.B.x, next.B.y, Z.coupler);
  joints.C.position.set(next.C.x, next.C.y, Z.rocker);
  const mark = tracerPoint(next);
  tracer.position.set(mark.x, mark.y, Z.trace);
  tracer.visible = state.showPath;
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
    setStatus('Paused. Step the crank, or press play to turn it.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('Crank turning. The rocker only swings.');
  else setStatus('Paused on this pose.');
}

function rockerPhrase(rocker) {
  if (state.lastRocker == null) return 'holding';
  const delta = rocker - state.lastRocker;
  if (delta > 0.0008) return 'swinging out';
  if (delta < -0.0008) return 'swinging back';
  return 'at a stop';
}

function syncHud() {
  if (!pose) return;
  const crankDeg = toDegrees(pose.theta);
  const rockerDeg = toDegrees(pose.rocker);
  const phrase = rockerPhrase(pose.rocker);
  state.lastRocker = pose.rocker;
  document.getElementById('crank-readout').innerHTML = `<em>${crankDeg.toFixed(0)}</em>°`;
  document.getElementById('rocker-readout').textContent = `${rockerDeg.toFixed(0)}°`;
  document.getElementById('meter-crank').innerHTML = `<b>${crankDeg.toFixed(0)}°</b> · spinning`;
  document.getElementById('meter-rocker').innerHTML = `<b>${rockerDeg.toFixed(0)}°</b> · ${phrase}`;
  document.getElementById('meter-swing').innerHTML =
    `<b>${toDegrees(swing.min).toFixed(0)}°–${toDegrees(swing.max).toFixed(0)}°</b>`;
  document.getElementById('meter-path').textContent = state.showPath ? 'Coupler curve on' : 'Coupler curve off';
  document.getElementById('live-line').textContent =
    `Crank ${crankDeg.toFixed(0)}° keeps turning through a full circle. Rocker ${rockerDeg.toFixed(0)}° is ${phrase}. It only travels ${toDegrees(swing.min).toFixed(0)}° to ${toDegrees(swing.max).toFixed(0)}°.`;
}

function projectLabels() {
  if (!pose || !camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  const mark = tracerPoint(pose);
  const spots = {
    a: pose.A,
    b: pose.B,
    c: pose.C,
    d: pose.D,
    ground: { x: (pose.A.x + pose.D.x) / 2, y: -0.28 },
    crank: { x: (pose.A.x + pose.B.x) / 2, y: (pose.A.y + pose.B.y) / 2 },
    coupler: { x: (pose.B.x + mark.x) / 2, y: (pose.B.y + mark.y) / 2 },
    rocker: { x: (pose.D.x + pose.C.x) / 2, y: (pose.D.y + pose.C.y) / 2 },
  };
  for (const id of labelIds) {
    const el = labels[id];
    if (!el) continue;
    if (narrow && !'abcd'.includes(id)) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    const anchor = new THREE.Vector3(spots[id].x, spots[id].y, 0.2);
    anchor.project(camera);
    if (anchor.z > 1) {
      el.hidden = true;
      continue;
    }
    const x = (anchor.x * 0.5 + 0.5) * rect.width;
    const y = (-anchor.y * 0.5 + 0.5) * rect.height;
    const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
    el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, x))}px`;
    el.style.top = `${Math.min(rect.height - 8, Math.max(28, y))}px`;
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
    state.theta += (state.rpm * TAU / 60) * dt;
  }
  const next = solvePose(state.theta, LINKS, pose && pose.C);
  applyPose(next);
  controls.update();
  syncHud();
  projectLabels();
  renderView();
}

function bindUi() {
  document.getElementById('rpm').addEventListener('input', () => {
    state.rpm = Number(document.getElementById('rpm').value);
    document.getElementById('rpm-out').textContent = state.rpm.toFixed(0);
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
  document.getElementById('step-crank').addEventListener('click', () => {
    state.theta += (15 * Math.PI) / 180;
    applyPose(solvePose(state.theta, LINKS, pose && pose.C));
    syncHud();
  });
  document.getElementById('path-toggle').addEventListener('click', () => {
    state.showPath = !state.showPath;
    if (pathLine) pathLine.visible = state.showPath;
    if (tracer) tracer.visible = state.showPath;
    const button = document.getElementById('path-toggle');
    button.setAttribute('aria-pressed', String(state.showPath));
    button.textContent = state.showPath ? 'Coupler path on' : 'Coupler path off';
    syncHud();
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
      setStatus('Crank turning again.');
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
syncHud();
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
renderer.setAnimationLoop(animate);

window.__HFB = {
  state,
  links: LINKS,
  swing,
  get pose() { return pose; },
  canvasCount: () => document.querySelectorAll('canvas').length,
  toDegrees,
};
