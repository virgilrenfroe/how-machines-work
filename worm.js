import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  MAX_STARTS,
  MAX_TEETH,
  MIN_STARTS,
  MIN_TEETH,
  SHAFT_NOTE,
  contactX,
  formatRatio,
  formatStarts,
  formatTeeth,
  holdSentence,
  inclineSentence,
  liveSentence,
  matchingPreset,
  outputRpm,
  paceWord,
  ratioLine,
  ratioSentence,
  shaftSentence,
  solvePreset,
  solveWorm,
  tipRadiusAt,
  trimNum,
  wheelAngle,
} from './worms.js';

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

const opening = solvePreset('fine');
const state = {
  solved: opening.solved,
  wormSpin: 0,
  rpm: 18,
  paused: reducedMotion,
  hold: opening.hold,
  drive: 'worm',
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

const labelNames = ['worm', 'wheel', 'cross'];
const labels = Object.fromEntries(labelNames.map((name) => [name, document.getElementById(`label-${name}`)]));
const anchors = {
  worm: new THREE.Vector3(),
  wheel: new THREE.Vector3(),
  cross: new THREE.Vector3(),
};
const camOffset = new THREE.Vector3();
const worldPoint = new THREE.Vector3();

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
  controls.minPolarAngle = 0.28;
  controls.maxPolarAngle = 1.45;
  controls.target.set(0, 0.4, 0);
  controls.addEventListener('start', () => {
    state.orbited = true;
  });
  clock = new THREE.Clock();
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
}

function frameCamera(force) {
  const solved = state.solved;
  const span = Math.max(solved.pitchR * 0.92, solved.length * 0.55) + 0.45;
  const target = new THREE.Vector3(-0.05, solved.pitchR * 0.82, 0.05);
  const fit = span * 1.05;
  controls.minDistance = fit * 0.55;
  controls.maxDistance = fit * 2.6;
  if (force || !state.orbited) {
    controls.target.copy(target);
    camera.position.set(target.x + span * 1.15, target.y + span * 0.38, target.z + span * 0.82);
    controls.update();
    return;
  }
  camOffset.copy(camera.position).sub(controls.target);
  const length = Math.min(controls.maxDistance, Math.max(controls.minDistance, camOffset.length()));
  if (camOffset.lengthSq() < 1e-6) camOffset.set(0.9, 0.4, 1.2);
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
  keyLight = new THREE.PointLight(0xffd2ae, 140, 0, 1.15);
  keyLight.position.set(1.4, 3.6, 3.8);
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

function meshFrom(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function wheelPoint(radius, angle, z) {
  return new THREE.Vector3(Math.sin(angle) * radius, Math.cos(angle) * radius, z);
}

function createWheelGeometry(solved) {
  const positions = [];
  const { teeth, step, rootR, faceHalf } = solved;
  const backlash = 0.3;
  const pitchHalf = (step / 4) * (1 - backlash);
  const tipHalf = pitchHalf * 0.62;
  const rootHalf = Math.min(step * 0.4, pitchHalf * 1.2);
  const sections = 8;
  const valleys = 3;

  for (let i = 0; i < teeth; i += 1) {
    const center = i * step;
    for (let s = 0; s < sections; s += 1) {
      const z0 = -faceHalf + (2 * faceHalf * s) / sections;
      const z1 = -faceHalf + (2 * faceHalf * (s + 1)) / sections;
      const t0 = tipRadiusAt(solved, z0);
      const t1 = tipRadiusAt(solved, z1);
      const aRL = wheelPoint(rootR, center - rootHalf, z0);
      const aTL = wheelPoint(t0, center - tipHalf, z0);
      const aTR = wheelPoint(t0, center + tipHalf, z0);
      const aRR = wheelPoint(rootR, center + rootHalf, z0);
      const bRL = wheelPoint(rootR, center - rootHalf, z1);
      const bTL = wheelPoint(t1, center - tipHalf, z1);
      const bTR = wheelPoint(t1, center + tipHalf, z1);
      const bRR = wheelPoint(rootR, center + rootHalf, z1);
      const radial = wheelPoint(1, center, 0);
      pushQuad(positions, aTL, aTR, bTR, bTL, radial);
      pushQuad(positions, aRL, aTL, bTL, bRL, new THREE.Vector3(-Math.cos(center), Math.sin(center), 0));
      pushQuad(positions, aTR, aRR, bRR, bTR, new THREE.Vector3(Math.cos(center), -Math.sin(center), 0));

      const next = center + step;
      const gap0 = center + rootHalf;
      const gap1 = next - rootHalf;
      for (let v = 0; v < valleys; v += 1) {
        const u0 = gap0 + ((gap1 - gap0) * v) / valleys;
        const u1 = gap0 + ((gap1 - gap0) * (v + 1)) / valleys;
        const p00 = wheelPoint(rootR, u0, z0);
        const p01 = wheelPoint(rootR, u1, z0);
        const p10 = wheelPoint(rootR, u0, z1);
        const p11 = wheelPoint(rootR, u1, z1);
        pushQuad(positions, p00, p01, p11, p10, wheelPoint(1, (u0 + u1) / 2, 0));
      }
    }

    const cap = (z, dir) => {
      const tip = tipRadiusAt(solved, z);
      const rL = wheelPoint(rootR, center - rootHalf, z);
      const tL = wheelPoint(tip, center - tipHalf, z);
      const tR = wheelPoint(tip, center + tipHalf, z);
      const rR = wheelPoint(rootR, center + rootHalf, z);
      pushQuad(positions, rL, tL, tR, rR, new THREE.Vector3(0, 0, dir));
    };
    cap(faceHalf, 1);
    cap(-faceHalf, -1);
  }

  return meshFrom(positions);
}

function wormLocal(x, radius, theta) {
  return new THREE.Vector3(x, radius * Math.cos(theta), radius * Math.sin(theta));
}

function createWormGeometry(solved) {
  const positions = [];
  const { lead, length, starts, wormRootR, wormTipR, wormPitchR, axialPitch } = solved;
  const turns = length / lead;
  const n = Math.max(32, Math.round(turns * 42));
  const halfAng = (axialPitch * 0.62 * 0.5) / wormPitchR;
  const tipScale = 0.68;

  for (let s = 0; s < starts; s += 1) {
    const phase = Math.PI + (s * TAU) / starts;
    for (let i = 0; i < n; i += 1) {
      const x0 = -length / 2 + (length * i) / n;
      const x1 = -length / 2 + (length * (i + 1)) / n;
      const th0 = (x0 / lead) * TAU + phase;
      const th1 = (x1 / lead) * TAU + phase;
      const aRL = wormLocal(x0, wormRootR, th0 - halfAng);
      const aTL = wormLocal(x0, wormTipR, th0 - halfAng * tipScale);
      const aTR = wormLocal(x0, wormTipR, th0 + halfAng * tipScale);
      const aRR = wormLocal(x0, wormRootR, th0 + halfAng);
      const bRL = wormLocal(x1, wormRootR, th1 - halfAng);
      const bTL = wormLocal(x1, wormTipR, th1 - halfAng * tipScale);
      const bTR = wormLocal(x1, wormTipR, th1 + halfAng * tipScale);
      const bRR = wormLocal(x1, wormRootR, th1 + halfAng);
      const outward = new THREE.Vector3(0, Math.cos(th0), Math.sin(th0));
      pushQuad(positions, aTL, bTL, bTR, aTR, outward);
      const flankL = new THREE.Vector3(0, Math.sin(th0), -Math.cos(th0));
      const flankR = new THREE.Vector3(0, -Math.sin(th0), Math.cos(th0));
      pushQuad(positions, aRL, bRL, bTL, aTL, flankL);
      pushQuad(positions, aTR, bTR, bRR, aRR, flankR);
    }
    for (const end of [-1, 1]) {
      const x = (end * length) / 2;
      const th = (x / lead) * TAU + phase;
      const rL = wormLocal(x, wormRootR, th - halfAng);
      const tL = wormLocal(x, wormTipR, th - halfAng * tipScale);
      const tR = wormLocal(x, wormTipR, th + halfAng * tipScale);
      const rR = wormLocal(x, wormRootR, th + halfAng);
      pushQuad(positions, rL, tL, tR, rR, new THREE.Vector3(end, 0, 0));
    }
  }

  return meshFrom(positions);
}

function makeArrow(direction, material) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.34, 0.035), material);
  shaft.position.y = 0.17;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.078, 0.15, 12), material);
  head.position.y = 0.4;
  group.add(shaft, head);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  return group;
}

function buildRig() {
  if (rig) {
    scene.remove(rig);
    disposeObject(rig);
    rig = null;
  }
  const solved = state.solved;
  rig = new THREE.Group();

  const wormMat = houseMetal(0xf0a05a, 0.28);
  wormMat.side = THREE.DoubleSide;
  const wheelMat = houseMetal(0xd7b184, 0.26);
  wheelMat.side = THREE.DoubleSide;
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

  const wheel = new THREE.Group();
  const wheelMesh = new THREE.Mesh(createWheelGeometry(solved), wheelMat);
  const blankH = solved.faceHalf * 1.92;
  const blank = new THREE.Mesh(
    new THREE.CylinderGeometry(solved.rootR * 0.985, solved.rootR * 0.985, blankH, 48),
    hubMat,
  );
  blank.rotation.x = Math.PI / 2;
  const bore = Math.max(0.12, solved.rootR * 0.28);
  const shaftLen = Math.max(0.85, solved.pitchR * 0.42);
  const wheelShaft = new THREE.Mesh(new THREE.CylinderGeometry(bore * 0.55, bore * 0.55, shaftLen, 20), shaftMat);
  wheelShaft.rotation.x = Math.PI / 2;
  wheelShaft.position.z = solved.faceHalf + shaftLen * 0.42;
  const flangeR = Math.min(0.46, Math.max(0.24, solved.rootR * 0.55));
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(flangeR, flangeR, 0.06, 28), wheelMat);
  flange.rotation.x = Math.PI / 2;
  flange.position.z = solved.faceHalf + 0.08;
  const tick = new THREE.Mesh(new THREE.BoxGeometry(flangeR * 0.9, 0.045, 0.045), markMat);
  tick.position.set(0, flangeR * 0.15, flange.position.z + 0.05);
  const toothMark = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 12), markMat);
  const markTooth = Math.min(3, solved.teeth - 1);
  const markAngle = markTooth * solved.step;
  const markR = tipRadiusAt(solved, 0) + 0.02;
  toothMark.position.copy(wheelPoint(markR, markAngle, 0));
  wheel.add(wheelMesh, blank, wheelShaft, flange, tick, toothMark);

  const worm = new THREE.Group();
  worm.position.y = solved.centerDist;
  const wormMesh = new THREE.Mesh(createWormGeometry(solved), wormMat);
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(solved.wormRootR, solved.wormRootR, solved.length, 40),
    hubMat,
  );
  core.rotation.z = Math.PI / 2;
  const wormShaftR = Math.max(0.07, solved.wormRootR * 0.42);
  const side = -solved.length / 2 - 0.72;
  const wormShaftLen = Math.max(0.48, -solved.length / 2 - side);
  const wormShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(wormShaftR, wormShaftR, wormShaftLen, 18),
    shaftMat,
  );
  wormShaft.rotation.z = Math.PI / 2;
  wormShaft.position.x = (-solved.length / 2 + side) / 2;
  const wheelR = 0.46;
  const hand = new THREE.Mesh(new THREE.TorusGeometry(wheelR, 0.038, 10, 28), wormMat);
  hand.rotation.y = Math.PI / 2;
  hand.position.x = side - 0.02;
  const spokes = [];
  for (let i = 0; i < 3; i += 1) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.04, wheelR * 1.65, 0.034), hubMat);
    spoke.position.x = hand.position.x;
    spoke.rotation.x = (i * TAU) / 3;
    spokes.push(spoke);
  }
  const threadMark = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 12), markMat);
  threadMark.position.copy(wormLocal(0, solved.wormTipR + 0.02, 0));
  worm.add(wormMesh, core, wormShaft, hand, threadMark, ...spokes);

  const span = solved.pitchR;
  const floorW = span * 3.1 + 1.4;
  const floorD = span * 2.2 + 1.1;
  const floorY = -span - 0.28;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(floorW, 0.1, floorD), floorMat);
  floor.position.set(0, floorY, 0);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(floorW * 0.62, 0.08, 0.62), standMat);
  foot.position.set(0, floorY + 0.08, -0.15);

  const rearZ = -(solved.faceHalf + 0.22);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, Math.max(0.9, span * 0.85), 0.12), standMat);
  post.position.set(-span * 0.22, floorY * 0.42, rearZ - 0.55);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.7), standMat);
  arm.position.set(-span * 0.1, 0, rearZ - 0.22);
  const bush = new THREE.Mesh(new THREE.TorusGeometry(bore * 0.55 + 0.045, 0.028, 8, 16), standMat);
  bush.position.set(0, 0, rearZ);
  const wormPost = new THREE.Mesh(new THREE.BoxGeometry(0.12, Math.max(0.8, solved.centerDist - floorY - 0.2), 0.12), standMat);
  wormPost.position.set(-solved.length * 0.28, (solved.centerDist + floorY) * 0.5, -0.95);
  const wormArm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.95), standMat);
  wormArm.position.set(-solved.length * 0.28, solved.centerDist, -0.48);
  const wormBush = new THREE.Mesh(new THREE.TorusGeometry(wormShaftR + 0.04, 0.026, 8, 16), standMat);
  wormBush.rotation.y = Math.PI / 2;
  wormBush.position.set(-solved.length * 0.42, solved.centerDist, 0);

  const wormArrow = makeArrow(new THREE.Vector3(0, 0, 1), arrowMat);
  wormArrow.position.set(hand.position.x, solved.centerDist + wheelR + 0.12, 0.02);
  const wheelArrow = makeArrow(new THREE.Vector3(-1, 0, 0), arrowMat);
  wheelArrow.position.set(-0.42, solved.pitchR * 0.78, solved.faceHalf + 0.62);

  rig.add(
    floor, foot, post, arm, bush, wormPost, wormArm, wormBush,
    wheel, worm, wormArrow, wheelArrow,
  );
  rig.userData = {
    wheel,
    worm,
    wormArrow,
    wheelArrow,
    wormMat,
    wheelMat,
    markMat,
    arrowMat,
    handX: hand.position.x,
    wheelR,
  };
  scene.add(rig);
  shapeKey = `${solved.starts}x${solved.teeth}`;
  anchors.worm.set(0, solved.centerDist + solved.wormTipR + 0.18, 0);
  anchors.wheel.set(-solved.pitchR * 0.15, solved.pitchR * 0.78, solved.faceHalf + 0.05);
  anchors.cross.set(solved.length * 0.22, solved.centerDist * 0.72, solved.faceHalf + 0.2);
  frameCamera(!state.orbited);
}

function drivingForward() {
  return state.drive === 'worm';
}

function holding() {
  return state.drive === 'wheel' && state.hold;
}

function applySpin() {
  if (!rig) return;
  const solved = state.solved;
  const spin = state.wormSpin;
  rig.userData.worm.rotation.x = spin;
  rig.userData.wheel.rotation.z = wheelAngle(spin, solved);
  const forward = drivingForward();
  const wormDir = new THREE.Vector3(0, 0, forward ? 1 : -1);
  const wheelDir = new THREE.Vector3(forward ? -1 : 1, 0, 0);
  rig.userData.wormArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wormDir);
  rig.userData.wheelArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wheelDir);
  const showArrows = !holding();
  rig.userData.wormArrow.visible = showArrows;
  rig.userData.wheelArrow.visible = showArrows;
}

function motionAllowed() {
  if (state.paused) return false;
  if (reducedMotion && !userAllowsMotion) return false;
  if (holding()) return false;
  return true;
}

function syncTransport() {
  const playBtn = document.getElementById('play-toggle');
  if (reducedMotion && !userAllowsMotion) {
    state.paused = true;
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-pressed', 'false');
    setStatus('Paused. Press play to turn the worm.');
    return;
  }
  playBtn.textContent = state.paused ? 'Play' : 'Pause';
  playBtn.setAttribute('aria-pressed', state.paused ? 'false' : 'true');
  if (holding()) {
    setStatus('The wheel holds. The worm does not turn.');
    return;
  }
  if (state.paused) setStatus('Paused on a meshed pose.');
  else if (state.drive === 'wheel') setStatus('The wheel is driving. The worm turns backward.');
  else setStatus('The worm is driving. The wheel creeps. Shafts cross at 90°.');
}

function syncHud() {
  const solved = state.solved;
  const wheelRpm = outputRpm(solved, state.rpm);
  document.getElementById('ratio-readout').innerHTML = `<em>${formatRatio(solved).replace(' : 1', '')}</em> : 1`;
  document.getElementById('ratio-sub').textContent = ratioLine(solved);
  document.getElementById('dir-line').innerHTML = `<b>${SHAFT_NOTE}</b> <span>shafts do not meet</span>`;
  document.getElementById('speed-line').textContent = holding()
    ? 'Wheel tries · the pair holds'
    : state.drive === 'wheel'
      ? `Wheel creeps backward · ${wheelRpm.toFixed(1)} rpm, worm at ${trimNum(state.rpm)} rpm`
      : `Wheel turns ${paceWord(solved)} · ${wheelRpm.toFixed(1)} rpm from ${trimNum(state.rpm)} in`;
  document.getElementById('meter-teeth').innerHTML = `<b>${formatTeeth(solved.teeth)}</b>`;
  document.getElementById('meter-starts').innerHTML = `<b>${formatStarts(solved.starts)}</b>`;
  document.getElementById('meter-ratio').innerHTML = `<b>${formatRatio(solved)}</b>`;
  document.getElementById('meter-shaft').innerHTML = `<b>${SHAFT_NOTE}</b>`;
  const wormTurns = state.wormSpin / TAU;
  const wheelTurns = wormTurns * solved.speedOut;
  document.getElementById('meter-turns').innerHTML =
    `worm <b>${wormTurns.toFixed(2)}</b><br>wheel <b>${wheelTurns.toFixed(2)}</b>`;
  document.getElementById('meter-reverse').innerHTML = state.hold
    ? '<b>Holds</b>'
    : '<b>Free reverse</b>';
  document.getElementById('live-line').textContent = liveSentence(solved, state.rpm, state.drive, state.hold);
  document.getElementById('lesson-ratio').textContent = ratioSentence(solved);
  document.getElementById('lesson-shaft').textContent = shaftSentence();
  document.getElementById('lesson-incline').textContent = inclineSentence(solved);
  document.getElementById('lesson-hold').textContent = holdSentence(state.hold);
  document.getElementById('teeth-out').textContent = formatTeeth(solved.teeth);
  document.getElementById('starts-out').textContent = formatStarts(solved.starts);
  document.getElementById('rpm-out').textContent = trimNum(state.rpm);
  if (labels.worm) labels.worm.querySelector('span').textContent = formatStarts(solved.starts);
  if (labels.wheel) {
    labels.wheel.querySelector('span').textContent = holding() ? 'Holds' : formatTeeth(solved.teeth);
  }
  if (labels.cross) labels.cross.querySelector('span').textContent = 'shafts';
  markPreset();
  markDrive();
  markHold();
}

function syncSliders() {
  const teeth = document.getElementById('teeth');
  const starts = document.getElementById('starts');
  const rpm = document.getElementById('rpm');
  if (document.activeElement !== teeth) teeth.value = String(state.solved.teeth);
  if (document.activeElement !== starts) starts.value = String(state.solved.starts);
  if (document.activeElement !== rpm) rpm.value = String(state.rpm);
}

function markPreset() {
  const id = matchingPreset(state.solved.starts, state.solved.teeth);
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.preset === id ? 'true' : 'false');
  });
}

function markDrive() {
  document.querySelectorAll('[data-drive]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.drive === state.drive ? 'true' : 'false');
  });
}

function markHold() {
  document.querySelectorAll('[data-hold]').forEach((button) => {
    const on = button.dataset.hold === '1';
    button.setAttribute('aria-pressed', on === state.hold ? 'true' : 'false');
  });
}

function commitSolved(solved, hold) {
  state.solved = solved;
  if (typeof hold === 'boolean') {
    state.hold = hold;
    state.drive = 'worm';
  }
  syncSliders();
  syncHud();
  const key = `${solved.starts}x${solved.teeth}`;
  if (rig && key !== shapeKey) buildRig();
  else applySpin();
  syncTransport();
}

function projectLabels() {
  if (!camera || !rig) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const narrow = rect.width < 640;
  const solved = state.solved;
  const wormLocalTop = new THREE.Vector3(0.15, solved.wormTipR + 0.16, 0);
  rig.userData.worm.localToWorld(worldPoint.copy(wormLocalTop));
  anchors.worm.copy(worldPoint);
  const wheelLocal = wheelPoint(solved.pitchR * 0.72, solved.step * 2, solved.faceHalf * 0.2);
  rig.userData.wheel.localToWorld(worldPoint.copy(wheelLocal));
  anchors.wheel.copy(worldPoint);
  anchors.cross.set(contactX(state.wormSpin, solved) * 0.15 + solved.length * 0.28, solved.pitchR * 0.55, solved.faceHalf + 0.28);

  const points = {
    worm: anchors.worm,
    wheel: anchors.wheel,
    cross: anchors.cross,
  };
  for (const name of labelNames) {
    const el = labels[name];
    if (!el) continue;
    if (narrow && name === 'cross') {
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
  if (motionAllowed()) {
    const step = (state.rpm * TAU / 60) * dt;
    state.wormSpin += state.drive === 'wheel' ? -step : step;
  }
  applySpin();
  controls.update();
  syncHud();
  projectLabels();
  renderView();
}

function readSolved() {
  return solveWorm({
    starts: Number(document.getElementById('starts').value),
    teeth: Number(document.getElementById('teeth').value),
  });
}

function bindUi() {
  document.getElementById('teeth').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('starts').addEventListener('input', () => {
    commitSolved(readSolved());
  });
  document.getElementById('rpm').addEventListener('input', () => {
    state.rpm = Number(document.getElementById('rpm').value);
    syncHud();
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = solvePreset(button.dataset.preset);
      commitSolved(next.solved, next.hold);
    });
  });
  document.querySelectorAll('[data-drive]').forEach((button) => {
    button.addEventListener('click', () => {
      state.drive = button.dataset.drive;
      syncHud();
      syncTransport();
    });
  });
  document.querySelectorAll('[data-hold]').forEach((button) => {
    button.addEventListener('click', () => {
      state.hold = button.dataset.hold === '1';
      syncHud();
      syncTransport();
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
    state.wormSpin = 0;
    syncHud();
    if (!holding()) setStatus('Reset. Both marks are back at the start of the turn.');
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

window.__WORM = {
  state,
  solveWorm,
  solvePreset,
  wheelAngle,
  contactX,
  tipRadiusAt,
  canvasCount: () => document.querySelectorAll('canvas').length,
  pixelRatio: () => (renderer ? renderer.getPixelRatio() : 0),
  MIN_TEETH,
  MAX_TEETH,
  MIN_STARTS,
  MAX_STARTS,
};
