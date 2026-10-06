/** Kinematic right-angle bevel pair.
 * Speed ratio is N driven / N driver, the same rule as the spur train.
 * The driven shaft sits at 90° to the driver. Motion is continuous mesh:
 * no friction and no backlash in the angles — only a visual gap between teeth.
 */

export const MODULE = 0.085;
export const MIN_TEETH = 12;
export const MAX_TEETH = 48;
export const SHAFT_TURN = '90° turn';

export const PRESETS = {
  miter: { driver: 20, driven: 20, label: 'Miter 20·20' },
  reducer: { driver: 16, driven: 40, label: 'Reducer 16·40' },
  overdrive: { driver: 36, driven: 18, label: 'Overdrive 36·18' },
};

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

export function mod(value, cycle) {
  if (cycle === 0) return 0;
  return ((value % cycle) + cycle) % cycle;
}

export function solveBevel({ driverTeeth, drivenTeeth }) {
  const driver = clamp(Math.round(Number(driverTeeth) || PRESETS.miter.driver), MIN_TEETH, MAX_TEETH);
  const driven = clamp(Math.round(Number(drivenTeeth) || PRESETS.miter.driven), MIN_TEETH, MAX_TEETH);
  const divisor = gcd(driver, driven);
  const gearRatio = driven / driver;
  const deltaDriver = Math.atan2(driver, driven);
  const deltaDriven = Math.PI / 2 - deltaDriver;
  const pitchDriver = (MODULE * driver) / 2;
  const pitchDriven = (MODULE * driven) / 2;
  const cone = pitchDriver / Math.sin(deltaDriver);
  return {
    driver,
    driven,
    gearRatio,
    speedOut: driver / driven,
    fractionNum: driven / divisor,
    fractionDen: driver / divisor,
    deltaDriver,
    deltaDriven,
    pitchDriver,
    pitchDriven,
    cone,
    module: MODULE,
  };
}

export function solvePreset(id) {
  const preset = PRESETS[id] || PRESETS.miter;
  return solveBevel({ driverTeeth: preset.driver, drivenTeeth: preset.driven });
}

export function matchingPreset(driver, driven) {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (preset.driver === driver && preset.driven === driven) return id;
  }
  return '';
}

/** Driven shaft angle for a driver angle. Half a driven tooth seats a space on the driver tooth. */
export function drivenAngle(driverSpin, solved) {
  return driverSpin * (solved.driver / solved.driven) + Math.PI / solved.driven;
}

export function outputRpm(solved, driverRpm) {
  return driverRpm * (solved.driver / solved.driven);
}

/**
 * Straight bevel tooth angles. The same large-end module is on both gears.
 * rootHalf stays inside the mating space so the kinematic mesh is not a collision.
 */
export function gearProfile(solved, role) {
  const teeth = role === 'driver' ? solved.driver : solved.driven;
  const pitch = role === 'driver' ? solved.deltaDriver : solved.deltaDriven;
  const step = TAU / teeth;
  const backlash = 0.2;
  const pitchHalf = (step / 4) * (1 - backlash);
  const addendum = Math.atan((2.2 * solved.module) / solved.cone);
  const dedendum = Math.atan((2.5 * solved.module) / solved.cone);
  return {
    teeth,
    pitch,
    step,
    pitchHalf,
    tipHalf: pitchHalf * 0.6,
    rootHalf: Math.min(step * 0.4, pitchHalf * 1.05),
    tipCone: pitch + addendum,
    rootCone: Math.max(0.08, pitch - dedendum),
    outer: solved.cone,
    inner: solved.cone * 0.62,
    module: solved.module,
  };
}

/** Point on a cone. Driver large end is −X. Driven large end is +Y. Phi 0 is the mesh. */
export function placeOnCone(role, length, coneAngle, phi) {
  const radial = length * Math.sin(coneAngle);
  const axial = length * Math.cos(coneAngle);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  if (role === 'driver') {
    return { x: -axial, y: radial * c, z: radial * s };
  }
  return { x: -radial * c, y: axial, z: radial * s };
}

/** How far the nearest driver tooth and the nearest driven space sit from the mesh line. */
export function meshGap(driverSpin, solved) {
  const stepDriver = TAU / solved.driver;
  const stepDriven = TAU / solved.driven;
  const driverPhase = mod(driverSpin, stepDriver);
  const drivenRot = drivenAngle(driverSpin, solved);
  const spacePhase = mod(drivenRot - stepDriven / 2, stepDriven);
  return {
    driverTooth: Math.min(driverPhase, stepDriver - driverPhase),
    drivenSpace: Math.min(spacePhase, stepDriven - spacePhase),
  };
}

export function formatTeeth(count) {
  return `${count} T`;
}

export function formatRatio(solved) {
  return `${solved.gearRatio.toFixed(2)} : 1`;
}

export function ratioLine(solved) {
  return `N driven / N driver = ${solved.driven} / ${solved.driver} = ${solved.fractionNum}/${solved.fractionDen}`;
}

export function paceWord(solved) {
  if (solved.gearRatio > 1.02) return 'slower';
  if (solved.gearRatio < 0.98) return 'faster';
  return 'at the same speed';
}

export function ratioSentence(solved) {
  const ratio = solved.gearRatio.toFixed(2);
  if (Math.abs(solved.gearRatio - 1) < 0.02) {
    return `The driver has ${solved.driver} teeth and the driven gear has ${solved.driven}. Speed ratio N driven / N driver is ${solved.driven} / ${solved.driver} = ${ratio} : 1. The shafts turn one for one. Tooth count is what sets that speed.`;
  }
  return `The driver has ${solved.driver} teeth and the driven gear has ${solved.driven}. Speed ratio N driven / N driver is ${solved.driven} / ${solved.driver} = ${ratio} : 1. The driver turns ${ratio} times for one turn of the driven gear, so the output is ${paceWord(solved)}. Tooth count is what sets that speed.`;
}

export function cornerSentence() {
  return 'The driven shaft sits at a right angle to the driver. That is the 90° turn. Looking along each shaft toward the mesh, the gears turn opposite ways, as an external pair does. Bevels are the gears you use when the shafts must meet at a corner instead of running side by side.';
}

export function liveSentence(solved, driverRpm) {
  const out = outputRpm(solved, driverRpm);
  return `${solved.driver} driver teeth and ${solved.driven} driven teeth. Speed ratio ${formatRatio(solved)}, so the output turns ${paceWord(solved)}. At ${driverRpm.toFixed(1).replace(/\.0$/, '')} rpm in, the driven shaft runs at ${out.toFixed(1)} rpm. The output direction is a 90° turn.`;
}
