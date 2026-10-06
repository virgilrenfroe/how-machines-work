import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  formatAngle,
  formatForce,
  formatInches,
  solveFromLength,
  solveFromThickness,
  solvePreset,
  tradeSentence,
} from './wedges.js';

const VOID = 0x140818;
const VISUAL = 4.8;
const DEPTH = 1.08;

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
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, 1.5);
}

const state = {
  solved: solveFromLength(4, 0.5),
  paused: reducedMotion,
  orbited: false,
  time: 0,
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

const labelNames = ['load', 'effort', 'length', 'thickness'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));

const anchors = {
  load: new THREE.Vector3(),
  effort: new THREE.Vector3(),
  length: new THREE.Vector3(),
  thickness: new THREE.Vector3(),
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
  controls.minPolarAngle = 0.72;
  controls.maxPolarAngle = Math.PI / 2.04;
  controls.target.set(2.1, 0.15, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  frameCamera(true);
}

function visualOf(solved) {
  const span = Math.max(solved.altitude, solved.thickness * 1.15, 1.8);
  const scale = VISUAL / span;
  const altitude = solved.altitude * scale;
  const thickness = solved.thickness * scale;
  return {
    scale,
    altitude,
    thickness,
    half: thickness / 2,
    length: solved.length * scale,
  };
}

function fitDistance(aspect, altitude, thickness) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const halfH = Math.max(thickness * 0.95 + 1.55, 2.15);
  const halfW = Math.max(altitude * 0.58 + 1.15, 2.35);
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  return Math.max(distH, distW);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.35;
  const { altitude, thickness } = visualOf(state.solved);
  const targetX = altitude * 0.42;
  const targetY = thickness * 0.02;
  const dist = fitDistance(aspect, altitude, thickness) * 1.04;
  controls.minDistance = dist * 0.74;
  controls.maxDistance = dist * 1.85;
  controls.target.set(targetX, targetY, 0);
  if (force || !state.orbited) {
    camera.position.set(targetX - altitude * 0.04, targetY + 0.95, dist);
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
  keyLight.position.set(1.2, 3.6, 5.2);
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
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
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

function wedgeGeometry(altitude, half) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -half);
  shape.lineTo(altitude, 0);
  shape.lineTo(0, half);
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
    new THREE.BoxGeometry(1, 0.08, 2.55),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  const tool = new THREE.Group();
  const wedge = new THREE.Mesh(wedgeGeometry(4, 0.4), houseMetal(0xd4b48a, 0.26));
  const poll = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.4, DEPTH * 0.94), houseMetal(0xf0c48a, 0.34));
  const upper = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.42, DEPTH * 0.86), houseMetal(0x8a5a32, 0.14));
  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.42, DEPTH * 0.86), houseMetal(0x6e4528, 0.12));
  const effortArrow = makeArrow();
  effortArrow.userData.mat.emissiveIntensity = 0.55;
  const loadArrow = makeArrow();
  const slopeLine = makeLine(0xf0a05a);
  const thickLine = makeLine(0xf4efe6);
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xf0a05a }),
  );
  outline.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  tool.add(wedge, poll, effortArrow, slopeLine, thickLine, outline);
  rig.add(floor, upper, lower, loadArrow, tool);
  scene.add(rig);
  rig.userData = {
    floor, tool, wedge, poll, upper, lower, effortArrow, loadArrow, slopeLine, thickLine, outline,
  };
  shapeKey = '';
  layoutWedge(1);
}

function faceFrame(altitude, half, u) {
  const len = Math.hypot(altitude, half);
  const nx = half / len;
  const ny = altitude / len;
  return {
    x: altitude * u,
    y: half * (1 - u),
    nx,
    ny,
    len,
  };
}

function layoutWedge(pulse) {
  const parts = rig.userData;
  const solved = state.solved;
  const visual = visualOf(solved);
  const { altitude, half } = visual;
  const key = `${altitude.toFixed(3)}:${half.toFixed(3)}`;
  if (key !== shapeKey) {
    shapeKey = key;
    parts.wedge.geometry.dispose();
    parts.wedge.geometry = wedgeGeometry(altitude, half);

    const cheekH = Math.max(0.36, half * 0.72);
    const cheekLen = Math.max(0.9, altitude * 0.58);
    parts.upper.geometry.dispose();
    parts.lower.geometry.dispose();
    parts.upper.geometry = new THREE.BoxGeometry(cheekLen, cheekH, DEPTH * 0.86);
    parts.lower.geometry = new THREE.BoxGeometry(cheekLen, cheekH, DEPTH * 0.86);

    const face = faceFrame(altitude, half, 0.46);
    const gap = 0.055;
    const lift = gap + cheekH / 2;
    parts.upper.position.set(face.x + face.nx * lift, face.y + face.ny * lift, 0);
    parts.upper.rotation.z = Math.atan2(-face.nx, face.ny);
    parts.lower.position.set(face.x + face.nx * lift, -face.y - face.ny * lift, 0);
    parts.lower.rotation.z = Math.atan2(-face.nx, -face.ny);

    const pollH = Math.max(half * 2, 0.2);
    parts.poll.geometry.dispose();
    parts.poll.geometry = new THREE.BoxGeometry(0.09, pollH, DEPTH * 0.94);
    parts.poll.position.set(-0.045, 0, 0);

    parts.floor.scale.x = altitude + 3.4;
    const floorY = parts.lower.position.y - cheekH / 2 - 0.22;
    parts.floor.position.set(altitude * 0.42, floorY, 0);

    const zLine = DEPTH / 2 + 0.04;
    const off = 0.2;
    const x0 = face.nx * off;
    const y0 = half + face.ny * off;
    const x1 = altitude + face.nx * off;
    const y1 = face.ny * off;
    const tick = 0.14;
    writeLine(parts.slopeLine, [
      new THREE.Vector3(x0, y0, zLine),
      new THREE.Vector3(x1, y1, zLine),
    ]);
    const xT = -0.38;
    writeLine(parts.thickLine, [
      new THREE.Vector3(xT + tick, half, zLine),
      new THREE.Vector3(xT, half, zLine),
      new THREE.Vector3(xT, -half, zLine),
      new THREE.Vector3(xT + tick, -half, zLine),
    ]);

    const outline = parts.outline.geometry.attributes.position;
    const write = (index, x, y) => outline.setXYZ(index, x, y, zLine);
    write(0, 0, half);
    write(1, altitude, 0);
    write(2, 0, -half);
    outline.needsUpdate = true;

    rig.userData.marks = { x0, y0, x1, y1, xT, zLine, cheekH };
    if (!state.orbited) frameCamera(true);
  }

  const nudge = motionAllowed() ? Math.sin(state.time * 1.25) * altitude * 0.04 : 0;
  parts.tool.position.x = nudge;

  const effortLen = (0.55 + 1.15 * (solved.effortForce / solved.loadForce)) * pulse;
  parts.effortArrow.scale.set(1, effortLen, 1);
  parts.effortArrow.rotation.set(0, 0, -Math.PI / 2);
  parts.effortArrow.position.set(-0.16 - effortLen, 0, DEPTH * 0.38);

  const loadLen = 1.35;
  const face = faceFrame(altitude, half, 0.46);
  const cheekTop = parts.upper.position.y + (rig.userData.marks?.cheekH || 0.4) * 0.15;
  parts.loadArrow.scale.set(1, loadLen, 1);
  parts.loadArrow.rotation.set(0, 0, 0);
  parts.loadArrow.position.set(face.x, cheekTop + 0.08, DEPTH * 0.22);

  const marks = rig.userData.marks;
  anchors.length.set(nudge + (marks.x0 + marks.x1) / 2, (marks.y0 + marks.y1) / 2 + 0.2, marks.zLine);
  anchors.thickness.set(nudge + marks.xT, -half - 0.06, marks.zLine);
  anchors.effort.set(nudge - 0.55, 0.55, DEPTH * 0.38);
  anchors.load.set(face.x - 0.08, cheekTop + loadLen * 0.72, DEPTH * 0.22);
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
    setStatus('Paused. Change the length or the thickness.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('The wedge drives into the split. The effort stays on the thick end.');
  else setStatus('Paused. Change the length or the thickness.');
}

function syncHud() {
  const solved = state.solved;
  document.getElementById('ma-readout').innerHTML = `<em>${solved.ma.toFixed(2)}</em> : 1`;
  document.getElementById('ma-sub').textContent = `${formatInches(solved.length)} ÷ ${formatInches(solved.thickness)}`;
  document.getElementById('force-line').innerHTML =
    `<b>${formatForce(solved.effortForce)}</b> <span>effort</span> · 10 lb <span>split</span>`;
  document.getElementById('meter-length').innerHTML = `<b>${formatInches(solved.length)}</b>`;
  document.getElementById('meter-thickness').innerHTML = `<b>${formatInches(solved.thickness)}</b>`;
  document.getElementById('meter-angle').innerHTML = `<b>${formatAngle(solved.includedAngle)}</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatForce(solved.effortForce)}</b>`;
  document.getElementById('live-line').textContent =
    `${formatInches(solved.length)} ÷ ${formatInches(solved.thickness)} = ${solved.ma.toFixed(2)}. A 10 lb split needs ${formatForce(solved.effortForce)} of effort. ${tradeSentence(solved)}`;
  document.getElementById('lesson-trade').textContent = tradeSentence(solved);
  document.getElementById('lesson-work').textContent =
    `You push ${formatForce(solved.effortForce)} along ${formatInches(solved.length)}. The split opens ${formatInches(solved.thickness)}. Ideal work matches either way: ${solved.work.toFixed(1)} in·lb.`;
  document.getElementById('length-out').textContent = formatInches(solved.length);
  document.getElementById('thickness-out').textContent = formatInches(solved.thickness);
  labels.effort.querySelector('span').textContent = formatForce(solved.effortForce);
  labels.length.querySelector('span').textContent = formatInches(solved.length);
  labels.thickness.querySelector('span').textContent = formatInches(solved.thickness);
  markPreset();
}

function syncSliders() {
  const solved = state.solved;
  const lengthEl = document.getElementById('length');
  const thicknessEl = document.getElementById('thickness');
  if (document.activeElement !== lengthEl) lengthEl.value = solved.length.toFixed(2);
  if (document.activeElement !== thicknessEl) thicknessEl.value = solved.thickness.toFixed(2);
}

function markPreset() {
  const solved = state.solved;
  document.querySelectorAll('[data-preset]').forEach((button) => {
    const sample = solvePreset(button.dataset.preset);
    const on = Math.abs(sample.length - solved.length) < 0.05
      && Math.abs(sample.thickness - solved.thickness) < 0.04;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function commitSolved(solved) {
  state.solved = solved;
  syncSliders();
  syncHud();
  if (rig) layoutWedge(1);
}

function projectLabels() {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 560;
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && name === 'thickness') {
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
  if (motionAllowed()) state.time += dt;
  const pulse = motionAllowed() ? 1 + 0.045 * Math.sin(state.time * 3.2) : 1;
  layoutWedge(pulse);
  controls.update();
  projectLabels();
  renderView();
}

function bindUi() {
  document.getElementById('length').addEventListener('input', (event) => {
    commitSolved(solveFromLength(Number(event.target.value), state.solved.thickness));
  });
  document.getElementById('thickness').addEventListener('input', (event) => {
    commitSolved(solveFromThickness(state.solved.length, Number(event.target.value)));
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

window.__WEDGE = {
  state,
  solveFromLength,
  solveFromThickness,
  solvePreset,
  canvasCount: () => document.querySelectorAll('canvas').length,
  solved: () => state.solved,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
};
