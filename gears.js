import * as THREE from 'three';

/** Shop module is constant so every gear shares the same tooth spacing. */
export const MODULE = 0.082;
export const FACE = 0.28;

const TAU = Math.PI * 2;

export function pitchRadius(teeth, module = MODULE) {
  return (module * teeth) / 2;
}

export function outerRadius(teeth, module = MODULE) {
  return pitchRadius(teeth, module) + module;
}

export function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/**
 * Gear ratio in the shop sense: N_driven / N_driver.
 * A 2.50 : 1 train means the driver turns 2.50 times for one driven turn.
 */
export function ratioInfo(driverTeeth, drivenTeeth) {
  const driver = Math.round(driverTeeth);
  const driven = Math.round(drivenTeeth);
  const g = gcd(driver, driven);
  const gearRatio = driven / driver;
  return {
    driver,
    driven,
    gearRatio,
    speedRatio: driver / driven,
    fractionNum: driven / g,
    fractionDen: driver / g,
  };
}

/**
 * Rotation that seats a tooth-space of this gear on the left, facing its partner.
 * Tooth 0 is centered on local +X. Space 0 sits half a pitch later.
 */
export function phaseFacingLeft(teeth) {
  return Math.PI * (teeth - 1) / teeth;
}

/**
 * Simple external gear train.
 * spinFactor is d(angle)/d(driverSpin). phase is the mesh offset at driverSpin = 0.
 * With an idler, driver and driven share a sign. Without it, the driven sign flips.
 */
export function layoutTrain({ driverTeeth, idlerTeeth, drivenTeeth, showIdler, module = MODULE }) {
  const n1 = driverTeeth;
  const n3 = drivenTeeth;
  const r1 = pitchRadius(n1, module);
  const r3 = pitchRadius(n3, module);
  const roles = [];

  roles.push({
    role: 'driver',
    label: 'Driver',
    teeth: n1,
    x: 0,
    pitchR: r1,
    outerR: r1 + module,
    spinFactor: 1,
    phase: 0,
  });

  if (showIdler) {
    const n2 = idlerTeeth;
    const r2 = pitchRadius(n2, module);
    const idlerPhase = phaseFacingLeft(n2);
    const phase3 = phaseFacingLeft(n3);
    roles.push({
      role: 'idler',
      label: 'Idler',
      teeth: n2,
      x: r1 + r2,
      pitchR: r2,
      outerR: r2 + module,
      spinFactor: -n1 / n2,
      phase: idlerPhase,
    });
    roles.push({
      role: 'driven',
      label: 'Driven',
      teeth: n3,
      x: r1 + r2 + r2 + r3,
      pitchR: r3,
      outerR: r3 + module,
      spinFactor: n1 / n3,
      phase: phase3 - idlerPhase * (n2 / n3),
    });
  } else {
    roles.push({
      role: 'driven',
      label: 'Driven',
      teeth: n3,
      x: r1 + r3,
      pitchR: r3,
      outerR: r3 + module,
      spinFactor: -n1 / n3,
      phase: phaseFacingLeft(n3),
    });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let maxR = 0;
  for (const role of roles) {
    minX = Math.min(minX, role.x - role.outerR);
    maxX = Math.max(maxX, role.x + role.outerR);
    maxR = Math.max(maxR, role.outerR);
  }
  const mid = (minX + maxX) / 2;
  for (const role of roles) role.x -= mid;

  const contacts = [];
  for (let i = 0; i < roles.length - 1; i += 1) {
    const left = roles[i];
    contacts.push({
      x: left.x + left.pitchR,
      y: 0,
      left: left.role,
      right: roles[i + 1].role,
    });
  }

  return {
    roles,
    contacts,
    minX: minX - mid,
    maxX: maxX - mid,
    maxR,
    centerX: 0,
  };
}

export function angleFor(role, driverSpin) {
  return driverSpin * role.spinFactor + role.phase;
}

/**
 * Spur profile in the XY plane, extruded along Z.
 * Linear tooth thickness is (1 − backlash) × (π m / 2), so unlike tooth counts still mesh.
 */
export function createSpurGearGeometry(teeth, module = MODULE, face = FACE) {
  const step = TAU / teeth;
  const pitchR = pitchRadius(teeth, module);
  const tipR = pitchR + module;
  const rootR = Math.max(module * 0.85, pitchR - 1.25 * module);
  const backlash = 0.16;
  const pitchHalf = (step / 4) * (1 - backlash);
  const tipHalf = pitchHalf * 0.5;
  const rootHalf = Math.min(step * 0.44, pitchHalf + step * 0.14);

  const shape = new THREE.Shape();
  const pts = [];

  const push = (x, y) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < 1e-5) return;
    pts.push([x, y]);
  };

  const pushArc = (radius, a0, a1, segments) => {
    for (let i = 0; i <= segments; i += 1) {
      const a = a0 + ((a1 - a0) * i) / segments;
      push(Math.cos(a) * radius, Math.sin(a) * radius);
    }
  };

  const pushFlank = (r0, a0, r1, a1, segments) => {
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const radius = r0 + (r1 - r0) * t;
      const a = a0 + (a1 - a0) * t;
      push(Math.cos(a) * radius, Math.sin(a) * radius);
    }
  };

  for (let i = 0; i < teeth; i += 1) {
    const center = i * step;
    pushArc(rootR, center - step + rootHalf, center - rootHalf, 3);
    pushFlank(rootR, center - rootHalf, tipR, center - tipHalf, 3);
    pushArc(tipR, center - tipHalf, center + tipHalf, 2);
    pushFlank(tipR, center + tipHalf, rootR, center + rootHalf, 3);
  }

  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i][0], pts[i][1]);

  const boreR = Math.min(rootR * 0.42, Math.max(module * 1.15, pitchR * 0.2));
  const hole = new THREE.Path();
  const segs = 24;
  for (let i = 0; i <= segs; i += 1) {
    const a = -((i / segs) * TAU);
    const x = Math.cos(a) * boreR;
    const y = Math.sin(a) * boreR;
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  shape.holes.push(hole);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: face,
    bevelEnabled: true,
    bevelThickness: Math.min(0.012, face * 0.06),
    bevelSize: Math.min(module * 0.05, 0.006),
    bevelSegments: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -face / 2);
  geometry.computeVertexNormals();

  return { geometry, pitchR, outerR: tipR, rootR, boreR };
}
