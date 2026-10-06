import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  MAX_TEETH,
  MIN_TEETH,
  PRESETS,
  SHAFT_TURN,
  cornerSentence,
  drivenAngle,
  formatRatio,
  formatTeeth,
  gearProfile,
  liveSentence,
  matchingPreset,
  outputRpm,
  paceWord,
  placeOnCone,
  ratioLine,
  ratioSentence,
  solveBevel,
  solvePreset,
} from './bevels.js';

const VOID = 0x140818;
const TAU = Math.PI * 2;

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
  solved: solvePreset('miter'),
  driverSpin: 0,
  rpm: 8,
  paused: reducedMotion,
  orbited: false,
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

const labelNames = ['driver', 'driven', 'corner'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));
const anchors = {
  driver: new THREE.Vector3(),
  driven: new THREE.Vector3(),
  corner: new THREE.Vector3(),
};
const spinPoint = new THREE.Vector3();
const camOffset = new THREE.Vector3();

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
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.pointerEvents = 'none';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID);
  camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);
  controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.35;
  controls.target.set(0, 0.2, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
}

function frameCamera(force) {
  const solved = state.solved;
  const span = Math.max(solved.cone * 1.15, solved.pitchDriver, solved.pitchDriven) + 1.35;
  const contact = placeOnCone('driver', solved.cone * 0.86, solved.deltaDriver, 0);
  const target = new THREE.Vector3(contact.x * 0.35, contact.y * 0.35, 0);
  const fit = span * 1.05;
  controls.minDistance = fit * 0.55;
  controls.maxDistance = fit * 2.4;
  if (force || !state.orbited) {
    controls.target.copy(target);
    camera.position.set(target.x + span * 0.22, target.y + span * 0.42, target.z + span * 1.18);
    controls.update();
    return;
  }
  camOffset.copy(camera.position).sub(controls.target);
  const length = Math.min(controls.maxDistance, Math.max(controls.minDistance, camOffset.length()));
  if (camOffset.lengthSq() < 1e-6) camOffset.set(0.2, 0.4, 1);
  camOffset.setLength(length);
  controls.target.copy(target);
  camera.position.copy(target).add(camOffset);
  controls.update();
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
  keyLight.position.set(1.4, 4.4, 6.4);
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

function pushTri(list, a, b, c, hint) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const flip = nx * hint.x + ny * hint.y + nz * hint.z < 0;
  const second = flip ? c : b;
  const third = flip ? b : c;
  list.push(a.x, a.y, a.z, second.x, second.y, second.z, third.x, third.y, third.z);
}

function pushQuad(list, a, b, c, d, hint) {
  pushTri(list, a, b, c, hint);
  pushTri(list, a, c, d, hint);
}

function tangentHint(role, phi, sign) {
  if (role === 'driver') {
    return new THREE.Vector3(0, -Math.sin(phi) * sign, Math.cos(phi) * sign);
  }
  return new THREE.Vector3(Math.sin(phi) * sign, 0, Math.cos(phi) * sign);
}

function createBevelGeometry(role, profile) {
  const positions = [];
  const away = role === 'driver' ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const toward = away.clone().multiplyScalar(-1);
  const { teeth, step, tipHalf, rootHalf, tipCone, rootCone, outer, inner } = profile;
  const at = (length, cone, phi) => {
    const point = placeOnCone(role, length, cone, phi);
    return new THREE.Vector3(point.x, point.y, point.z);
  };

  for (let i = 0; i < teeth; i += 1) {
    const center = i * step;
    const next = center + step;
    const oTL = at(outer, tipCone, center - tipHalf);
    const oTR = at(outer, tipCone, center + tipHalf);
    const oRL = at(outer, rootCone, center - rootHalf);
    const oRR = at(outer, rootCone, center + rootHalf);
    const iTL = at(inner, tipCone, center - tipHalf);
    const iTR = at(inner, tipCone, center + tipHalf);
    const iRL = at(inner, rootCone, center - rootHalf);
    const iRR = at(inner, rootCone, center + rootHalf);
    const tipHint = oTL.clone().add(oTR);
    if (role === 'driver') tipHint.x = 0;
    else tipHint.y = 0;

    pushQuad(positions, oRL, oRR, oTR, oTL, away);
    pushQuad(positions, iRR, iRL, iTL, iTR, toward);
    pushQuad(positions, oTL, oTR, iTR, iTL, tipHint);
    pushQuad(positions, oRL, oTL, iTL, iRL, tangentHint(role, center, -1));
    pushQuad(positions, oTR, oRR, iRR, iTR, tangentHint(role, center, 1));

    const valley = 4;
    const start = center + rootHalf;
    const end = next - rootHalf;
    for (let s = 0; s < valley; s += 1) {
      const a0 = start + ((end - start) * s) / valley;
      const a1 = start + ((end - start) * (s + 1)) / valley;
      const o0 = at(outer, rootCone, a0);
      const o1 = at(outer, rootCone, a1);
      const i0 = at(inner, rootCone, a0);
      const i1 = at(inner, rootCone, a1);
      const hint = o0.clone().add(o1);
      if (role === 'driver') hint.x = 0;
      else hint.y = 0;
      pushQuad(positions, o0, o1, i1, i0, hint);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeArrow(direction, material) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.32, 0.035), material);
  shaft.position.y = 0.16;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.14, 12), material);
  head.position.y = 0.38;
  group.add(shaft, head);
  const dir = direction.clone().normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return group;
}

function addGear(pivot, role, profile, materials) {
  const gear = new THREE.Mesh(createBevelGeometry(role, profile), materials.gear);

  const rootRadial = profile.outer * Math.sin(profile.rootCone);
  const heelAxial = profile.outer * Math.cos(profile.rootCone);
  const hubRadius = Math.max(0.16, rootRadial * 0.58);
  const hubLen = Math.max(0.16, profile.outer * 0.12);
  const shaftRadius = Math.max(0.07, hubRadius * 0.42);
  const shaftLen = Math.max(0.85, profile.outer * 0.62);
  const away = role === 'driver' ? -1 : 1;

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubRadius, hubRadius, hubLen, 28), materials.hub);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLen, 20), materials.shaft);
  const heel = new THREE.Mesh(
    new THREE.CylinderGeometry(rootRadial * 0.995, rootRadial * 0.995, 0.04, 40),
    materials.hub,
  );

  if (role === 'driver') {
    hub.rotation.z = Math.PI / 2;
    shaft.rotation.z = Math.PI / 2;
    heel.rotation.z = Math.PI / 2;
    const heelX = -heelAxial;
    heel.position.x = heelX - 0.03;
    hub.position.x = heelX - hubLen * 0.5 - 0.02;
    shaft.position.x = heelX - hubLen - shaftLen * 0.5;
    const wheelR = Math.min(0.52, Math.max(0.3, profile.outer * Math.sin(profile.pitch) * 0.62));
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(wheelR, 0.038, 10, 28), materials.gear);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.x = heelX - hubLen - shaftLen;
    pivot.add(wheel);
    for (let i = 0; i < 3; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.04, wheelR * 1.7, 0.035), materials.hub);
      spoke.position.x = wheel.position.x;
      spoke.rotation.x = (i * TAU) / 3;
      pivot.add(spoke);
    }
  } else {
    const heelY = heelAxial;
    heel.position.y = heelY + 0.03;
    hub.position.y = heelY + hubLen * 0.5 + 0.02;
    shaft.position.y = heelY + hubLen + shaftLen * 0.5;
    const flangeR = Math.min(0.48, Math.max(0.26, rootRadial * 0.72));
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(flangeR, flangeR, 0.07, 28), materials.gear);
    flange.position.y = heelY + hubLen + shaftLen;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(flangeR * 0.92, 0.05, 0.05), materials.mark);
    tick.position.y = flange.position.y + 0.05;
    pivot.add(flange, tick);
  }

  const markAt = placeOnCone(role, profile.outer * 0.94, profile.tipCone + 0.035, 0);
  const mark = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 12), materials.mark);
  mark.position.set(markAt.x, markAt.y, markAt.z);
  pivot.add(gear, hub, shaft, heel, mark);
  pivot.userData.away = away;
  pivot.userData.heel = heelAxial;
  pivot.userData.shaftEnd = hubLen + shaftLen;
  pivot.userData.shaftRadius = shaftRadius;
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
  }
  const solved = state.solved;
  const driverProfile = gearProfile(solved, 'driver');
  const drivenProfile = gearProfile(solved, 'driven');
  rig = new THREE.Group();

  const driverMat = houseMetal(0xf0a05a, 0.28);
  const drivenMat = houseMetal(0xd7b184, 0.26);
  const hubMat = houseMetal(0xc9b59a, 0.2);
  const shaftMat = houseMetal(0xb9a48c, 0.18);
  const standMat = houseMetal(0x3a2a34, 0.14);
  const markMat = new THREE.MeshPhysicalMaterial({
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
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x160a1c,
    metalness: 0.06,
    roughness: 0.9,
    envMapIntensity: 0.04,
  });

  const driver = new THREE.Group();
  const driven = new THREE.Group();
  addGear(driver, 'driver', driverProfile, { gear: driverMat, hub: hubMat, shaft: shaftMat, mark: markMat });
  addGear(driven, 'driven', drivenProfile, { gear: drivenMat, hub: hubMat, shaft: shaftMat, mark: markMat });

  const span = Math.max(solved.pitchDriver, solved.pitchDriven, solved.cone * 0.45);
  const floorW = span * 4.2 + 1.6;
  const floorD = span * 2.8 + 1.4;
  const floorY = -span - 0.85;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(floorW, 0.1, floorD), floorMat);
  floor.position.set(-span * 0.15, floorY, 0);

  const pillowX = -driverProfile.outer * Math.cos(driverProfile.rootCone) - driver.userData.shaftEnd * 0.62;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.36), standMat);
  cap.position.set(pillowX, -0.02, 0);
  const legH = Math.max(0.4, -floorY - 0.2);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.1, legH, 0.12), standMat);
  legL.position.set(pillowX - 0.12, floorY * 0.5, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.1, legH, 0.12), standMat);
  legR.position.set(pillowX + 0.12, floorY * 0.5, 0);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(floorW * 0.72, 0.08, 0.7), standMat);
  foot.position.set(-span * 0.2, floorY + 0.08, 0);

  const reach = Math.max(solved.pitchDriver, solved.pitchDriven);
  const backZ = -(reach + 0.72);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, Math.max(1.2, span * 2.1), 0.14), standMat);
  post.position.set(0.22, floorY * 0.35, backZ);
  const bushY = drivenProfile.outer * Math.cos(drivenProfile.rootCone) + driven.userData.shaftEnd * 0.55;
  const armLen = Math.abs(backZ) - 0.08;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, armLen), standMat);
  arm.position.set(0.1, bushY, backZ * 0.5 - 0.02);
  const bush = new THREE.Mesh(new THREE.TorusGeometry(driven.userData.shaftRadius + 0.05, 0.028, 8, 18), standMat);
  bush.rotation.x = Math.PI / 2;
  bush.position.set(0, bushY, 0);

  const driverArrow = makeArrow(new THREE.Vector3(0, -1, 0), arrowMat);
  driverArrow.position.set(pillowX, 0, driven.userData.shaftRadius + span * 0.28);
  const drivenArrow = makeArrow(new THREE.Vector3(1, 0, 0), arrowMat);
  drivenArrow.position.set(driven.userData.shaftRadius + 0.28, bushY + span * 0.15, span * 0.22);

  rig.add(floor, foot, cap, legL, legR, post, arm, bush, driver, driven, driverArrow, drivenArrow);
  rig.userData = { driver, driven, driverMat, drivenMat, markMat, arrowMat };
  scene.add(rig);
  shapeKey = `${solved.driver}x${solved.driven}`;
  anchors.driver.set(
    -driverProfile.outer * 0.55,
    driverProfile.outer * Math.sin(driverProfile.tipCone) * 0.72,
    0,
  );
  anchors.driven.set(
    -drivenProfile.outer * Math.sin(drivenProfile.tipCone) * 0.2,
    drivenProfile.outer * 0.72,
    0,
  );
  const contact = placeOnCone('driver', solved.cone * 0.8, solved.deltaDriver, 0);
  anchors.corner.set(contact.x, contact.y, contact.z + span * 0.15);
  frameCamera(!state.orbited);
}

function applySpin() {
  if (!rig) return;
  const solved = state.solved;
  rig.userData.driver.rotation.x = state.driverSpin;
  rig.userData.driven.rotation.y = drivenAngle(state.driverSpin, solved);
  spinPoint.copy(anchors.driver);
  spinPoint.applyAxisAngle(new THREE.Vector3(1, 0, 0), state.driverSpin);
  rig.userData.driverLabel = spinPoint.clone();
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
    setStatus('Paused. Press play to turn the shafts.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (state.paused) setStatus('Paused on a meshed pose.');
  else setStatus('Meshing. The driven shaft is at 90° to the driver.');
}

function syncHud() {
  const solved = state.solved;
  document.getElementById('ratio-readout').innerHTML = `<em>${solved.gearRatio.toFixed(2)}</em> : 1`;
  document.getElementById('ratio-sub').textContent = ratioLine(solved);
  document.getElementById('dir-line').innerHTML = `<b>${SHAFT_TURN}</b> <span>driven shaft</span>`;
  const out = outputRpm(solved, state.rpm);
  document.getElementById('speed-line').textContent =
    `Output turns ${paceWord(solved)} · ${out.toFixed(1)} rpm from ${state.rpm.toFixed(1).replace(/\.0$/, '')} in`;
  document.getElementById('meter-driver').innerHTML = `<b>${formatTeeth(solved.driver)}</b>`;
  document.getElementById('meter-driven').innerHTML = `<b>${formatTeeth(solved.driven)}</b>`;
  document.getElementById('meter-ratio').innerHTML = `<b>${formatRatio(solved)}</b>`;
  document.getElementById('meter-dir').innerHTML = `<b>${SHAFT_TURN}</b>`;
  const driverTurns = state.driverSpin / TAU;
  const drivenTurns = driverTurns * solved.speedOut;
  document.getElementById('meter-turns').innerHTML =
    `driver <b>${driverTurns.toFixed(2)}</b><br>driven <b>${drivenTurns.toFixed(2)}</b>`;
  document.getElementById('live-line').textContent = liveSentence(solved, state.rpm);
  document.getElementById('lesson-ratio').textContent = ratioSentence(solved);
  document.getElementById('lesson-corner').textContent = cornerSentence();
  document.getElementById('teeth-driver-out').textContent = formatTeeth(solved.driver);
  document.getElementById('teeth-driven-out').textContent = formatTeeth(solved.driven);
  document.getElementById('rpm-out').textContent = state.rpm.toFixed(1).replace(/\.0$/, '');
  if (labels.driver) labels.driver.querySelector('span').textContent = formatTeeth(solved.driver);
  if (labels.driven) labels.driven.querySelector('span').textContent = formatTeeth(solved.driven);
  if (labels.corner) labels.corner.querySelector('span').textContent = 'shafts';
  markPreset();
}

function syncSliders() {
  const driver = document.getElementById('teeth-driver');
  const driven = document.getElementById('teeth-driven');
  const rpm = document.getElementById('rpm');
  if (document.activeElement !== driver) driver.value = String(state.solved.driver);
  if (document.activeElement !== driven) driven.value = String(state.solved.driven);
  if (document.activeElement !== rpm) rpm.value = String(state.rpm);
}

function markPreset() {
  const id = matchingPreset(state.solved.driver, state.solved.driven);
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.preset === id ? 'true' : 'false');
  });
}

function commitSolved(solved) {
  state.solved = solved;
  syncSliders();
  syncHud();
  const key = `${solved.driver}x${solved.driven}`;
  if (rig && key !== shapeKey) buildRig();
}

function projectLabels() {
  if (!camera || !rig) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  const driverAnchor = anchors.driver.clone();
  driverAnchor.applyAxisAngle(new THREE.Vector3(1, 0, 0), state.driverSpin);
  const drivenAnchor = anchors.driven.clone();
  drivenAnchor.applyAxisAngle(new THREE.Vector3(0, 1, 0), drivenAngle(state.driverSpin, state.solved));
  const points = {
    driver: driverAnchor,
    driven: drivenAnchor,
    corner: anchors.corner,
  };
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && name === 'corner') {
      el.hidden = true;
      continue;
    }
    const anchor = points[name].clone().project(camera);
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
  if (motionAllowed()) state.driverSpin += (state.rpm * TAU / 60) * dt;
  applySpin();
  controls.update();
  syncHud();
  projectLabels();
  renderView();
}

function readSolved() {
  return solveBevel({
    driverTeeth: Number(document.getElementById('teeth-driver').value),
    drivenTeeth: Number(document.getElementById('teeth-driven').value),
  });
}

function bindUi() {
  document.getElementById('teeth-driver').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('teeth-driven').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('rpm').addEventListener('input', () => {
    state.rpm = Number(document.getElementById('rpm').value);
    syncHud();
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
  document.getElementById('reset-turns').addEventListener('click', () => {
    state.driverSpin = 0;
    syncHud();
    if (state.paused) setStatus('Reset. Both marks are back at the start of the turn.');
  });
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    event.preventDefault();
    if (reducedMotion && !userAllowsMotion) userAllowsMotion = true;
    state.paused = !state.paused;
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
      shapeKey = '';
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

window.__BEVEL = {
  state,
  solveBevel,
  solvePreset,
  gearProfile,
  placeOnCone,
  drivenAngle,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  MIN_TEETH,
  MAX_TEETH,
};
