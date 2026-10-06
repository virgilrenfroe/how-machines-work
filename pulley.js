import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  BEAM_H,
  BEAM_Y,
  CONFIG_META,
  HAUL_TRAVEL,
  LOAD_H,
  LOAD_W,
  layout,
  solve,
} from './pulleys.js';

const VOID = 0x140818;
const ROPE_R = 0.03;
const FRAME = { x: 0.02, y: 0.42, halfW: 1.42, halfH: 1.72 };

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
  config: 'fixed',
  parts: 4,
  paused: reducedMotion,
  orbited: false,
  time: Math.acos(0.2) / 0.62,
};

let renderer;
let scene;
let camera;
let controls;
let clock;
let hemi;
let keyLight;
let fillLight;
let envMap = null;
let pmrem = null;
let rig = null;
let built = null;
let topologyKey = '';
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;

const labelIds = ['fixed', 'movable', 'load', 'effort', 'standing'];
const labels = Object.fromEntries(labelIds.map((id) => [id, document.getElementById(`label-${id}`)]));
const partEls = [1, 2, 3, 4].map((n) => document.getElementById(`part-${n}`));

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
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = Math.PI / 1.7;
  controls.target.set(FRAME.x, FRAME.y, 0);
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
  const distH = FRAME.halfH / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.35, aspect));
  const distW = FRAME.halfW / Math.tan(hFov / 2);
  return Math.max(distH, distW) * 1.06;
}

function frameCamera(force) {
  const rect = view.getBoundingClientRect();
  const aspect = rect.width > 2 && rect.height > 2 ? rect.width / rect.height : 1.4;
  const dist = fitDistance(aspect);
  controls.minDistance = dist * 0.86;
  controls.maxDistance = dist * 1.9;
  if (force || !state.orbited) {
    camera.position.set(FRAME.x + 0.62, FRAME.y + 0.28, dist);
    controls.target.set(FRAME.x, FRAME.y, 0);
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
  keyLight = new THREE.PointLight(0xffb07a, 190, 0, 2);
  keyLight.position.set(0.8, 2.8, 5.2);
  scene.add(keyLight);
  fillLight = new THREE.PointLight(0xf4efe6, 36, 0, 2);
  fillLight.position.set(-2.6, 1.1, 3.4);
  scene.add(fillLight);
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

function makeSheaveSpin(radius, pulleyMat, axleMat, tickMat) {
  const spin = new THREE.Group();
  const diskGeo = new THREE.CylinderGeometry(radius * 0.74, radius * 0.74, 0.12, 48);
  diskGeo.rotateX(Math.PI / 2);
  const disk = new THREE.Mesh(diskGeo, pulleyMat);
  const hubGeo = new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, 0.18, 20);
  hubGeo.rotateX(Math.PI / 2);
  const hub = new THREE.Mesh(hubGeo, axleMat);
  const tick = new THREE.Mesh(new THREE.BoxGeometry(0.055, radius * 0.22, 0.03), tickMat);
  tick.position.set(radius * 0.58, 0, 0.08);
  spin.add(disk, hub, tick);
  return spin;
}

function makeArrow() {
  const group = new THREE.Group();
  const mat = houseMetal(0xf0a05a, 0.3);
  mat.emissive = new THREE.Color(0xff8a3a);
  mat.emissiveIntensity = 0.28;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.72, 12), mat);
  shaft.position.y = 0.36;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.26, 14), mat);
  head.position.y = 0.84;
  group.add(shaft, head);
  return group;
}

function placeArrow(arrow, x, yTip, dir, length) {
  const len = Math.max(0.22, length);
  arrow.scale.set(1, len, 1);
  arrow.visible = true;
  if (dir > 0) {
    arrow.rotation.set(0, 0, 0);
    arrow.position.set(x, yTip, 0.16);
  } else {
    arrow.rotation.set(Math.PI, 0, 0);
    arrow.position.set(x, yTip, 0.16);
  }
}

function arrowLength(force) {
  return Math.min(0.7, 0.24 + force * 0.046);
}

function placeLine(mesh, from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.max(0.001, Math.hypot(dx, dy));
  mesh.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0);
  mesh.scale.set(1, len, 1);
  mesh.rotation.z = -Math.atan2(dx, dy);
  mesh.visible = true;
}

function currentLift() {
  return 0.5 - 0.5 * Math.cos(state.time * 0.62);
}

function currentSpec() {
  return layout(state.config, state.parts, currentLift());
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
    built = null;
  }
  const spec = currentSpec();
  topologyKey = `${spec.solved.configId}:${spec.solved.supporting}`;
  rig = new THREE.Group();

  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(3.3, BEAM_H * 0.7, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x1a0c16, metalness: 0.08, roughness: 0.86, envMapIntensity: 0.05 }),
  );
  beam.position.set(0, BEAM_Y, -0.02);
  rig.add(beam);

  const bench = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.08, 1.35),
    new THREE.MeshStandardMaterial({ color: 0x160a1c, metalness: 0.06, roughness: 0.9, envMapIntensity: 0.04 }),
  );
  bench.position.set(0, -1.34, 0.08);
  rig.add(bench);

  const supportMat = houseMetal(0xf0a05a, 0.32);
  supportMat.emissive = new THREE.Color(0xff8a3a);
  supportMat.emissiveIntensity = 0.4;
  const haulMat = houseMetal(0xf4efe6, 0.16);
  haulMat.emissive = new THREE.Color(0xe7d7c8);
  haulMat.emissiveIntensity = 0.06;
  const redirectMat = houseMetal(0xd7a36a, 0.24);
  redirectMat.emissive = new THREE.Color(0xff8a3a);
  redirectMat.emissiveIntensity = 0.12;

  const lineGeo = new THREE.CylinderGeometry(ROPE_R, ROPE_R, 1, 12);
  const lines = spec.lines.map((item) => {
    const mat = item.role === 'haul' ? haulMat : supportMat;
    const mesh = new THREE.Mesh(lineGeo, mat);
    rig.add(mesh);
    return mesh;
  });

  const arcGeos = new Map();
  function arcGeo(radius) {
    const key = radius.toFixed(3);
    if (!arcGeos.has(key)) {
      arcGeos.set(key, new THREE.TorusGeometry(radius, ROPE_R, 8, 28, Math.PI));
    }
    return arcGeos.get(key);
  }

  const tickMat = houseMetal(0xffe2c0, 0.4);
  tickMat.emissive = new THREE.Color(0xff8a3a);
  tickMat.emissiveIntensity = 0.85;
  const axleMat = houseMetal(0x3a2a36, 0.1);
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0x2a1824, metalness: 0.12, roughness: 0.82, envMapIntensity: 0.06 });
  const pulleyMat = houseMetal(0xf0c48a, 0.34);
  pulleyMat.emissive = new THREE.Color(0xc47a3a);
  pulleyMat.emissiveIntensity = 0.22;

  const sheaveGroups = {};
  for (const wheel of spec.sheaves) {
    const group = new THREE.Group();
    const spin = makeSheaveSpin(wheel.r, pulleyMat, axleMat, tickMat);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 16), axleMat);
    axle.rotation.x = Math.PI / 2;
    group.add(spin, axle);
    group.position.set(wheel.x, wheel.y, wheel.z);
    rig.add(group);
    sheaveGroups[wheel.id] = { group, spin, role: wheel.role, r: wheel.r, spinSign: wheel.spinSign };
  }

  for (const arc of spec.arcs) {
    const host = sheaveGroups[arc.sheaveId];
    const mesh = new THREE.Mesh(
      arcGeo(host.r),
      arc.role === 'support' ? supportMat : redirectMat,
    );
    if (arc.half === 'bottom') mesh.rotation.z = Math.PI;
    host.group.add(mesh);
  }

  const cheeks = [];
  for (const block of spec.blocks) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.055), cheekMat);
    mesh.scale.set(block.w, block.h, 1);
    mesh.position.set(block.x, block.y, -0.12);
    rig.add(mesh);
    cheeks.push({ mesh, role: block.role });
  }

  const hangerMat = new THREE.MeshStandardMaterial({ color: 0x2a1824, metalness: 0.12, roughness: 0.82, envMapIntensity: 0.06 });
  for (const hanger of spec.hangers) {
    const height = Math.max(0.04, hanger.y0 - hanger.y1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, height, 0.08), hangerMat);
    mesh.position.set(hanger.x, (hanger.y0 + hanger.y1) / 2, -0.08);
    rig.add(mesh);
  }

  const eyeMat = houseMetal(0xe2c08a, 0.26);
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 8, 18), eyeMat);
  rig.add(eye);

  const loadMat = houseMetal(0xc49a68, 0.24);
  const loadMesh = new THREE.Mesh(new THREE.BoxGeometry(LOAD_W, LOAD_H, 0.32), loadMat);
  rig.add(loadMesh);
  const shackle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 10), axleMat);
  rig.add(shackle);

  const loadArrow = makeArrow();
  const effortArrow = makeArrow();
  rig.add(loadArrow, effortArrow);

  scene.add(rig);
  built = {
    lines,
    sheaveGroups,
    cheeks,
    eye,
    loadMesh,
    shackle,
    loadArrow,
    effortArrow,
    supportMat,
  };
  poseRig(spec);
}

function poseRig(spec) {
  if (!built) return;
  spec.lines.forEach((item, index) => {
    placeLine(built.lines[index], item.from, item.to);
  });
  const haul = spec.haul;
  for (const wheel of spec.sheaves) {
    const host = built.sheaveGroups[wheel.id];
    host.group.position.set(wheel.x, wheel.y, wheel.z);
    host.spin.rotation.z = host.spinSign * (haul / wheel.r);
  }
  spec.blocks.forEach((block, index) => {
    const cheek = built.cheeks[index];
    if (!cheek) return;
    cheek.mesh.position.set(block.x, block.y, -0.12);
    cheek.mesh.scale.set(block.w, block.h, 1);
  });
  if (spec.standing) {
    built.eye.visible = true;
    built.eye.position.set(spec.standing.x, spec.standing.y, 0);
  } else {
    built.eye.visible = false;
  }
  built.loadMesh.position.set(spec.load.x, spec.load.y, 0.02);
  if (spec.shackle) {
    const span = spec.shackle.y0 - spec.shackle.y1;
    built.shackle.visible = span > 0.02;
    built.shackle.scale.set(1, Math.max(0.02, span), 1);
    built.shackle.position.set(
      spec.shackle.x,
      (spec.shackle.y0 + spec.shackle.y1) / 2,
      0,
    );
  } else {
    built.shackle.visible = false;
  }
  const pulse = motionAllowed() ? 1 + 0.045 * Math.sin(state.time * 3.1) : 1;
  placeArrow(
    built.effortArrow,
    spec.effort.x,
    spec.effort.y,
    spec.effort.dir,
    arrowLength(spec.solved.effortForce) * pulse,
  );
  placeArrow(
    built.loadArrow,
    spec.load.x,
    spec.load.y - LOAD_H / 2,
    -1,
    arrowLength(spec.solved.loadForce),
  );
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
    setStatus('Paused. Choose a pulley, or press play to haul the rope.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('Hauling. The load rises slower when more parts hold it.');
  else setStatus('Paused. Switch the pulley and read the effort.');
}

function formatForce(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function syncHud(spec) {
  const solved = spec.solved;
  const meta = CONFIG_META[solved.configId];
  document.getElementById('ma-readout').innerHTML = `<em>${solved.ma.toFixed(solved.ma % 1 ? 2 : 0)}</em> : 1`;
  document.getElementById('pull-dir').textContent = solved.pull === 'up' ? 'Pull up' : 'Pull down';
  document.getElementById('meter-parts').innerHTML = `<b>${solved.supporting}</b>`;
  document.getElementById('meter-load').innerHTML = `<b>${solved.loadForce.toFixed(0)} lb</b>`;
  document.getElementById('meter-effort').innerHTML = `<b>${formatForce(solved.effortForce)} lb</b>`;
  document.getElementById('meter-rope').innerHTML = `<b>${solved.ropePerInch} in</b>`;
  document.getElementById('force-load').textContent = `${solved.loadForce.toFixed(0)} lb`;
  document.getElementById('force-effort').textContent = `${formatForce(solved.effortForce)} lb`;
  const partWord = solved.supporting === 1 ? 'part' : 'parts';
  document.getElementById('live-line').textContent =
    `${meta.name}. ${solved.supporting} supporting ${partWord}. A 10 lb load needs ${formatForce(solved.effortForce)} lb of effort.`;
  document.getElementById('lesson-order').textContent = `${meta.name}. ${meta.order} ${meta.shop}`;
  document.getElementById('lesson-trade').textContent =
    `${meta.between} Ideal advantage is ${solved.ma} : 1, so the effort is ${formatForce(solved.effortForce)} lb. The load rises 1 inch for every ${solved.ropePerInch} inches of rope.`;
  document.querySelectorAll('[data-config]').forEach((button) => {
    const id = button.dataset.config;
    const rowSolved = solve(id, id === 'tackle' ? state.parts : undefined);
    const pressed = id === state.config;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    const em = button.querySelector('em');
    if (em) em.textContent = `${rowSolved.ma} : 1`;
  });
  const partsInput = document.getElementById('parts');
  const locked = state.config !== 'tackle';
  partsInput.disabled = locked;
  partsInput.parentElement.classList.toggle('is-locked', locked);
  if (locked) {
    partsInput.min = '1';
    partsInput.value = String(solved.supporting);
  } else if (document.activeElement !== partsInput) {
    partsInput.value = String(state.parts);
    partsInput.min = '2';
  }
  document.getElementById('parts-out').textContent = String(solved.supporting);
  const effortLabel = labels.effort;
  if (effortLabel) {
    effortLabel.querySelector('span').textContent = `${formatForce(solved.effortForce)} lb`;
  }
  const fixedLabel = labels.fixed;
  const movableLabel = labels.movable;
  if (fixedLabel) {
    fixedLabel.querySelector('b').textContent = state.config === 'tackle' ? 'Fixed block' : 'Fixed';
    fixedLabel.querySelector('span').textContent = state.config === 'tackle' ? 'Stays put' : 'Changes direction';
  }
  if (movableLabel) {
    movableLabel.querySelector('b').textContent = state.config === 'tackle' ? 'Movable block' : 'Movable';
    movableLabel.querySelector('span').textContent = 'Rides with the load';
  }
}

function projectLabels(spec) {
  if (!camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const place = (el, x, y, yShift = -8) => {
    if (!el) return;
    if (x == null || y == null) {
      el.hidden = true;
      return;
    }
    const anchor = new THREE.Vector3(x, y, 0.12);
    anchor.project(camera);
    if (anchor.z > 1) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const px = (anchor.x * 0.5 + 0.5) * rect.width;
    const py = (-anchor.y * 0.5 + 0.5) * rect.height;
    const half = Math.min(el.offsetWidth * 0.5, Math.max(8, rect.width * 0.5 - 4));
    el.style.left = `${Math.min(rect.width - half - 4, Math.max(half + 4, px))}px`;
    el.style.top = `${Math.min(rect.height - 8, Math.max(18, py + yShift))}px`;
  };
  place(labels.fixed, spec.fixedLabel && spec.fixedLabel.x, spec.fixedLabel && spec.fixedLabel.y);
  place(labels.movable, spec.movableLabel && spec.movableLabel.x, spec.movableLabel && spec.movableLabel.y);
  place(labels.load, spec.load.x, spec.load.y - 0.05, 18);
  place(labels.effort, spec.effort.x, spec.effort.y, spec.effort.dir > 0 ? -6 : 16);
  place(labels.standing, spec.standing && spec.standing.x, spec.standing && spec.standing.y, -4);
  const narrow = rect.width < 340;
  partEls.forEach((el, index) => {
    const badge = spec.parts[index];
    if (!el) return;
    if (!badge || narrow) {
      el.hidden = true;
      return;
    }
    place(el, badge.x, badge.y, 0);
  });
}

function setConfig(configId) {
  state.config = configId;
  const nextKey = `${configId}:${solve(configId, state.parts).supporting}`;
  if (nextKey !== topologyKey) buildRig();
  const spec = currentSpec();
  poseRig(spec);
  syncHud(spec);
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
  const spec = currentSpec();
  poseRig(spec);
  controls.update();
  syncHud(spec);
  projectLabels(spec);
  renderView();
}

function bindUi() {
  document.querySelectorAll('[data-config]').forEach((button) => {
    button.addEventListener('click', () => setConfig(button.dataset.config));
  });
  document.getElementById('parts').addEventListener('input', (event) => {
    if (state.config !== 'tackle') return;
    state.parts = Number(event.target.value);
    const nextKey = `tackle:${state.parts}`;
    if (nextKey !== topologyKey) buildRig();
    const spec = currentSpec();
    poseRig(spec);
    syncHud(spec);
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
  if (fillLight) scene.remove(fillLight);
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
        built = null;
      }
      disposeEnvironment();
      if (hemi) scene.remove(hemi);
      if (keyLight) scene.remove(keyLight);
      if (fillLight) scene.remove(fillLight);
      buildEnvironment();
      buildLights();
      topologyKey = '';
      buildRig();
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
buildRig();
bindUi();
syncTransport();
syncHud(currentSpec());
clock.getDelta();
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);
window.addEventListener('resize', () => frameCamera(false));
renderer.setAnimationLoop(animate);

window.__HPL = {
  state,
  solve,
  layout,
  canvasCount: () => document.querySelectorAll('canvas').length,
  spec: () => currentSpec(),
};
