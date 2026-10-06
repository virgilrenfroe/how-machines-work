import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  PRESETS,
  formatInches,
  formatMa,
  formatPitch,
  formatPounds,
  formatTpi,
  solve,
  tradeSentence,
} from './screws.js';

const TAU = Math.PI * 2;
const VOID = 0x140818;
const THREAD_X0 = 0.25;
const THREAD_LEN = 3.5;
const GAUGE_X = 2.2;
const JAW_X = THREAD_X0 + THREAD_LEN + 0.14;
const STOP_X = JAW_X + 0.5 * 2.25 + 0.85;
const RPM = 9;

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
  pitch: 0.2,
  meanDiameter: 1,
  paused: reducedMotion,
  orbited: false,
  spin: 0.4,
  advance: 0.12,
  dir: 1,
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
let modelKey = '';

const labels = {
  thread: document.getElementById('label-thread'),
  pitch: document.getElementById('label-pitch'),
  effort: document.getElementById('label-effort'),
  load: document.getElementById('label-load'),
  ramp: document.getElementById('label-ramp'),
};

const parts = {
  mover: null,
  carriage: null,
  bead: null,
  effortArrow: null,
  anchors: {},
  ramp: { base: 1, height: 0.2 },
};

const mats = {};
const worldPoint = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);
const tangent = new THREE.Vector3();

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

function ensureMats() {
  if (mats.brass) return;
  mats.brass = houseMetal(0xe2c08a);
  mats.brassDark = houseMetal(0xc49a68);
  mats.iron = houseMetal(0x3a2a36, 0.12);
  mats.thread = houseMetal(0xe2c08a);
  mats.thread.side = THREE.DoubleSide;
  mats.accent = houseMetal(0xf0a05a, 0.3);
  mats.accent.emissive = new THREE.Color(0xff8a3a);
  mats.accent.emissiveIntensity = 0.42;
  mats.ramp = houseMetal(0x6a5344, 0.16);
  mats.ramp.side = THREE.DoubleSide;
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
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI / 1.65;
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  frameCamera(true);
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
  keyLight = new THREE.PointLight(0xffb07a, 140, 0, 2);
  keyLight.position.set(2.4, 3.4, 5.4);
  scene.add(keyLight);
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
  });
}

function threadProfile(meanRadius, pitch) {
  const radial = Math.max(0.07, Math.min(meanRadius * 0.42, pitch * 0.85));
  const rRoot = Math.max(0.08, meanRadius - radial * 0.55);
  const rCrest = meanRadius + radial * 0.45;
  return { radial, rRoot, rCrest };
}

function createThreadGeometry(meanRadius, pitch) {
  const { rRoot, rCrest } = threadProfile(meanRadius, pitch);
  const profile = [
    { r: rRoot, u: -pitch * 0.44 },
    { r: rCrest, u: -pitch * 0.16 },
    { r: rCrest, u: pitch * 0.16 },
    { r: rRoot, u: pitch * 0.44 },
  ];
  const inset = pitch * 0.48;
  const span = Math.max(pitch, THREAD_LEN - inset * 2);
  const turns = span / pitch;
  const steps = Math.max(96, Math.ceil(turns * 32));
  const nProf = profile.length;
  const positions = [];
  const indices = [];

  for (let i = 0; i <= steps; i += 1) {
    const s = inset + (i / steps) * span;
    const theta = (s / pitch) * TAU;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (const point of profile) {
      positions.push(
        THREAD_X0 + s + point.u,
        point.r * cos,
        point.r * sin,
      );
    }
  }

  for (let i = 0; i < steps; i += 1) {
    for (let k = 0; k < nProf - 1; k += 1) {
      const a = i * nProf + k;
      const b = a + 1;
      const c = a + nProf;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

class HelixCurve extends THREE.Curve {
  constructor(radius, pitch, x0, turns) {
    super();
    this.radius = radius;
    this.pitch = pitch;
    this.x0 = x0;
    this.turns = turns;
  }

  getPoint(t, target = new THREE.Vector3()) {
    const theta = t * this.turns * TAU;
    const x = this.x0 + t * this.turns * this.pitch;
    return target.set(x, Math.cos(theta) * this.radius, Math.sin(theta) * this.radius);
  }
}

function makeArrow() {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1, 12), mats.accent);
  shaft.position.y = 0.5;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 14), mats.accent);
  head.position.y = 1.08;
  group.add(shaft, head);
  return group;
}

function pointArrow(arrow, direction) {
  tangent.copy(direction).normalize();
  arrow.quaternion.setFromUnitVectors(yAxis, tangent);
}

function addAnchor(parent, name, x, y, z) {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  parent.add(anchor);
  parts.anchors[name] = anchor;
  return anchor;
}

function buildModel() {
  ensureMats();
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
  }
  parts.anchors = {};
  const solved = solve(state.pitch, state.meanDiameter);
  const meanRadius = solved.meanDiameter / 2;
  const { rRoot, rCrest } = threadProfile(meanRadius, solved.pitch);
  rig = new THREE.Group();
  rig.name = 'screw-bench';
  scene.add(rig);

  const slideLen = STOP_X - 0.15;
  const slide = new THREE.Mesh(new THREE.BoxGeometry(slideLen, 0.14, 0.62), mats.iron);
  slide.position.set(0.15 + slideLen / 2, -rCrest - 0.42, 0);
  rig.add(slide);

  const nutX = 1.62;
  const outer = rCrest + 0.38;
  const thick = 0.16;
  const depth = 0.46;
  const span = outer * 2 + thick;
  const bars = [
    [nutX, outer, 0, depth, thick, span],
    [nutX, -outer, 0, depth, thick, span],
    [nutX, 0, outer, depth, span, thick],
    [nutX, 0, -outer, depth, span, thick],
  ];
  for (const [x, y, z, w, h, d] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.iron);
    bar.position.set(x, y, z);
    rig.add(bar);
  }

  const stop = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.45, 1.12), mats.iron);
  stop.position.set(STOP_X, 0.08, 0);
  rig.add(stop);
  const stopPad = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.72, 0.58), mats.brassDark);
  stopPad.position.set(STOP_X - 0.1, 0.08, 0);
  rig.add(stopPad);

  parts.mover = new THREE.Group();
  parts.carriage = new THREE.Group();
  rig.add(parts.mover, parts.carriage);

  const coreLen = THREAD_LEN + 0.42;
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(rRoot * 0.94, rRoot * 0.94, coreLen, 40),
    mats.brassDark,
  );
  core.rotation.z = Math.PI / 2;
  core.position.x = THREAD_X0 + THREAD_LEN / 2 - 0.16;
  parts.mover.add(core);

  const thread = new THREE.Mesh(createThreadGeometry(meanRadius, solved.pitch), mats.thread);
  thread.name = 'thread';
  parts.mover.add(thread);

  const helix = new HelixCurve(rCrest + 0.012, solved.pitch, GAUGE_X - solved.pitch * 0.15, 1);
  const highlight = new THREE.Mesh(
    new THREE.TubeGeometry(helix, 72, 0.026, 8, false),
    mats.accent,
  );
  highlight.name = 'helix-turn';
  parts.mover.add(highlight);

  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(rRoot * 0.72, meanRadius * 0.78, 0.28, 24),
    mats.brass,
  );
  collar.rotation.z = Math.PI / 2;
  collar.position.x = THREAD_X0 - 0.2;
  parts.mover.add(collar);

  const tommy = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.45, 16), mats.brass);
  tommy.position.set(THREAD_X0 - 0.4, 0, 0);
  parts.mover.add(tommy);
  const knobGeo = new THREE.SphereGeometry(0.095, 18, 14);
  const knobA = new THREE.Mesh(knobGeo, mats.accent);
  knobA.position.set(THREAD_X0 - 0.4, 0.74, 0);
  const knobB = new THREE.Mesh(knobGeo, mats.accent);
  knobB.position.set(THREAD_X0 - 0.4, -0.74, 0);
  parts.mover.add(knobA, knobB);

  const theta = 0.7;
  const arrowR = rCrest + 0.16;
  parts.effortArrow = makeArrow();
  parts.effortArrow.position.set(
    GAUGE_X + solved.pitch * 0.5,
    Math.cos(theta) * arrowR,
    Math.sin(theta) * arrowR,
  );
  pointArrow(parts.effortArrow, new THREE.Vector3(0, -Math.sin(theta), Math.cos(theta)));
  parts.mover.add(parts.effortArrow);
  addAnchor(parts.effortArrow, 'effort', 0, 1.2, 0);
  addAnchor(parts.mover, 'thread', GAUGE_X - solved.pitch, rCrest + 0.02, 0);

  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.4, 1.08), mats.iron);
  jaw.position.set(JAW_X, 0.08, 0);
  parts.carriage.add(jaw);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.74, 0.6), mats.brass);
  pad.position.set(JAW_X + 0.1, 0.08, 0);
  parts.carriage.add(pad);
  const loadArrow = makeArrow();
  loadArrow.position.set(JAW_X + 0.18, 0.5, 0);
  pointArrow(loadArrow, new THREE.Vector3(1, 0, 0));
  loadArrow.scale.set(1, 1.05, 1);
  parts.carriage.add(loadArrow);
  addAnchor(loadArrow, 'load', 0, 1.15, 0);

  const ringGeo = new THREE.RingGeometry(rCrest + 0.05, rCrest + 0.1, 48);
  for (const x of [GAUGE_X, GAUGE_X + solved.pitch]) {
    const ring = new THREE.Mesh(ringGeo, mats.accent);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x;
    rig.add(ring);
  }
  const pitchBar = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.02, solved.pitch), 0.028, 0.028),
    mats.accent,
  );
  pitchBar.position.set(GAUGE_X + solved.pitch / 2, rCrest + 0.2, 0);
  rig.add(pitchBar);
  addAnchor(rig, 'pitch', GAUGE_X + solved.pitch / 2, rCrest + 0.38, 0);

  const base = solved.circumference;
  const height = solved.pitch;
  parts.ramp.base = base;
  parts.ramp.height = height;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(base, 0);
  shape.lineTo(base, height);
  shape.closePath();
  const ramp = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false }),
    mats.ramp,
  );
  ramp.position.set(0.45, rCrest + 0.72, 0);
  ramp.geometry.translate(0, 0, -0.04);
  rig.add(ramp);

  const hyp = Math.hypot(base, height);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(hyp, 0.035, 0.045), mats.accent);
  edge.position.set(base / 2, height / 2, 0.05);
  edge.rotation.z = Math.atan2(height, base);
  ramp.add(edge);
  const rise = new THREE.Mesh(new THREE.BoxGeometry(0.03, Math.max(height, 0.03), 0.04), mats.accent);
  rise.position.set(base, height / 2, 0.05);
  ramp.add(rise);
  const run = new THREE.Mesh(new THREE.BoxGeometry(base, 0.02, 0.03), mats.brassDark);
  run.position.set(base / 2, 0, 0.05);
  ramp.add(run);

  parts.bead = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), mats.accent);
  ramp.add(parts.bead);
  addAnchor(ramp, 'ramp', base * 0.5, height + 0.16, 0);

  applyMotion();
  modelKey = `${solved.pitch.toFixed(4)}|${solved.meanDiameter.toFixed(4)}`;
}

function travelLimit() {
  return state.pitch * 2.25;
}

function fracTurn(spin) {
  const turns = spin / TAU;
  return ((turns % 1) + 1) % 1;
}

function applyMotion() {
  if (!parts.mover) return;
  const limit = travelLimit();
  state.advance = Math.min(limit, Math.max(0, state.advance));
  parts.mover.position.x = state.advance;
  parts.mover.rotation.x = state.spin;
  parts.carriage.position.x = state.advance;
  const along = fracTurn(state.spin);
  parts.bead.position.set(along * parts.ramp.base, along * parts.ramp.height, 0.08);
  const solved = solve(state.pitch, state.meanDiameter);
  // Stay shorter than the 10 lb clamp arrow. Length still grows as pitch coarsens.
  const length = Math.min(1, Math.max(0.34, 0.26 + solved.effort * 0.4));
  parts.effortArrow.scale.set(1, length, 1);
}

function sceneBounds() {
  const solved = solve(state.pitch, state.meanDiameter);
  const { rCrest } = threadProfile(solved.meanDiameter / 2, solved.pitch);
  const rampTop = rCrest + 0.72 + solved.pitch + 0.28;
  const xMax = Math.max(STOP_X, 0.45 + solved.circumference) + 0.35;
  return {
    centerX: (-0.35 + xMax) / 2,
    centerY: (rampTop - 1.15) / 2,
    halfW: (xMax + 0.35) / 2,
    halfH: (rampTop + 1.15) / 2,
  };
}

function fitDistance(aspect) {
  const bounds = sceneBounds();
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const distH = bounds.halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.4, aspect));
  const distW = bounds.halfW / Math.tan(hFov / 2);
  return Math.max(distH, distW);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.45;
  const dist = fitDistance(aspect);
  const bounds = sceneBounds();
  controls.minDistance = dist * 0.82;
  controls.maxDistance = dist * 1.9;
  if (force || !state.orbited) {
    camera.position.set(bounds.centerX + 0.15, bounds.centerY + bounds.halfH * 0.22, dist);
    controls.target.set(bounds.centerX, bounds.centerY, 0);
    controls.update();
  }
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
    setStatus('Held still. Press play to turn the screw.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('Turning. One revolution moves the jaw one pitch.');
  else setStatus('Paused. Change the pitch and read the effort.');
}

function syncHud() {
  const solved = solve(state.pitch, state.meanDiameter);
  document.getElementById('ma-readout').innerHTML = `<em>${solved.ma.toFixed(2)}</em> : 1`;
  document.getElementById('ma-sub').textContent = 'circumference / pitch';
  document.getElementById('effort-line').innerHTML =
    `${formatPounds(solved.effort)} <span>effort · ${solved.load.toFixed(0)} lb clamp</span>`;
  document.getElementById('meter-pitch').innerHTML =
    `<b>${formatPitch(solved.pitch)}</b> · ${formatTpi(solved.tpi)}`;
  document.getElementById('meter-circ').innerHTML = `<b>${formatInches(solved.circumference)}</b>`;
  document.getElementById('meter-load').innerHTML = `<b>${solved.load.toFixed(0)} lb</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatPounds(solved.effort)}</b>`;
  document.getElementById('live-line').textContent =
    `${tradeSentence(solved)} Advantage ${formatMa(solved.ma)}.`;
  document.getElementById('lesson-numbers').textContent =
    `Mean circumference ${formatInches(solved.circumference)} ÷ pitch ${formatPitch(solved.pitch)} = ${formatMa(solved.ma)}. Tangential effort is ${formatPounds(solved.effort)} for a ${solved.load.toFixed(0)} lb clamp.`;
  document.getElementById('lesson-trade').textContent = tradeSentence(solved);
  document.getElementById('pitch-out').textContent = formatPitch(solved.pitch);
  document.getElementById('diameter-out').textContent = `${solved.meanDiameter.toFixed(2)} in`;
  const pitchLabel = labels.pitch && labels.pitch.querySelector('span');
  if (pitchLabel) pitchLabel.textContent = formatPitch(solved.pitch);
  const effortLabel = labels.effort && labels.effort.querySelector('span');
  if (effortLabel) effortLabel.textContent = formatPounds(solved.effort);
}

function markPreset() {
  let active = '';
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (Math.abs(preset.pitch - state.pitch) < 0.001 && Math.abs(preset.meanDiameter - state.meanDiameter) < 0.001) {
      active = name;
    }
  }
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === active));
  });
}

function readSliders() {
  state.pitch = Number(document.getElementById('pitch').value) / 1000;
  state.meanDiameter = Number(document.getElementById('diameter').value) / 1000;
}

function writeSliders() {
  document.getElementById('pitch').value = String(Math.round(state.pitch * 1000));
  document.getElementById('diameter').value = String(Math.round(state.meanDiameter * 1000));
}

function refreshModel() {
  const solved = solve(state.pitch, state.meanDiameter);
  const key = `${solved.pitch.toFixed(4)}|${solved.meanDiameter.toFixed(4)}`;
  state.advance = Math.min(travelLimit(), Math.max(0, state.advance));
  if (key !== modelKey) buildModel();
  else applyMotion();
  frameCamera(false);
  syncHud();
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.pitch = preset.pitch;
  state.meanDiameter = preset.meanDiameter;
  writeSliders();
  markPreset();
  refreshModel();
}

function stepOneTurn() {
  const limit = travelLimit();
  if (state.dir > 0 && state.advance + state.pitch > limit + 1e-4) state.dir = -1;
  if (state.dir < 0 && state.advance - state.pitch < -1e-4) state.dir = 1;
  state.spin += state.dir * TAU;
  state.advance = Math.min(limit, Math.max(0, state.advance + state.dir * state.pitch));
  applyMotion();
  setStatus('One turn. The jaw moved one pitch.');
}

function projectLabels() {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  for (const [id, anchor] of Object.entries(parts.anchors)) {
    const el = labels[id];
    if (!el || !anchor) continue;
    if (narrow && (id === 'thread' || id === 'ramp')) {
      el.hidden = true;
      continue;
    }
    anchor.getWorldPosition(worldPoint);
    worldPoint.project(camera);
    if (worldPoint.z > 1) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    const x = (worldPoint.x * 0.5 + 0.5) * rect.width;
    const y = (-worldPoint.y * 0.5 + 0.5) * rect.height;
    const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
    el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, x))}px`;
    el.style.top = `${Math.min(rect.height - 8, Math.max(18, y))}px`;
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
    const revPerSec = RPM / 60;
    const limit = travelLimit();
    state.spin += state.dir * revPerSec * TAU * dt;
    state.advance += state.dir * revPerSec * state.pitch * dt;
    if (state.advance >= limit) {
      state.advance = limit;
      state.dir = -1;
    } else if (state.advance <= 0) {
      state.advance = 0;
      state.dir = 1;
    }
  }
  applyMotion();
  controls.update();
  syncHud();
  renderView();
  projectLabels();
}

function bindUi() {
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  });
  document.getElementById('pitch').addEventListener('input', () => {
    readSliders();
    markPreset();
    refreshModel();
  });
  document.getElementById('diameter').addEventListener('input', () => {
    readSliders();
    markPreset();
    refreshModel();
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
  document.getElementById('step-turn').addEventListener('click', stepOneTurn);
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

function disposeMaterials() {
  for (const material of Object.values(mats)) material.dispose();
  mats.brass = null;
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
  disposeMaterials();
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
      disposeMaterials();
      disposeEnvironment();
      if (hemi) scene.remove(hemi);
      if (keyLight) scene.remove(keyLight);
      modelKey = '';
      buildEnvironment();
      buildLights();
      buildModel();
      contextLost = false;
      clock.getDelta();
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
buildModel();
bindUi();
writeSliders();
markPreset();
syncTransport();
syncHud();
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
window.addEventListener('resize', () => frameCamera(false));
renderer.setAnimationLoop(animate);

window.__SCREW = {
  state,
  solve,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  active: () => solve(state.pitch, state.meanDiameter),
};
