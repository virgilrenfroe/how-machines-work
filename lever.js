import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BEAM,
  CLASS_META,
  effortDirection,
  solve,
  tradeSentence,
} from './levers.js';

const VOID = 0x140818;
const ROWS = [
  { classId: 1, y: 1.28 },
  { classId: 2, y: 0 },
  { classId: 3, y: -1.28 },
];

const errEl = document.getElementById('err');
const statusEl = document.getElementById('status');
const view = document.getElementById('view');
const canvas = document.getElementById('c');

function showErr(message) {
  errEl.style.display = 'block';
  errEl.textContent = String(message && message.message ? message.message : message);
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
  classId: 1,
  positions: {
    1: { effort: 0.62, load: 3.35 },
    2: { effort: 3.7, load: 1.35 },
    3: { effort: 1.2, load: 3.7 },
  },
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
let rigs = [];
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;
let pointerDown = null;

const labelIds = [];
for (const row of ROWS) {
  labelIds.push(`${row.classId}-fulcrum`, `${row.classId}-effort`, `${row.classId}-load`);
}
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
  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = Math.PI / 1.7;
  controls.target.set(BEAM / 2, 0, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  frameCamera(true);
}

function fitDistance(aspect) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const halfStack = 2.15;
  const halfBeam = BEAM / 2 + 0.55;
  const distH = halfStack / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = halfBeam / Math.tan(hFov / 2);
  return Math.max(distH, distW);
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.4;
  const dist = fitDistance(aspect);
  controls.minDistance = dist * 0.92;
  controls.maxDistance = dist * 1.85;
  if (force || !state.orbited) {
    camera.position.set(BEAM / 2, 0.35, dist);
    controls.target.set(BEAM / 2, 0, 0);
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
  hemi = new THREE.HemisphereLight(0xffe2c8, 0x120610, 0.62);
  scene.add(hemi);
  keyLight = new THREE.PointLight(0xffb07a, 160, 0, 2);
  keyLight.position.set(BEAM * 0.45, 2.6, 5.2);
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

function makeFulcrumGeo() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.28, 0);
  shape.lineTo(0.28, 0);
  shape.lineTo(0, 0.36);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.24, bevelEnabled: false });
  geo.translate(0, 0, -0.12);
  return geo;
}

function makeArrow() {
  const group = new THREE.Group();
  const mat = houseMetal(0xf0a05a, 0.3);
  mat.emissive = new THREE.Color(0xff8a3a);
  mat.emissiveIntensity = 0.28;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 12), mat);
  shaft.position.y = 0.36;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 14), mat);
  head.position.y = 0.86;
  group.add(shaft, head);
  group.userData.mat = mat;
  return group;
}

function placeArrow(arrow, x, yTip, z, dir, length) {
  const len = Math.max(0.2, length);
  arrow.scale.set(1, len, 1);
  if (dir > 0) {
    arrow.rotation.set(0, 0, 0);
    arrow.position.set(x, yTip - len, z);
  } else {
    arrow.rotation.set(Math.PI, 0, 0);
    arrow.position.set(x, yTip + len, z);
  }
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
  }
  rig = new THREE.Group();
  rigs = [];
  const fulcrumGeo = makeFulcrumGeo();
  const beamGeo = new THREE.BoxGeometry(BEAM, 0.12, 0.18);
  const loadGeo = new THREE.BoxGeometry(0.34, 0.26, 0.3);
  const markGeo = new THREE.SphereGeometry(0.09, 18, 14);

  for (const row of ROWS) {
    const group = new THREE.Group();
    group.position.y = row.y;
    const beamMat = houseMetal(0xe2c08a);
    const beam = new THREE.Mesh(beamGeo.clone(), beamMat);
    beam.position.set(BEAM / 2, 0, 0);
    beam.userData.classId = row.classId;
    const fulcrum = new THREE.Mesh(fulcrumGeo.clone(), houseMetal(0x3a2a36, 0.12));
    const loadMat = houseMetal(0xc49a68);
    const loadBlock = new THREE.Mesh(loadGeo.clone(), loadMat);
    const effortMat = houseMetal(0xffc48a);
    effortMat.emissive = new THREE.Color(0xff8a3a);
    effortMat.emissiveIntensity = 0.45;
    const effortMark = new THREE.Mesh(markGeo.clone(), effortMat);
    const loadArrow = makeArrow();
    const effortArrow = makeArrow();
    const armGeo = new THREE.BufferGeometry();
    armGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    const armLine = new THREE.LineSegments(
      armGeo,
      new THREE.LineBasicMaterial({ color: 0xf0a05a, transparent: true, opacity: 0.95 }),
    );
    group.add(beam, fulcrum, loadBlock, effortMark, loadArrow, effortArrow, armLine);
    rig.add(group);
    rigs.push({
      classId: row.classId,
      y: row.y,
      group,
      beam,
      beamMat,
      fulcrum,
      loadBlock,
      effortMark,
      effortMat,
      loadArrow,
      effortArrow,
      armLine,
    });
  }

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(BEAM + 1.4, 0.08, 1.15),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  plate.position.set(BEAM / 2, -1.95, 0.05);
  rig.add(plate);
  scene.add(rig);
  applyLayouts(1);
}

function arrowLength(force) {
  return Math.min(1.05, 0.26 + force * 0.042);
}

function applyLayouts(pulse) {
  for (const entry of rigs) {
    const pos = state.positions[entry.classId];
    const solved = solve(entry.classId, pos.effort, pos.load);
    state.positions[entry.classId] = { effort: solved.effort, load: solved.load };
    const active = entry.classId === state.classId;
    entry.beamMat.color.setHex(active ? 0xf0c48a : 0x8a6848);
    entry.beamMat.envMapIntensity = active ? 0.28 : 0.12;
    entry.effortMat.emissiveIntensity = active ? 0.55 : 0.18;
    const beamTop = 0.06;
    const beamBottom = -0.06;
    entry.fulcrum.position.set(solved.fulcrum, beamBottom - 0.36, 0);
    entry.loadBlock.position.set(solved.load, beamTop + 0.13, 0);
    entry.effortMark.position.set(solved.effort, beamTop + 0.02, 0.16);
    const loadLen = arrowLength(solved.loadForce);
    const effortLen = arrowLength(solved.effortForce) * (active ? pulse : 1);
    placeArrow(entry.loadArrow, solved.load, beamTop + 0.26, 0.22, -1, loadLen);
    const dir = effortDirection(entry.classId);
    const effortTip = dir < 0 ? beamTop + 0.16 : beamBottom - 0.02;
    placeArrow(entry.effortArrow, solved.effort, effortTip, 0.28, dir, effortLen);
    const positions = entry.armLine.geometry.attributes.position;
    const yArm = beamBottom - 0.16;
    const yLoad = beamBottom - 0.28;
    const write = (index, x, y) => {
      positions.setXYZ(index, x, y, 0.02);
    };
    write(0, solved.fulcrum, yArm);
    write(1, solved.effort, yArm);
    write(2, solved.fulcrum, yLoad);
    write(3, solved.load, yLoad);
    positions.needsUpdate = true;
    entry.armLine.visible = active;
    entry.solved = solved;
  }
}

function activeSolved() {
  const entry = rigs.find((item) => item.classId === state.classId);
  return entry ? entry.solved : solve(state.classId, state.positions[state.classId].effort, state.positions[state.classId].load);
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
    playBtn.textContent = 'Play motion';
    playBtn.setAttribute('aria-pressed', 'false');
    setStatus('Reduced motion is on. The levers hold still. Move the arms, or play motion if you want the effort arrow to breathe.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('Effort arrow breathing on the selected class.');
  else setStatus('Paused. Move the effort and the load.');
}

function formatForce(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function syncHud() {
  const solved = activeSolved();
  if (!solved) return;
  const meta = CLASS_META[solved.classId];
  document.getElementById('ma-readout').innerHTML = `<em>${solved.ma.toFixed(2)}</em> : 1`;
  document.getElementById('ma-sub').textContent = 'effort arm / load arm';
  document.getElementById('meter-effort-arm').innerHTML = `<b>${solved.effortArm.toFixed(2)}</b>`;
  document.getElementById('meter-load-arm').innerHTML = `<b>${solved.loadArm.toFixed(2)}</b>`;
  document.getElementById('meter-load').innerHTML = `<b>${solved.loadForce.toFixed(0)} lb</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatForce(solved.effortForce)} lb</b>`;
  document.getElementById('live-line').textContent =
    `${meta.name}. ${meta.order} ${tradeSentence(solved.classId, solved.ma)} A ${solved.loadForce.toFixed(0)} lb load needs ${formatForce(solved.effortForce)} lb of effort.`;
  document.getElementById('lesson-order').textContent = `${meta.name}. ${meta.order} ${meta.shop}`;
  document.getElementById('lesson-trade').textContent = tradeSentence(solved.classId, solved.ma);
  for (const row of ROWS) {
    const button = document.querySelector(`.class-rows button[data-class="${row.classId}"]`);
    const entry = rigs.find((item) => item.classId === row.classId);
    const ma = entry && entry.solved ? entry.solved.ma : solve(row.classId, state.positions[row.classId].effort, state.positions[row.classId].load).ma;
    button.setAttribute('aria-pressed', row.classId === state.classId ? 'true' : 'false');
    button.querySelector('em').textContent = `${ma.toFixed(2)} : 1`;
  }
  const effortOut = document.getElementById('effort-out');
  const loadOut = document.getElementById('load-out');
  effortOut.textContent = solved.effortArm.toFixed(2);
  loadOut.textContent = solved.loadArm.toFixed(2);
}

function syncSliders() {
  const pos = state.positions[state.classId];
  const solved = solve(state.classId, pos.effort, pos.load);
  const effortEl = document.getElementById('effort');
  const loadEl = document.getElementById('load');
  const toSlider = (value, range) => {
    const span = range[1] - range[0] || 1;
    return String(Math.round(((value - range[0]) / span) * 1000));
  };
  if (document.activeElement !== effortEl) effortEl.value = toSlider(solved.effort, solved.ranges.effort);
  if (document.activeElement !== loadEl) loadEl.value = toSlider(solved.load, solved.ranges.load);
}

function setClass(classId) {
  state.classId = classId;
  syncSliders();
  applyLayouts(1);
  syncHud();
}

function sliderToX(slider, range) {
  const t = Number(slider) / 1000;
  return range[0] + t * (range[1] - range[0]);
}

function projectLabels() {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  for (const entry of rigs) {
    const solved = entry.solved;
    if (!solved) continue;
    const active = entry.classId === state.classId;
    const spots = {
      fulcrum: { x: solved.fulcrum, y: entry.y - 0.72 },
      effort: { x: solved.effort, y: entry.y + (effortDirection(entry.classId) < 0 ? 1.05 : -0.95) },
      load: { x: solved.load, y: entry.y + 1.05 },
    };
    if (Math.abs(solved.effort - solved.load) < 0.7) spots.load.y += 0.35;
    for (const part of ['fulcrum', 'effort', 'load']) {
      const el = labels[`${entry.classId}-${part}`];
      if (!el) continue;
      if (narrow && !active) {
        el.hidden = true;
        continue;
      }
      const anchor = new THREE.Vector3(spots[part].x, spots[part].y, 0.2);
      anchor.project(camera);
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
  const pulse = motionAllowed() ? 1 + 0.06 * Math.sin(state.time * 3) : 1;
  applyLayouts(pulse);
  controls.update();
  syncHud();
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
  const hits = ray.intersectObjects(rigs.map((entry) => entry.beam), false);
  if (!hits.length) return;
  const classId = hits[0].object.userData.classId;
  if (classId) setClass(classId);
}

function bindUi() {
  document.querySelectorAll('.class-rows button').forEach((button) => {
    button.addEventListener('click', () => setClass(Number(button.dataset.class)));
  });
  document.getElementById('effort').addEventListener('input', () => {
    const pos = state.positions[state.classId];
    const preview = solve(state.classId, pos.effort, pos.load);
    const effort = sliderToX(document.getElementById('effort').value, preview.ranges.effort);
    const solved = solve(state.classId, effort, pos.load);
    state.positions[state.classId] = { effort: solved.effort, load: solved.load };
    syncSliders();
    applyLayouts(1);
    syncHud();
  });
  document.getElementById('load').addEventListener('input', () => {
    const pos = state.positions[state.classId];
    const preview = solve(state.classId, pos.effort, pos.load);
    const load = sliderToX(document.getElementById('load').value, preview.ranges.load);
    const solved = solve(state.classId, pos.effort, load);
    state.positions[state.classId] = { effort: solved.effort, load: solved.load };
    syncSliders();
    applyLayouts(1);
    syncHud();
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
  setStatus('WebGL context lost. The levers will rebuild when the context returns.');
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
      setStatus('WebGL context restored.');
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

window.__HLV = {
  state,
  solve,
  canvasCount: () => document.querySelectorAll('canvas').length,
  active: () => activeSolved(),
  all: () => rigs.map((entry) => entry.solved),
};
