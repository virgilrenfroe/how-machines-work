import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  formatAngle,
  formatFeet,
  formatForce,
  solveFromAngle,
  solveFromLength,
  solvePreset,
  tradeSentence,
} from './plane.js';

const VOID = 0x140818;
const VISUAL = 5.4;
const DEPTH = 1.22;

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
  solved: solveFromLength(8, 2),
  paused: reducedMotion,
  orbited: false,
  time: 0,
  travel: 0.55,
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

const labelNames = ['load', 'effort', 'angle', 'slope', 'height', 'run'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));

const anchors = {
  load: new THREE.Vector3(),
  effort: new THREE.Vector3(),
  angle: new THREE.Vector3(),
  slope: new THREE.Vector3(),
  height: new THREE.Vector3(),
  run: new THREE.Vector3(),
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
  controls.minPolarAngle = 0.7;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.target.set(2.2, 0.8, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  frameCamera(true);
}

function visualOf(solved) {
  const span = Math.max(solved.run, solved.height, 2.4);
  const scale = VISUAL / span;
  return {
    scale,
    run: solved.run * scale,
    height: solved.height * scale,
    angle: (solved.angle * Math.PI) / 180,
  };
}

function fitDistance(aspect, run, height) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const halfH = Math.max(height * 0.72 + 1.85, 2.55);
  const halfW = Math.max(run * 0.62 + 0.85, 2.2);
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  return Math.max(distH, distW);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.35;
  const { run, height } = visualOf(state.solved);
  const targetX = run * 0.46;
  const targetY = Math.max(0.35, height * 0.42);
  const dist = fitDistance(aspect, run, height) * 1.06;
  controls.minDistance = dist * 0.78;
  controls.maxDistance = dist * 1.85;
  controls.target.set(targetX, targetY, 0);
  if (force || !state.orbited) {
    camera.position.set(targetX + run * 0.02, targetY + 1.05, dist);
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
  keyLight.position.set(1.4, 3.8, 5.4);
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

function makeArrow() {
  const group = new THREE.Group();
  const mat = houseMetal(0xf0a05a, 0.3);
  mat.emissive = new THREE.Color(0xff8a3a);
  mat.emissiveIntensity = 0.32;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.7, 12), mat);
  shaft.position.y = 0.35;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.3, 14), mat);
  head.position.y = 0.85;
  group.add(shaft, head);
  group.userData.mat = mat;
  return group;
}

function makeLine(color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
}

function writeLine(line, points) {
  const array = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    array[i * 3] = points[i].x;
    array[i * 3 + 1] = points[i].y;
    array[i * 3 + 2] = points[i].z;
  }
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
}

function wedgeGeometry(run, height) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(run, 0);
  shape.lineTo(run, height);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false });
  geo.translate(0, 0, -DEPTH / 2);
  return geo;
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
  }
  rig = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(8.4, 0.1, 2.5),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  floor.position.set(3.1, -0.05, 0);
  const wedge = new THREE.Mesh(wedgeGeometry(4, 1), houseMetal(0x8a5a32, 0.16));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1, 0.07, DEPTH * 0.9), houseMetal(0xf0c48a, 0.28));
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.38, 0.58), houseMetal(0xf3e6d6, 0.2));
  const loadArrow = makeArrow();
  const effortArrow = makeArrow();
  effortArrow.userData.mat.emissiveIntensity = 0.55;
  const triLine = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xf0a05a }),
  );
  triLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
  const corner = makeLine(0xf4efe6);
  const arc = makeLine(0xf0a05a);
  rig.add(floor, wedge, deck, crate, loadArrow, effortArrow, triLine, corner, arc);
  scene.add(rig);
  rig.userData = { wedge, deck, crate, loadArrow, effortArrow, triLine, corner, arc };
  shapeKey = '';
  layoutRamp(1);
}

function layoutRamp(pulse) {
  const parts = rig.userData;
  const solved = state.solved;
  const visual = visualOf(solved);
  const { run, height, angle } = visual;
  const key = `${run.toFixed(3)}:${height.toFixed(3)}`;
  if (key !== shapeKey) {
    shapeKey = key;
    parts.wedge.geometry.dispose();
    parts.wedge.geometry = wedgeGeometry(run, height);
    const slopeLen = Math.hypot(run, height);
    parts.deck.geometry.dispose();
    parts.deck.geometry = new THREE.BoxGeometry(slopeLen, 0.07, DEPTH * 0.9);
    parts.deck.rotation.z = angle;
    const mid = slopePoint(run, height, 0.5, 0.035);
    parts.deck.position.set(mid.x, mid.y, 0);
    if (!state.orbited) frameCamera(true);
  }

  const t = state.travel;
  const crateH = 0.38;
  const onDeck = slopePoint(run, height, t, 0.07 + crateH / 2);
  parts.crate.rotation.z = angle;
  parts.crate.position.set(onDeck.x, onDeck.y, 0);

  const slopeDirX = Math.cos(angle);
  const slopeDirY = Math.sin(angle);
  const normalX = -Math.sin(angle);
  const normalY = Math.cos(angle);
  const effortLen = (0.48 + 1.05 * (solved.effortForce / solved.loadForce)) * pulse;
  const tailX = onDeck.x - slopeDirX * (0.26 + 0.02);
  const tailY = onDeck.y - slopeDirY * (0.26 + 0.02);
  parts.effortArrow.scale.set(1, effortLen, 1);
  parts.effortArrow.rotation.set(0, 0, angle - Math.PI / 2);
  parts.effortArrow.position.set(tailX + normalX * 0.02, tailY + normalY * 0.02, DEPTH * 0.42);

  const loadLen = 1.62;
  parts.loadArrow.scale.set(1, loadLen, 1);
  parts.loadArrow.rotation.set(Math.PI, 0, 0);
  parts.loadArrow.position.set(onDeck.x, onDeck.y + crateH / 2 + loadLen, DEPTH * 0.28);

  const z = DEPTH / 2 + 0.04;
  const tri = parts.triLine.geometry.attributes.position;
  const write = (index, x, y) => tri.setXYZ(index, x, y, z);
  write(0, 0, 0);
  write(1, run, 0);
  write(2, run, 0);
  write(3, run, height);
  write(4, run, height);
  write(5, 0, 0);
  tri.needsUpdate = true;

  const mark = Math.min(0.34, run * 0.14, height * 0.2);
  writeLine(parts.corner, [
    new THREE.Vector3(run - mark, 0, z),
    new THREE.Vector3(run - mark, mark, z),
    new THREE.Vector3(run, mark, z),
  ]);

  const radius = Math.min(0.92, run * 0.28, Math.max(0.35, height * 0.55));
  const arcPts = [];
  const steps = 28;
  for (let i = 0; i <= steps; i += 1) {
    const a = (angle * i) / steps;
    arcPts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, z));
  }
  writeLine(parts.arc, arcPts);

  const bis = angle * 0.5;
  anchors.angle.set(Math.cos(bis) * (radius + 0.38), Math.sin(bis) * (radius + 0.22), z);
  anchors.slope.set(run * 0.42 + normalX * 0.72, height * 0.42 + normalY * 0.72, z);
  anchors.height.set(run + 0.58, height * 0.62, z);
  anchors.run.set(run * 0.55, -0.28, z);
  anchors.load.set(onDeck.x - 0.55, onDeck.y + crateH * 0.2 + loadLen * 0.72, 0);
  anchors.effort.set(
    tailX + slopeDirX * effortLen * 0.45 - 0.15,
    tailY + slopeDirY * effortLen * 0.45 - 0.28,
    DEPTH * 0.42,
  );
}

function slopePoint(run, height, t, lift) {
  const angle = Math.atan2(height, run);
  return {
    x: run * t - Math.sin(angle) * lift,
    y: height * t + Math.cos(angle) * lift,
  };
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
    setStatus('Paused. Change the angle or the ramp length.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('The crate climbs the slope. The effort stays along the ramp.');
  else setStatus('Paused. Change the angle or the ramp length.');
}

function syncHud() {
  const solved = state.solved;
  document.getElementById('ma-readout').innerHTML = `<em>${solved.ma.toFixed(2)}</em> : 1`;
  document.getElementById('ma-sub').textContent = `${formatFeet(solved.length)} ÷ ${formatFeet(solved.height)} · 1 / sin θ`;
  document.getElementById('force-line').innerHTML =
    `<b>${formatForce(solved.effortForce)}</b> <span>effort</span> · 10 lb <span>load</span>`;
  document.getElementById('meter-slope').innerHTML = `<b>${formatFeet(solved.length)}</b>`;
  document.getElementById('meter-height').innerHTML = `<b>${formatFeet(solved.height)}</b>`;
  document.getElementById('meter-angle').innerHTML = `<b>${formatAngle(solved.angle)}</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatForce(solved.effortForce)}</b>`;
  document.getElementById('live-line').textContent =
    `${formatFeet(solved.length)} ÷ ${formatFeet(solved.height)} = ${solved.ma.toFixed(2)}. That is also 1 / sin θ. A 10 lb load needs ${formatForce(solved.effortForce)} of effort along the slope. ${tradeSentence(solved)}`;
  document.getElementById('lesson-trade').textContent = tradeSentence(solved);
  document.getElementById('lesson-work').textContent =
    `You push ${formatForce(solved.effortForce)} along ${formatFeet(solved.length)}. The load rises ${formatFeet(solved.height)}. Ideal work matches either way: ${solved.work.toFixed(1)} ft·lb.`;
  document.getElementById('angle-out').textContent = formatAngle(solved.angle);
  document.getElementById('length-out').textContent = formatFeet(solved.length);
  document.getElementById('height-out').textContent = formatFeet(solved.height);
  labels.effort.querySelector('span').textContent = formatForce(solved.effortForce);
  labels.angle.querySelector('span').textContent = formatAngle(solved.angle);
  labels.slope.querySelector('span').textContent = formatFeet(solved.length);
  labels.height.querySelector('span').textContent = formatFeet(solved.height);
  labels.run.querySelector('span').textContent = formatFeet(solved.run);
  markPreset();
}

function syncSliders() {
  const solved = state.solved;
  const angleEl = document.getElementById('angle');
  const lengthEl = document.getElementById('length');
  const heightEl = document.getElementById('height');
  if (document.activeElement !== angleEl) angleEl.value = String(Math.round(solved.angle * 10) / 10);
  if (document.activeElement !== lengthEl) lengthEl.value = solved.length.toFixed(2);
  if (document.activeElement !== heightEl) heightEl.value = solved.height.toFixed(2);
}

function markPreset() {
  const solved = state.solved;
  document.querySelectorAll('[data-preset]').forEach((button) => {
    const sample = solvePreset(button.dataset.preset);
    const on = Math.abs(sample.length - solved.length) < 0.06 && Math.abs(sample.height - solved.height) < 0.06;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function commitSolved(solved) {
  state.solved = solved;
  syncSliders();
  syncHud();
  if (rig) layoutRamp(1);
}

function projectLabels() {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && (name === 'run' || name === 'height')) {
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
    state.time += dt;
    state.travel += dt * 0.13;
    if (state.travel > 0.84) state.travel = 0.18;
  }
  const pulse = motionAllowed() ? 1 + 0.045 * Math.sin(state.time * 3.2) : 1;
  layoutRamp(pulse);
  controls.update();
  projectLabels();
  renderView();
}

function bindUi() {
  document.getElementById('angle').addEventListener('input', (event) => {
    commitSolved(solveFromAngle(Number(event.target.value), state.solved.height));
  });
  document.getElementById('length').addEventListener('input', (event) => {
    commitSolved(solveFromLength(Number(event.target.value), state.solved.height));
  });
  document.getElementById('height').addEventListener('input', (event) => {
    commitSolved(solveFromLength(state.solved.length, Number(event.target.value)));
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      commitSolved(solvePreset(button.dataset.preset));
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

window.__PLANE = {
  state,
  solveFromAngle,
  solveFromLength,
  solvePreset,
  canvasCount: () => document.querySelectorAll('canvas').length,
  solved: () => state.solved,
};
