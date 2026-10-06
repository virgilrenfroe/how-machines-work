import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  MODES,
  PRESETS,
  solve,
  tradeSentence,
} from './axle.js';

const VOID = 0x140818;
const SCALE = 0.2;
const EFFORT_ANGLE = 0.92;
const MODES_ORDER = ['wheel', 'axle'];

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
  wheel: 6,
  axle: 1.5,
  mode: 'wheel',
  paused: reducedMotion,
  orbited: false,
  angle: 0,
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
let machines = [];
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;
let pointerDown = null;
let layoutKey = '';

const labels = {};
for (const mode of MODES_ORDER) {
  for (const part of ['wheel', 'axle', 'effort', 'load']) {
    labels[`${mode}-${part}`] = document.getElementById(`label-${mode}-${part}`);
  }
}

const mats = {};

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

function worldRadius(shop) {
  return shop * SCALE;
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
  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.4;
  controls.maxPolarAngle = Math.PI / 1.65;
  controls.target.set(0, 0, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  mats.shaft = houseMetal(0xb7a090);
  mats.spoke = houseMetal(0xc49a68);
  mats.weight = houseMetal(0xc49a68);
  mats.stand = houseMetal(0x3a2a36, 0.1);
  mats.rope = houseMetal(0x6e5348, 0.08);
  mats.pad = new THREE.MeshStandardMaterial({
    color: 0x160a1c,
    metalness: 0.06,
    roughness: 0.9,
    envMapIntensity: 0.04,
  });
  mats.line = new THREE.LineBasicMaterial({ color: 0xf0a05a, transparent: true, opacity: 0.95 });
  mats.tick = houseMetal(0xf0a05a, 0.3);
  mats.tick.emissive = new THREE.Color(0xff8a3a);
  mats.tick.emissiveIntensity = 0.4;
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
  keyLight = new THREE.PointLight(0xffb07a, 180, 0, 2);
  keyLight.position.set(0.4, 3.2, 6.4);
  scene.add(keyLight);
}

function disposeGeometries(object) {
  const seen = new Set();
  object.traverse((child) => {
    if (!child.geometry || seen.has(child.geometry)) return;
    seen.add(child.geometry);
    child.geometry.dispose();
  });
}

function disposeMaterial(material) {
  if (!material) return;
  const list = Array.isArray(material) ? material : [material];
  for (const entry of list) entry.dispose();
}

class HangRope extends THREE.Curve {
  constructor(radius, drop) {
    super();
    this.radius = radius;
    this.drop = drop;
  }

  getPoint(t, optionalTarget = new THREE.Vector3()) {
    const wrap = 0.38;
    if (t < wrap) {
      const a = Math.PI * (1 + 0.5 * (t / wrap));
      optionalTarget.set(Math.cos(a) * this.radius, Math.sin(a) * this.radius, 0);
      return optionalTarget;
    }
    const u = (t - wrap) / (1 - wrap);
    optionalTarget.set(0, -this.radius - u * this.drop, 0);
    return optionalTarget;
  }
}

function makeArrow(material) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.72, 12), material);
  shaft.position.y = 0.36;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.28, 14), material);
  head.position.y = 0.86;
  group.add(shaft, head);
  return group;
}

function arrowLength(force) {
  return Math.min(1.05, 0.22 + Math.sqrt(Math.max(0, force)) * 0.11);
}

function tag(object, mode) {
  object.traverse((child) => {
    child.userData.mode = mode;
  });
}

function makeMachine(mode, solved) {
  const wheelW = worldRadius(solved.wheelRadius);
  const axleW = worldRadius(solved.axleRadius);
  const group = new THREE.Group();
  const spin = new THREE.Group();
  const rimMat = houseMetal(0xe2c08a);
  const effortMat = houseMetal(0xf0a05a, 0.3);
  effortMat.emissive = new THREE.Color(0xff8a3a);
  effortMat.emissiveIntensity = 0.45;

  const rim = new THREE.Mesh(new THREE.TorusGeometry(wheelW, 0.072, 14, 72), rimMat);
  const spokeLen = Math.max(0.12, wheelW - axleW - 0.1);
  const spokeGeo = new THREE.CylinderGeometry(0.04, 0.04, spokeLen, 10);
  for (let i = 0; i < 6; i += 1) {
    const spoke = new THREE.Mesh(spokeGeo, mats.spoke);
    const angle = (i / 6) * Math.PI * 2;
    spoke.position.set(Math.cos(angle) * (axleW + 0.08 + spokeLen / 2), Math.sin(angle) * (axleW + 0.08 + spokeLen / 2), 0);
    spoke.rotation.z = angle - Math.PI / 2;
    spin.add(spoke);
  }
  const axleLen = 0.98;
  const axleMesh = new THREE.Mesh(new THREE.CylinderGeometry(axleW, axleW, axleLen, 28), mats.shaft);
  axleMesh.rotation.x = Math.PI / 2;
  axleMesh.position.z = -0.22;
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(axleW + 0.07, axleW + 0.07, 0.14, 24),
    mats.spoke,
  );
  hub.rotation.x = Math.PI / 2;
  const tick = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), mats.tick);
  tick.position.set(wheelW, 0, 0.08);
  const axleTick = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), mats.tick);
  axleTick.position.set(axleW + 0.02, 0, 0.28);

  const crankR = mode === 'wheel' ? wheelW : Math.max(axleW + 0.02, axleW);
  const crankAngle = EFFORT_ANGLE;
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.18, 10), effortMat);
  pin.rotation.x = Math.PI / 2;
  pin.position.set(Math.cos(crankAngle) * crankR, Math.sin(crankAngle) * crankR, 0.12);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), effortMat);
  knob.position.set(Math.cos(crankAngle) * crankR, Math.sin(crankAngle) * crankR, 0.22);

  spin.add(rim, axleMesh, hub, tick, axleTick, pin, knob);
  spin.rotation.z = state.angle;

  const attachR = mode === 'wheel' ? axleW : wheelW;
  const drop = Math.max(0.62, wheelW - attachR + 0.62);
  const ropeZ = mode === 'wheel' ? -0.22 : 0.02;
  const rope = new THREE.Mesh(
    new THREE.TubeGeometry(new HangRope(attachR, drop), 40, 0.016, 6, false),
    mats.rope,
  );
  rope.position.z = ropeZ;
  const weight = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.28, 0.3), mats.weight);
  weight.position.set(0, -attachR - drop - 0.16, ropeZ);

  const yPad = -wheelW - 1.05;
  const pad = new THREE.Mesh(new THREE.BoxGeometry(wheelW * 2 + 1.15, 0.06, 1.25), mats.pad);
  pad.position.set(0, yPad, -0.2);
  const postH = Math.max(0.2, -yPad - axleW);
  const posts = new THREE.Group();
  for (const x of [-0.18, 0.18]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, postH, 0.07), mats.stand);
    post.position.set(x, yPad + postH / 2, -0.55);
    posts.add(post);
  }
  const bearing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.12), mats.stand);
  bearing.position.set(0, -axleW - 0.02, -0.55);

  const radiusGeo = new THREE.BufferGeometry();
  const radiusPos = new Float32Array([
    0, 0, 0.04,
    axleW, 0, 0.04,
    axleW, 0, 0.04,
    wheelW, 0, 0.04,
  ]);
  radiusGeo.setAttribute('position', new THREE.BufferAttribute(radiusPos, 3));
  const radiusLine = new THREE.LineSegments(radiusGeo, mats.line);
  radiusLine.rotation.z = -0.62;

  const effortArrow = makeArrow(effortMat);
  const effortR = mode === 'wheel' ? wheelW : axleW;
  const tangent = new THREE.Vector3(-Math.sin(EFFORT_ANGLE), Math.cos(EFFORT_ANGLE), 0);
  effortArrow.position.set(
    Math.cos(EFFORT_ANGLE) * effortR,
    Math.sin(EFFORT_ANGLE) * effortR,
    0.46,
  );
  effortArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);

  group.add(spin, rope, weight, pad, posts, bearing, radiusLine, effortArrow);
  group.rotation.y = -0.62;
  tag(group, mode);

  return {
    mode,
    group,
    spin,
    rimMat,
    effortMat,
    effortArrow,
    radiusLine,
    wheelW,
    axleW,
    attachR,
    drop,
    ropeZ,
  };
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeGeometries(rig);
    for (const machine of machines) {
      disposeMaterial(machine.rimMat);
      disposeMaterial(machine.effortMat);
    }
  }
  const solved = solve(state.wheel, state.axle);
  state.wheel = solved.wheelRadius;
  state.axle = solved.axleRadius;
  rig = new THREE.Group();
  machines = MODES_ORDER.map((mode) => makeMachine(mode, solved));
  for (const machine of machines) rig.add(machine.group);
  scene.add(rig);
  placeMachines();
  paintMachines();
}

function layoutOf() {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.45;
  const stacked = aspect < 1.05;
  const wheelW = worldRadius(state.wheel);
  const gap = wheelW + 1.2;
  return { stacked, gap, wheelW, aspect };
}

function placeMachines() {
  const layout = layoutOf();
  machines.forEach((machine, index) => {
    if (layout.stacked) {
      const y = index === 0 ? layout.gap + 0.35 : -(layout.gap + 0.15);
      machine.group.position.set(0, y, 0);
    } else {
      machine.group.position.set(index === 0 ? -layout.gap : layout.gap, 0.2, 0);
    }
  });
  const key = `${layout.stacked ? 's' : 'w'}:${layout.gap.toFixed(2)}`;
  if (key !== layoutKey) {
    layoutKey = key;
    frameCamera(false);
  }
  return layout;
}

function focusPoint() {
  const point = new THREE.Vector3();
  if (!machines.length) return point;
  for (const machine of machines) point.add(machine.group.position);
  point.multiplyScalar(1 / machines.length);
  point.y -= 0.35;
  return point;
}

function fitDistance(aspect) {
  const layout = layoutOf();
  const halfH = layout.stacked ? layout.gap + layout.wheelW + 2.55 : layout.wheelW + 1.85;
  const halfW = layout.stacked ? layout.wheelW + 0.95 : layout.gap + layout.wheelW + 0.7;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  return Math.max(distH, distW);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.45;
  const dist = fitDistance(aspect);
  const focus = focusPoint();
  controls.minDistance = dist * 0.82;
  controls.maxDistance = dist * 1.9;
  controls.target.copy(focus);
  if (force || !state.orbited) {
    camera.position.set(focus.x + 0.15, focus.y + 0.55, focus.z + dist);
    controls.update();
  }
}

function paintMachines() {
  const solved = currentSolved();
  for (const machine of machines) {
    const active = machine.mode === state.mode;
    machine.rimMat.color.setHex(active ? 0xf0c48a : 0x7d6244);
    machine.rimMat.envMapIntensity = active ? 0.3 : 0.12;
    machine.effortMat.emissiveIntensity = active ? 0.55 : 0.14;
    machine.radiusLine.visible = active;
    const force = machine.mode === 'wheel' ? solved.effortWheel : solved.effortAxle;
    const breathe = active && motionAllowed() ? 1 + 0.05 * Math.sin(state.time * 3) : 1;
    machine.effortArrow.scale.set(1, arrowLength(force) * breathe, 1);
  }
}

function currentSolved() {
  return solve(state.wheel, state.axle);
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
    setStatus('Paused. Change the radii, or press play to see the wheel turn.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('The rim mark and the axle mark share one turn.');
  else setStatus('Paused. Change the wheel or the axle.');
}

function formatForce(value) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function displayed(solved) {
  const wheel = Number(solved.wheelRadius.toFixed(1));
  const axle = Number(solved.axleRadius.toFixed(1));
  const maWheel = wheel / axle;
  const maAxle = axle / wheel;
  return {
    wheel,
    axle,
    maWheel,
    maAxle,
    effortWheel: (solved.loadForce * axle) / wheel,
    effortAxle: (solved.loadForce * wheel) / axle,
    loadForce: solved.loadForce,
  };
}

function syncHud() {
  const shown = displayed(currentSolved());
  const mode = state.mode;
  const ma = mode === 'wheel' ? shown.maWheel : shown.maAxle;
  const meta = MODES[mode];
  document.getElementById('ma-readout').innerHTML = `<em>${ma.toFixed(2)}</em> : 1`;
  document.getElementById('ma-sub').textContent = mode === 'wheel'
    ? 'R wheel / R axle'
    : 'R axle / R wheel';
  document.getElementById('meter-wheel').innerHTML = `<b>${shown.wheel.toFixed(1)}</b>`;
  document.getElementById('meter-axle').innerHTML = `<b>${shown.axle.toFixed(1)}</b>`;
  document.getElementById('meter-load').innerHTML = `<b>${shown.loadForce.toFixed(0)} lb</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatForce(mode === 'wheel' ? shown.effortWheel : shown.effortAxle)} lb</b>`;
  document.getElementById('wheel-out').textContent = shown.wheel.toFixed(1);
  document.getElementById('axle-out').textContent = shown.axle.toFixed(1);
  document.getElementById('live-line').textContent =
    `${shown.wheel.toFixed(1)} ÷ ${shown.axle.toFixed(1)} = ${shown.maWheel.toFixed(2)}. Drive the wheel: 10 ÷ ${shown.maWheel.toFixed(2)} = ${formatForce(shown.effortWheel)} lb. Drive the axle: 10 × ${shown.maWheel.toFixed(2)} = ${formatForce(shown.effortAxle)} lb.`;
  document.getElementById('lesson-order').textContent = `${meta.name}. ${meta.order} ${meta.shop}`;
  document.getElementById('lesson-trade').textContent = tradeSentence(mode, currentSolved());
  for (const id of MODES_ORDER) {
    const button = document.querySelector(`.mode-rows button[data-mode="${id}"]`);
    const effort = id === 'wheel' ? shown.effortWheel : shown.effortAxle;
    const rowMa = id === 'wheel' ? shown.maWheel : shown.maAxle;
    button.setAttribute('aria-pressed', id === mode ? 'true' : 'false');
    button.querySelector('em').textContent = `${formatForce(effort)} lb`;
    button.querySelector('small').textContent = `${rowMa.toFixed(2)} : 1`;
  }
  for (const preset of PRESETS) {
    const button = document.querySelector(`.chip[data-preset="${preset.id}"]`);
    if (!button) continue;
    const on = Math.abs(shown.wheel - preset.wheel) < 0.05 && Math.abs(shown.axle - preset.axle) < 0.05;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const wheelLabel = labels['wheel-wheel'];
  if (wheelLabel) {
    for (const id of MODES_ORDER) {
      labels[`${id}-wheel`].querySelector('span').textContent = `R ${shown.wheel.toFixed(1)}`;
      labels[`${id}-axle`].querySelector('span').textContent = `R ${shown.axle.toFixed(1)}`;
      const effort = id === 'wheel' ? shown.effortWheel : shown.effortAxle;
      labels[`${id}-effort`].querySelector('span').textContent = `${formatForce(effort)} lb`;
    }
  }
}

function sliderValue(shop) {
  return String(Math.round(shop * 10));
}

function syncSliders() {
  const wheelEl = document.getElementById('wheel');
  const axleEl = document.getElementById('axle');
  if (document.activeElement !== wheelEl) wheelEl.value = sliderValue(state.wheel);
  if (document.activeElement !== axleEl) axleEl.value = sliderValue(state.axle);
}

function setMode(mode) {
  if (!MODES[mode]) return;
  state.mode = mode;
  paintMachines();
  syncHud();
}

function setRadii(wheel, axle) {
  const solved = solve(wheel, axle);
  const changed = solved.wheelRadius !== state.wheel || solved.axleRadius !== state.axle;
  state.wheel = solved.wheelRadius;
  state.axle = solved.axleRadius;
  if (changed) buildRig();
  else paintMachines();
  syncSliders();
  syncHud();
  frameCamera(false);
}

function projectLabels() {
  if (!camera || !machines.length) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  rig.updateMatrixWorld(true);
  const narrow = rect.width < 680;
  const shown = displayed(currentSolved());
  for (const machine of machines) {
    const active = machine.mode === state.mode;
    const force = machine.mode === 'wheel' ? shown.effortWheel : shown.effortAxle;
    const len = arrowLength(force);
    const tangent = new THREE.Vector3(-Math.sin(EFFORT_ANGLE), Math.cos(EFFORT_ANGLE), 0);
    const effortR = machine.mode === 'wheel' ? machine.wheelW : machine.axleW;
    const labelReach = machine.mode === 'wheel' ? 0.42 : 0.85;
    const spots = {
      wheel: new THREE.Vector3(-0.42, machine.wheelW + 0.28, 0.12),
      axle: new THREE.Vector3(-machine.axleW - 0.48, 0.02, 0.2),
      effort: new THREE.Vector3(
        Math.cos(EFFORT_ANGLE) * (effortR + 0.2) + tangent.x * (len + labelReach),
        Math.sin(EFFORT_ANGLE) * (effortR + 0.2) + tangent.y * (len + labelReach * 0.35),
        0.55,
      ),
      load: new THREE.Vector3(0.15, -machine.attachR - machine.drop - 0.48, machine.ropeZ),
    };
    for (const part of ['wheel', 'axle', 'effort', 'load']) {
      const el = labels[`${machine.mode}-${part}`];
      if (!el) continue;
      if (narrow && (!active || part === 'wheel')) {
        el.hidden = true;
        continue;
      }
      const anchor = spots[part].clone();
      machine.group.localToWorld(anchor);
      anchor.project(camera);
      if (anchor.z > 1) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      const nudge = machine.mode === 'wheel'
        ? { wheel: [-54, -6], axle: [-8, 6], effort: [62, 26], load: [10, 6] }
        : { wheel: [8, -6], axle: [-18, 8], effort: [-36, 4], load: [12, 6] };
      const shift = nudge[part];
      const x = (anchor.x * 0.5 + 0.5) * rect.width + shift[0];
      const y = (-anchor.y * 0.5 + 0.5) * rect.height + shift[1];
      const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
      const minTop = narrow ? 96 : 22;
      el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, x))}px`;
      el.style.top = `${Math.min(rect.height - 8, Math.max(minTop, y))}px`;
    }
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
    state.angle += dt * 0.55;
    for (const machine of machines) machine.spin.rotation.z = state.angle;
  }
  paintMachines();
  controls.update();
  placeMachines();
  projectLabels();
  renderView();
}

function selectFromPointer(event) {
  const rect = view.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(machines.map((machine) => machine.group), true);
  if (!hits.length) return;
  const mode = hits[0].object.userData.mode;
  if (mode) setMode(mode);
}

function bindUi() {
  document.querySelectorAll('.mode-rows button').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });
  document.querySelectorAll('.chip[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS.find((item) => item.id === button.dataset.preset);
      if (!preset) return;
      setRadii(preset.wheel, preset.axle);
    });
  });
  document.getElementById('wheel').addEventListener('input', () => {
    const wheel = Number(document.getElementById('wheel').value) / 10;
    const axle = Number(document.getElementById('axle').value) / 10;
    setRadii(wheel, axle);
  });
  document.getElementById('axle').addEventListener('input', () => {
    const wheel = Number(document.getElementById('wheel').value) / 10;
    const axle = Number(document.getElementById('axle').value) / 10;
    setRadii(wheel, axle);
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
    const tagName = document.activeElement && document.activeElement.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'BUTTON') return;
    event.preventDefault();
    state.paused = !state.paused;
    if (reducedMotion && !state.paused) userAllowsMotion = true;
    syncTransport();
  });
  view.addEventListener('pointerdown', (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  });
  view.addEventListener('pointerup', (event) => {
    if (!pointerDown) return;
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    pointerDown = null;
    if (dx * dx + dy * dy > 36) return;
    selectFromPointer(event);
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
    disposeGeometries(rig);
    for (const machine of machines) {
      disposeMaterial(machine.rimMat);
      disposeMaterial(machine.effortMat);
    }
    rig = null;
  }
  for (const material of Object.values(mats)) disposeMaterial(material);
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
        disposeGeometries(rig);
        for (const machine of machines) {
          disposeMaterial(machine.rimMat);
          disposeMaterial(machine.effortMat);
        }
        rig = null;
        machines = [];
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
frameCamera(true);
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
window.addEventListener('resize', () => {
  placeMachines();
  frameCamera(false);
});
renderer.setAnimationLoop(animate);

window.__WAX = {
  state,
  solve,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  solved: () => currentSolved(),
  anisotropy: () => machines.map((machine) => machine.rimMat.anisotropy),
};
