import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  FACE,
  MODULE,
  angleFor,
  createSpurGearGeometry,
  layoutTrain,
  ratioInfo,
} from './gears.js';

const TAU = Math.PI * 2;
const VOID = 0x140818;

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
  driverTeeth: 16,
  idlerTeeth: 24,
  drivenTeeth: 40,
  showIdler: true,
  showPitch: true,
  paused: reducedMotion,
  rpm: 7,
  driverSpin: 0,
};

const presets = {
  reducer: { driverTeeth: 16, idlerTeeth: 24, drivenTeeth: 40, showIdler: true },
  even: { driverTeeth: 20, idlerTeeth: 20, drivenTeeth: 20, showIdler: true },
  overdrive: { driverTeeth: 36, idlerTeeth: 18, drivenTeeth: 18, showIdler: true },
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
let trainGroup = null;
let layout = null;
let frameHandle = 0;
let contextLost = false;
let tornDown = false;
let visible = !document.hidden;
let rebuildTimer = 0;

const labels = {
  driver: document.getElementById('label-driver'),
  idler: document.getElementById('label-idler'),
  driven: document.getElementById('label-driven'),
};

function houseMetal(color) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.32,
    roughness: 0.45,
    clearcoat: 0.22,
    clearcoatRoughness: 0.4,
    anisotropy: 0,
    envMapIntensity: 0.38,
  });
}

function paintMark(color, emissive) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.05,
    roughness: 0.48,
    clearcoat: 0.22,
    clearcoatRoughness: 0.45,
    anisotropy: 0,
    emissive,
    emissiveIntensity: 0.55,
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
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(VOID, 1);
  renderer.autoClear = false;
  renderer.domElement.style.pointerEvents = 'none';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID);

  camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);
  camera.position.set(0.2, 1.8, 6.4);

  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = Math.PI / 1.7;
  controls.target.set(0, 0, 0);
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
  hemi = new THREE.HemisphereLight(0xffd7b4, 0x1a0a18, 0.72);
  scene.add(hemi);
  keyLight = new THREE.PointLight(0xffb07a, 90, 0, 2);
  keyLight.position.set(1.4, 3.2, 5.4);
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

function clearTrain() {
  if (!trainGroup) return;
  scene.remove(trainGroup);
  disposeObject(trainGroup);
  trainGroup = null;
}

function buildTrain() {
  clearTrain();
  layout = layoutTrain(state);
  trainGroup = new THREE.Group();
  trainGroup.name = 'gear-train';

  const colors = {
    driver: 0xd2ae74,
    idler: 0xc49b68,
    driven: 0xb8926a,
  };
  const markColors = {
    driver: [0xffc48a, 0xff8a3a],
    idler: [0xf0d2b4, 0xc4844a],
    driven: [0xffe3c2, 0xffb15a],
  };

  for (const role of layout.roles) {
    const built = createSpurGearGeometry(role.teeth);
    const gear = new THREE.Mesh(built.geometry, houseMetal(colors[role.role]));
    const pivot = new THREE.Group();
    pivot.position.set(role.x, 0, 0);
    pivot.userData.role = role.role;
    pivot.add(gear);

    const [markColor, markEmissive] = markColors[role.role];
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(MODULE * 0.95, MODULE * 0.2, FACE * 1.08),
      paintMark(markColor, markEmissive),
    );
    mark.position.set(role.pitchR * 0.78, 0, 0);
    pivot.add(mark);

    const axle = new THREE.Mesh(
      new THREE.CylinderGeometry(built.boreR * 0.72, built.boreR * 0.72, FACE * 2.15, 20),
      houseMetal(0x3a2a36),
    );
    axle.rotation.x = Math.PI / 2;
    axle.position.set(role.x, 0, 0);
    trainGroup.add(axle);
    trainGroup.add(pivot);
    role.pivot = pivot;

    if (state.showPitch) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(role.pitchR, MODULE * 0.045, 8, 72),
        new THREE.MeshBasicMaterial({ color: 0xf0a05a, transparent: true, opacity: 0.72 }),
      );
      ring.position.set(role.x, 0, FACE * 0.5 + 0.02);
      trainGroup.add(ring);
    }
  }

  if (state.showPitch) {
    for (const contact of layout.contacts) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(MODULE * 0.22, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffd7a8 }),
      );
      dot.position.set(contact.x, contact.y, FACE * 0.55);
      trainGroup.add(dot);
    }
    const span = layout.maxX - layout.minX;
    const axis = new THREE.Mesh(
      new THREE.BoxGeometry(span + MODULE, MODULE * 0.05, MODULE * 0.05),
      new THREE.MeshBasicMaterial({ color: 0xf0a05a, transparent: true, opacity: 0.45 }),
    );
    axis.position.set(0, 0, FACE * 0.5 + 0.03);
    trainGroup.add(axis);
  }

  const plateMat = houseMetal(0x24141e);
  const plateW = (layout.maxX - layout.minX) + 1.15;
  const plateH = layout.maxR * 2 + 1.05;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(plateW, plateH, 0.08), plateMat);
  plate.position.set(0, -0.05, -0.48);
  trainGroup.add(plate);

  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(plateW + 0.15, 0.12, 1.5),
    houseMetal(0x1a0e18),
  );
  plinth.position.set(0, -layout.maxR - 0.28, 0.12);
  trainGroup.add(plinth);

  scene.add(trainGroup);
  applySpin();
  placeKeyLight();
}

function placeKeyLight() {
  if (!layout || !keyLight) return;
  const span = Math.max(layout.maxX - layout.minX, layout.maxR * 2);
  keyLight.position.set(span * 0.05, layout.maxR * 0.65 + 1.4, span * 0.42 + 2.2);
  const distance = keyLight.position.length() + span;
  keyLight.intensity = 28 * distance * distance * 0.055;
}

function applySpin() {
  if (!layout) return;
  for (const role of layout.roles) {
    if (!role.pivot) continue;
    role.pivot.rotation.z = angleFor(role, state.driverSpin);
  }
}

function frameCamera(reset) {
  if (!layout) return;
  const span = Math.max(layout.maxX - layout.minX, layout.maxR * 2.2, 2.4);
  const target = new THREE.Vector3(0, -layout.maxR * 0.02, 0);
  if (reset) {
    camera.position.set(span * 0.04, span * 0.32, span * 0.86);
    controls.target.copy(target);
  } else {
    const dx = target.x - controls.target.x;
    const dy = target.y - controls.target.y;
    controls.target.copy(target);
    camera.position.x += dx;
    camera.position.y += dy;
  }
  controls.minDistance = span * 0.42;
  controls.maxDistance = span * 2.6;
  controls.update();
}

function directionPhrase(spinFactor) {
  if (spinFactor > 0) return 'counterclockwise';
  if (spinFactor < 0) return 'clockwise';
  return 'still';
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
    setStatus('Reduced motion is on. The train holds a meshed pose. Step one tooth, or play motion if you want it to turn.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (!state.paused) setStatus('Meshing. Pitch circles stay tangent while the teeth pass.');
  else setStatus('Paused on a meshed pose.');
}

function syncHud() {
  const info = ratioInfo(state.driverTeeth, state.drivenTeeth);
  const ratioEl = document.getElementById('ratio-readout');
  ratioEl.innerHTML = `<em>${info.gearRatio.toFixed(2)}</em> : 1`;
  document.getElementById('ratio-sub').textContent =
    `N driven / N driver = ${info.driven} / ${info.driver} = ${info.fractionNum}/${info.fractionDen}`;

  const driver = layout?.roles.find((role) => role.role === 'driver');
  const idler = layout?.roles.find((role) => role.role === 'idler');
  const driven = layout?.roles.find((role) => role.role === 'driven');
  const driverRpm = state.rpm;
  const drivenRpm = driverRpm * info.speedRatio;

  document.getElementById('meter-driver').innerHTML =
    `<b>${state.driverTeeth} T</b> · ${directionPhrase(driver ? driver.spinFactor : 1)}`;
  document.getElementById('meter-driven').innerHTML =
    `<b>${state.drivenTeeth} T</b> · ${directionPhrase(driven ? driven.spinFactor : 1)} · ${drivenRpm.toFixed(1)} rpm`;
  document.getElementById('meter-idler').innerHTML = state.showIdler
    ? `<b>${state.idlerTeeth} T</b> · ${directionPhrase(idler ? idler.spinFactor : -1)} · not in the ratio`
    : '<b>Out</b> · one mesh · directions oppose';

  const driverTurns = state.driverSpin / TAU;
  const drivenTurns = driverTurns * (driven ? driven.spinFactor : info.speedRatio);
  document.getElementById('meter-turns').innerHTML =
    `driver <b>${driverTurns.toFixed(2)}</b><br>driven <b>${drivenTurns.toFixed(2)}</b>`;

  const teethPassed = Math.abs(state.driverSpin) / TAU * state.driverTeeth;
  const speedWord = info.gearRatio > 1.02 ? 'slower, with more torque' : info.gearRatio < 0.98 ? 'faster, with less torque' : 'the same speed';
  document.getElementById('live-line').textContent =
    `${state.driverTeeth} driver teeth pass the mesh for every ${state.drivenTeeth} driven teeth. Output is ${info.speedRatio.toFixed(2)}× — ${speedWord}. Teeth crossed: ${teethPassed.toFixed(1)}.`;

  document.getElementById('lesson-idler').textContent = state.showIdler
    ? 'The idler reverses direction and cancels out of the ratio. Driver and driven turn the same way. Gear ratio still uses only N driven / N driver.'
    : 'Idler removed. One external mesh remains, so the driven gear turns opposite the driver. The ratio is still N driven / N driver.';

  document.getElementById('lesson-speed').textContent =
    `At ${driverRpm.toFixed(1)} driver rpm the driven gear runs at ${drivenRpm.toFixed(1)} rpm. Center distance follows the pitch radii (N × module / 2) so the pitch circles stay tangent.`;

  const driverOut = document.getElementById('teeth-driver-out');
  const idlerOut = document.getElementById('teeth-idler-out');
  const drivenOut = document.getElementById('teeth-driven-out');
  driverOut.textContent = `${state.driverTeeth} T`;
  idlerOut.textContent = `${state.idlerTeeth} T`;
  drivenOut.textContent = `${state.drivenTeeth} T`;
  document.getElementById('rpm-out').textContent = state.rpm.toFixed(1).replace(/\.0$/, '');
}

function projectLabels() {
  if (!layout || !camera) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  for (const role of layout.roles) {
    const el = labels[role.role];
    if (!el) continue;
    el.hidden = false;
    const sense = directionPhrase(role.spinFactor);
    const extra = role.role === 'idler' ? 'direction only' : `${role.teeth} T`;
    el.querySelector('span').textContent = narrow ? `${role.teeth} T` : `${extra} · ${sense}`;
    const anchor = new THREE.Vector3(role.x, role.outerR + MODULE * 1.1, 0);
    anchor.project(camera);
    if (anchor.z > 1) {
      el.hidden = true;
      continue;
    }
    const x = (anchor.x * 0.5 + 0.5) * rect.width;
    const y = (-anchor.y * 0.5 + 0.5) * rect.height;
    const pad = 8;
    const clampedX = Math.min(rect.width - pad, Math.max(pad, x));
    const clampedY = Math.min(rect.height - pad, Math.max(pad + 18, y));
    el.style.left = `${clampedX}px`;
    el.style.top = `${clampedY}px`;
  }
  if (!state.showIdler && labels.idler) labels.idler.hidden = true;
}

function updateRendererSize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pr = pixelRatioCap();
  const bufferW = Math.floor(width * pr);
  const bufferH = Math.floor(height * pr);
  if (canvas.width !== bufferW || canvas.height !== bufferH) {
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
    rect.bottom < 0 ||
    rect.top > canvasH ||
    rect.right < 0 ||
    rect.left > canvasW ||
    rect.width < 2 ||
    rect.height < 2
  ) {
    return;
  }

  const width = rect.width;
  const height = rect.height;
  const left = rect.left;
  const bottom = canvasH - rect.bottom;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setViewport(left, bottom, width, height);
  renderer.setScissor(left, bottom, width, height);
  renderer.render(scene, camera);
  view.classList.add('is-ready');
}

function animate() {
  if (!visible || contextLost || tornDown) return;
  const dt = Math.min(0.05, clock.getDelta());
  if (motionAllowed()) {
    state.driverSpin += (state.rpm * TAU / 60) * dt;
  }
  applySpin();
  controls.update();
  syncHud();
  projectLabels();
  renderView();
}

function scheduleRebuild(resetCamera) {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    buildTrain();
    frameCamera(resetCamera);
    syncHud();
  }, 40);
}

function clampTeeth(value) {
  return Math.max(8, Math.min(48, Math.round(Number(value))));
}

function readControls() {
  state.driverTeeth = clampTeeth(document.getElementById('teeth-driver').value);
  state.idlerTeeth = clampTeeth(document.getElementById('teeth-idler').value);
  state.drivenTeeth = clampTeeth(document.getElementById('teeth-driven').value);
  state.rpm = Number(document.getElementById('rpm').value);
}

function writeControls() {
  document.getElementById('teeth-driver').value = String(state.driverTeeth);
  document.getElementById('teeth-idler').value = String(state.idlerTeeth);
  document.getElementById('teeth-driven').value = String(state.drivenTeeth);
  document.getElementById('rpm').value = String(state.rpm);
  document.getElementById('idler-toggle').setAttribute('aria-pressed', String(state.showIdler));
  document.getElementById('idler-toggle').textContent = state.showIdler ? 'Idler in the train' : 'Idler removed';
  document.getElementById('pitch-toggle').setAttribute('aria-pressed', String(state.showPitch));
  document.getElementById('teeth-idler').disabled = !state.showIdler;
}

function markPreset() {
  let active = '';
  for (const [name, preset] of Object.entries(presets)) {
    const match = preset.driverTeeth === state.driverTeeth
      && preset.idlerTeeth === state.idlerTeeth
      && preset.drivenTeeth === state.drivenTeeth
      && preset.showIdler === state.showIdler;
    if (match) active = name;
  }
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === active));
  });
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  Object.assign(state, preset);
  writeControls();
  markPreset();
  scheduleRebuild(true);
}

function bindUi() {
  for (const id of ['teeth-driver', 'teeth-idler', 'teeth-driven']) {
    document.getElementById(id).addEventListener('input', () => {
      readControls();
      markPreset();
      syncHud();
      scheduleRebuild(false);
    });
  }
  document.getElementById('rpm').addEventListener('input', () => {
    readControls();
    syncHud();
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  });
  document.getElementById('idler-toggle').addEventListener('click', () => {
    state.showIdler = !state.showIdler;
    writeControls();
    markPreset();
    scheduleRebuild(false);
  });
  document.getElementById('pitch-toggle').addEventListener('click', () => {
    state.showPitch = !state.showPitch;
    writeControls();
    scheduleRebuild(false);
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
  document.getElementById('step-tooth').addEventListener('click', () => {
    state.driverSpin += TAU / state.driverTeeth;
    applySpin();
    syncHud();
  });
  document.getElementById('reset-turns').addEventListener('click', () => {
    state.driverSpin = 0;
    applySpin();
    syncHud();
    setStatus('Turn counters reset. The mesh phase is back at the start.');
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
  window.clearTimeout(rebuildTimer);
  if (renderer) renderer.setAnimationLoop(null);
  window.cancelAnimationFrame(frameHandle);
  clearTrain();
  disposeEnvironment();
  if (hemi) {
    scene.remove(hemi);
    hemi.dispose?.();
  }
  if (keyLight) {
    scene.remove(keyLight);
    keyLight.dispose?.();
  }
  if (controls) controls.dispose();
  if (renderer) renderer.dispose();
}

function onContextLost(event) {
  event.preventDefault();
  contextLost = true;
  if (renderer) renderer.setAnimationLoop(null);
  setStatus('WebGL context lost. The gear train will rebuild when the context returns.');
}

function onContextRestored() {
  window.setTimeout(() => {
    if (tornDown) return;
    try {
      clearTrain();
      disposeEnvironment();
      if (hemi) scene.remove(hemi);
      if (keyLight) scene.remove(keyLight);
      buildEnvironment();
      buildLights();
      buildTrain();
      frameCamera(false);
      contextLost = false;
      clock.getDelta();
      setStatus('WebGL context restored. Meshing again.');
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
buildTrain();
frameCamera(true);
bindUi();
writeControls();
syncTransport();
syncHud();
clock.getDelta();

document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', disposeAll);

renderer.setAnimationLoop(animate);

window.__HMW = {
  state,
  ratioInfo,
  get layout() { return layout; },
  canvasCount: () => document.querySelectorAll('canvas').length,
  get contextLost() { return contextLost; },
  get reducedMotion() { return reducedMotion; },
  stepTooth() {
    state.driverSpin += TAU / state.driverTeeth;
    applySpin();
    syncHud();
  },
  applyPreset,
};
