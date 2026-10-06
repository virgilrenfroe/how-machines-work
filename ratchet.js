import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CONTACT,
  MAX_TEETH,
  MIN_TEETH,
  PAWL,
  PRESETS,
  backlash,
  directionLabel,
  formatStep,
  formatTeeth,
  holdSentence,
  liveSentence,
  matchingPreset,
  mod,
  nearestTooth,
  pawlLabel,
  pawlPose,
  solveRatchet,
  stepPhase,
  stepSentence,
  toothRadius,
} from './ratchets.js';

const VOID = 0x140818;
const STEP_TIME = 0.56;
const BLOCK_TIME = 0.7;
const SEAT_TIME = 0.28;
const FREE_RATE = 0.95;
const BOW = -0.2;

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
  solved: solveRatchet({ teeth: PRESETS.fine.teeth, lifted: false }),
  drive: 0,
  clicks: 0,
  playing: !reducedMotion,
  paused: reducedMotion,
  freeSign: 1,
  mode: 'idle',
  modeT: 0,
  from: 0,
  to: 0,
  blocking: false,
  orbited: false,
  blend: 0,
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

const labelNames = ['wheel', 'pawl', 'drive'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));
const anchors = {
  wheel: new THREE.Vector3(),
  pawl: new THREE.Vector3(),
  drive: new THREE.Vector3(),
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
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = Math.PI / 2.02;
  controls.target.set(0.02, 0.12, 0);
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
  const halfW = 1.85;
  const halfH = 1.7;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const distH = halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfW / Math.tan(hFov / 2);
  const dist = Math.max(distH, distW) * 1.02;
  controls.minDistance = dist * 0.72;
  controls.maxDistance = dist * 1.7;
  controls.target.set(0.02, 0.12, 0);
  if (force || !state.orbited) {
    camera.position.set(0.72, 0.95, dist);
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

function ratchetShape(teeth) {
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  const samples = 7;
  const pts = [];
  for (let i = 0; i < teeth; i += 1) {
    for (let s = 0; s < samples; s += 1) {
      const u = s / samples;
      const phase = (i + u) * step;
      const a = CONTACT + phase;
      const r = toothRadius(phase, teeth);
      pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
  }
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.2, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
}

function pawlCurve() {
  const pts = [];
  for (let i = 0; i <= 18; i += 1) {
    const t = i / 18;
    const lx = Math.sin(Math.PI * t) * BOW;
    const ly = -PAWL.length * t;
    pts.push(new THREE.Vector3(lx, ly, 0));
  }
  return new THREE.CatmullRomCurve3(pts);
}

function makeArrow(material) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.34, 0.045), material);
  shaft.position.y = 0.16;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 14), material);
  head.position.y = 0.4;
  group.add(shaft, head);
  return group;
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
  const wheelMat = houseMetal(0xf0a05a, 0.28);
  const pawlMat = houseMetal(0xd7b184, 0.26);
  pawlMat.emissive = new THREE.Color(0xf0a05a);
  pawlMat.emissiveIntensity = 0.12;
  const shaftMat = houseMetal(0xc9b59a, 0.2);
  const crankMat = houseMetal(0xe7b07a, 0.26);
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
  const arrowMat = houseMetal(0xf0a05a, 0.3);
  arrowMat.emissive = new THREE.Color(0xff8a3a);
  arrowMat.emissiveIntensity = 0.45;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 2.8), floorMat);
  floor.position.set(0.05, -1.72, -0.05);

  const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.32), standMat);
  pillow.position.set(0, -0.02, -0.58);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.55, 0.16), standMat);
  legL.position.set(-0.22, -0.92, -0.58);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.55, 0.16), standMat);
  legR.position.set(0.22, -0.92, -0.58);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 0.7), standMat);
  foot.position.set(0.15, -1.64, -0.42);

  const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.22, 0.16), standMat);
  post.position.set(1.08, -0.06, -0.58);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.14), standMat);
  bridge.position.set((1.08 + PAWL.pivotX) / 2, PAWL.pivotY, -0.28);
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.86, 16), shaftMat);
  pin.rotation.x = Math.PI / 2;
  pin.position.set(PAWL.pivotX, PAWL.pivotY, -0.16);

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.15, 24), shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.12;
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 6), shaftMat);
  nut.rotation.x = Math.PI / 2;
  nut.position.z = 0.22;

  const wheel = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.BufferGeometry(), wheelMat);
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.05), tickMat);
  const crank = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.15, 0.06), crankMat);
  crank.position.set(0, -0.78, 0.2);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.28, 16), crankMat);
  grip.rotation.x = Math.PI / 2;
  grip.position.set(0, -1.32, 0.32);
  wheel.add(disc, mark, crank, grip);

  const pawl = new THREE.Group();
  pawl.position.set(PAWL.pivotX, PAWL.pivotY, 0.02);
  const arm = new THREE.Mesh(new THREE.TubeGeometry(pawlCurve(), 28, 0.03, 8, false), pawlMat);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 16), pawlMat);
  collar.rotation.x = Math.PI / 2;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.05), pawlMat);
  tail.position.y = 0.12;
  pawl.add(arm, collar, tail);

  const arrow = makeArrow(arrowMat);
  const arrowAngle = -0.22;
  const arrowR = 1.42;
  arrow.position.set(Math.cos(arrowAngle) * arrowR, Math.sin(arrowAngle) * arrowR, 0.2);
  const tangent = new THREE.Vector3(Math.sin(arrowAngle), -Math.cos(arrowAngle), 0).normalize();
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);

  rig.add(floor, pillow, legL, legR, foot, post, bridge, pin, shaft, nut, wheel, pawl, arrow);
  rig.userData = { wheel, disc, mark, pawl, pawlMat, arrow };
  scene.add(rig);
  shapeKey = '';
  reshape();
}

function reshape() {
  const teeth = state.solved.teeth;
  const key = String(teeth);
  if (key === shapeKey) return;
  shapeKey = key;
  const geo = new THREE.ExtrudeGeometry(ratchetShape(teeth), {
    depth: 0.2,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, -0.1);
  geo.computeVertexNormals();
  const disc = rig.userData.disc;
  disc.geometry.dispose();
  disc.geometry = geo;

  const step = (Math.PI * 2) / teeth;
  const phase = step * 0.86;
  const a = CONTACT + phase;
  const r = toothRadius(phase, teeth) + 0.02;
  rig.userData.mark.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.12);
  anchors.wheel.set(0, 1.28, 0.12);
  anchors.pawl.set(PAWL.pivotX - 0.08, PAWL.pivotY + 0.16, 0.1);
  if (!state.orbited) frameCamera(true);
}

function shownDrive() {
  if (state.mode !== 'block') return state.drive;
  const u = Math.min(1, state.modeT / BLOCK_TIME);
  let kick;
  if (u < 0.28) kick = u / 0.28;
  else if (u < 0.7) kick = 1;
  else kick = 1 - (u - 0.7) / 0.3;
  return state.drive - backlash(state.solved.teeth) * kick;
}

function applyPose(dt) {
  const targetBlend = state.solved.lifted ? 1 : 0;
  const rate = 1 - Math.exp(-dt * 9);
  state.blend += (targetBlend - state.blend) * (dt > 0 ? rate : 1);
  const drive = shownDrive();
  const pose = pawlPose(drive, state.solved.teeth, state.blend);
  const parts = rig.userData;
  parts.wheel.rotation.z = -drive;
  parts.pawl.rotation.z = pose.alpha;
  const dropping = !state.solved.lifted && state.mode === 'step' && state.modeT / STEP_TIME > 0.78;
  const holdingHard = state.blocking && state.mode === 'block';
  parts.pawlMat.emissiveIntensity = dropping || holdingHard ? 0.72 : 0.12;
  anchors.drive.set(Math.sin(-drive) * 1.2, -Math.cos(drive) * 1.2, 0.35);
}

function motionAllowed() {
  if (state.paused) return false;
  if (reducedMotion && !userAllowsMotion) return false;
  return true;
}

function beginStep() {
  const step = state.solved.stepRad;
  state.mode = 'step';
  state.modeT = 0;
  state.from = state.drive;
  state.to = state.drive + step;
  state.blocking = false;
  setStatus('Drive allowed. The pawl rides up the tooth and drops.');
}

function beginBlock() {
  state.mode = 'block';
  state.modeT = 0;
  state.blocking = true;
  state.playing = false;
  setStatus('Reverse blocked. The pawl is holding.');
  syncTransport();
}

function beginSeat(target) {
  state.mode = 'seat';
  state.modeT = 0;
  state.from = state.drive;
  state.to = target;
  state.blocking = false;
}

function beginFree(sign) {
  state.freeSign = sign;
  state.mode = 'free';
  state.blocking = false;
  setStatus(sign < 0
    ? 'Pawl lifted. The wheel turns the other way.'
    : 'Pawl lifted. The wheel turns freely.');
}

function syncTransport() {
  const playBtn = document.getElementById('play-toggle');
  if (reducedMotion && !userAllowsMotion) {
    state.paused = true;
    state.playing = false;
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-pressed', 'false');
    setStatus('Paused. Drive one step, or try reverse.');
    return;
  }
  playBtn.textContent = state.paused || !state.playing ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused || !state.playing ? 'false' : 'true');
  if (state.blocking) return;
  if (state.paused || !state.playing) setStatus('Paused. Drive one step, or try reverse.');
  else if (state.solved.lifted) {
    setStatus(state.freeSign < 0
      ? 'Pawl lifted. The wheel turns the other way.'
      : 'Pawl lifted. The wheel turns freely.');
  } else setStatus('Drive allowed. Reverse is blocked.');
}

function syncHud() {
  const solved = state.solved;
  document.getElementById('step-readout').innerHTML = `<em>${formatStep(solved.stepDeg)}</em>`;
  const dir = state.blocking ? 'Reverse blocked' : directionLabel(solved);
  const dirNote = solved.lifted ? 'freewheel' : (state.blocking ? 'pawl holding' : 'drive allowed');
  document.getElementById('dir-line').innerHTML = `<b>${dir}</b> <span>${dirNote}</span>`;
  document.getElementById('pawl-line').textContent = `${solved.teeth} steps per turn · pawl ${pawlLabel(solved).toLowerCase()}`;
  document.getElementById('meter-teeth').innerHTML = `<b>${formatTeeth(solved.teeth)}</b>`;
  document.getElementById('meter-step').innerHTML = `<b>${formatStep(solved.stepDeg)}</b>`;
  document.getElementById('meter-dir').innerHTML = `<b>${directionLabel(solved)}</b>`;
  document.getElementById('meter-pawl').innerHTML = `<b>${pawlLabel(solved)}</b>`;
  document.getElementById('live-line').textContent = liveSentence(solved);
  document.getElementById('lesson-step').textContent = stepSentence(solved);
  document.getElementById('lesson-hold').textContent = holdSentence(solved);
  document.getElementById('teeth-out').textContent = formatTeeth(solved.teeth);
  const turn = mod(state.drive, Math.PI * 2) / (Math.PI * 2);
  const clickLine = state.clicks === 1 ? '1 click' : `${state.clicks} clicks`;
  document.getElementById('meter-clicks').innerHTML = `<b>${clickLine}</b><br>${turn.toFixed(2)} of a turn`;
  labels.wheel.querySelector('span').textContent = `${solved.teeth} teeth · ${formatStep(solved.stepDeg)}`;
  labels.pawl.querySelector('span').textContent = solved.lifted ? 'Lifted' : 'Holding';
  labels.drive.querySelector('span').textContent = solved.lifted ? 'Either way' : 'Clockwise';
  markPreset();
}

function syncSliders() {
  const el = document.getElementById('teeth');
  if (document.activeElement !== el) el.value = String(state.solved.teeth);
}

function markPreset() {
  const id = matchingPreset(state.solved.teeth);
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.preset === id ? 'true' : 'false');
  });
  document.querySelectorAll('[data-pawl]').forEach((button) => {
    const on = button.dataset.pawl === (state.solved.lifted ? 'lifted' : 'engaged');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function commitSolved(solved, snap) {
  state.solved = solved;
  if (snap) {
    const next = nearestTooth(state.drive, solved.teeth);
    if (!solved.lifted) beginSeat(next);
    else state.drive = next;
  }
  if (solved.lifted && state.playing && !state.paused) beginFree(state.freeSign || 1);
  if (!solved.lifted && state.mode === 'free') state.mode = 'idle';
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
    if (narrow && name === 'drive') {
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

function advanceMotion(dt) {
  if (!motionAllowed()) return;
  if (state.mode === 'step') {
    state.modeT += dt;
    const u = Math.min(1, state.modeT / STEP_TIME);
    const phase = stepPhase(u);
    state.drive = state.from + (state.to - state.from) * phase;
    if (u >= 1) {
      state.drive = state.to;
      state.clicks += 1;
      state.mode = 'idle';
      state.blocking = false;
      if (state.playing && !state.solved.lifted) beginStep();
      else if (state.playing && state.solved.lifted) beginFree(state.freeSign || 1);
      else if (state.solved.lifted) setStatus('Pawl lifted. The wheel can turn either way.');
      else setStatus('The pawl is holding. Reverse is blocked.');
    }
    return;
  }
  if (state.mode === 'block') {
    state.modeT += dt;
    if (state.modeT >= BLOCK_TIME) {
      state.mode = 'idle';
      state.blocking = false;
      setStatus('The pawl is holding. Reverse is blocked.');
      syncTransport();
    }
    return;
  }
  if (state.mode === 'seat') {
    state.modeT += dt;
    const u = Math.min(1, state.modeT / SEAT_TIME);
    const e = u * u * (3 - 2 * u);
    state.drive = state.from + (state.to - state.from) * e;
    if (u >= 1) {
      state.drive = state.to;
      state.mode = 'idle';
      if (state.playing && !state.solved.lifted && motionAllowed()) beginStep();
    }
    return;
  }
  if (state.playing && state.solved.lifted) {
    if (state.mode !== 'free') beginFree(state.freeSign || 1);
    state.drive += dt * FREE_RATE * state.freeSign;
    return;
  }
  if (state.playing && !state.solved.lifted && state.mode === 'idle') beginStep();
}

function animate() {
  if (!visible || contextLost || tornDown) return;
  const dt = Math.min(0.05, clock.getDelta());
  advanceMotion(dt);
  if (rig) applyPose(dt || 0.016);
  controls.update();
  syncHud();
  projectLabels();
  renderView();
}

function readTeeth() {
  return solveRatchet({
    teeth: Number(document.getElementById('teeth').value),
    lifted: state.solved.lifted,
  });
}

function bindUi() {
  document.getElementById('teeth').addEventListener('input', () => {
    commitSolved(readTeeth(), true);
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.preset] || PRESETS.fine;
      commitSolved(solveRatchet({ teeth: preset.teeth, lifted: state.solved.lifted }), true);
    });
  });
  document.querySelectorAll('[data-pawl]').forEach((button) => {
    button.addEventListener('click', () => {
      const lifted = button.dataset.pawl === 'lifted';
      commitSolved(solveRatchet({ teeth: state.solved.teeth, lifted }), !lifted);
    });
  });
  document.getElementById('drive-step').addEventListener('click', () => {
    if (reducedMotion && !userAllowsMotion) userAllowsMotion = true;
    state.paused = false;
    state.playing = false;
    state.freeSign = 1;
    state.blocking = false;
    if (state.mode !== 'step') {
      state.mode = 'step';
      state.modeT = 0;
      state.from = state.drive;
      state.to = state.drive + state.solved.stepRad;
    }
    syncTransport();
    setStatus(state.solved.lifted
      ? 'Pawl lifted. The wheel steps freely.'
      : 'Drive allowed. The pawl rides up the tooth and drops.');
  });
  document.getElementById('try-reverse').addEventListener('click', () => {
    if (reducedMotion && !userAllowsMotion) userAllowsMotion = true;
    state.paused = false;
    if (state.solved.lifted) {
      state.playing = true;
      beginFree(-1);
      syncTransport();
      return;
    }
    state.playing = false;
    if (state.mode === 'step') {
      state.drive = state.from;
      state.mode = 'idle';
    }
    beginBlock();
  });
  document.getElementById('play-toggle').addEventListener('click', () => {
    if (reducedMotion && !userAllowsMotion) {
      userAllowsMotion = true;
      state.paused = false;
      state.playing = true;
    } else if (state.playing && !state.paused) {
      state.playing = false;
      state.paused = true;
    } else {
      state.paused = false;
      state.playing = true;
      if (state.solved.lifted) beginFree(state.freeSign || 1);
    }
    state.blocking = false;
    syncTransport();
  });
  document.getElementById('reset-turns').addEventListener('click', () => {
    state.clicks = 0;
    state.drive = 0;
    state.mode = 'idle';
    state.blocking = false;
    state.freeSign = 1;
    syncHud();
    if (!state.playing) setStatus('Reset. The pale mark is back at the top.');
  });
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    event.preventDefault();
    state.playing = !(state.playing && !state.paused);
    state.paused = !state.playing;
    if (reducedMotion && state.playing) userAllowsMotion = true;
    if (state.playing && state.solved.lifted) beginFree(state.freeSign || 1);
    state.blocking = false;
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

window.__RATCHET = {
  state,
  solveRatchet,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  solved: () => state.solved,
  MIN_TEETH,
  MAX_TEETH,
  drive: () => state.drive,
  clicks: () => state.clicks,
};
