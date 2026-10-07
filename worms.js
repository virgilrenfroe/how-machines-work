/** Kinematic worm and worm wheel.
 * Ideal speed ratio is N wheel / starts. A one-start worm is about N wheel : 1.
 * The shafts cross at 90° and do not meet. Motion is a rigid screw plus the
 * matching wheel angle. Hold vs free reverse is a simplified switch, not friction.
 */

export const MODULE = 0.11;
export const MIN_TEETH = 12;
export const MAX_TEETH = 48;
export const MIN_STARTS = 1;
export const MAX_STARTS = 4;
export const SHAFT_NOTE = '90° cross';

export const WORM_PITCH_R = 0.42;
export const WORM_ROOT_R = 0.3;
export const WORM_TIP_R = 0.52;

export const PRESETS = {
  fine: { starts: 1, teeth: 40, hold: true, label: 'Fine 1×40' },
  coarse: { starts: 2, teeth: 20, hold: false, label: 'Coarse 2×20' },
  demo: { starts: 1, teeth: 20, hold: true, label: 'Demo 1×20' },
};

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function trimNum(value) {
  return Number(value).toFixed(1).replace(/\.0$/, '');
}

export function solveWorm({ starts, teeth }) {
  const startCount = clamp(Math.round(Number(starts) || PRESETS.fine.starts), MIN_STARTS, MAX_STARTS);
  const toothCount = clamp(Math.round(Number(teeth) || PRESETS.fine.teeth), MIN_TEETH, MAX_TEETH);
  const pitchR = (MODULE * toothCount) / 2;
  const axialPitch = Math.PI * MODULE;
  const lead = startCount * axialPitch;
  const leadAngle = Math.atan2(lead, TAU * WORM_PITCH_R);
  const centerDist = pitchR + WORM_PITCH_R;
  const rootR = Math.max(MODULE * 0.9, pitchR - 1.22 * MODULE);
  const tipMid = centerDist - WORM_ROOT_R - 0.028;
  const curveR = WORM_TIP_R * 0.98;
  const faceHalf = Math.min(0.3, curveR * 0.62);
  const length = clamp(lead * 3.35, 1.85, 2.55);
  const ratio = toothCount / startCount;
  return {
    starts: startCount,
    teeth: toothCount,
    ratio,
    speedOut: startCount / toothCount,
    pitchR,
    axialPitch,
    lead,
    leadAngle,
    centerDist,
    rootR,
    tipMid,
    curveR,
    faceHalf,
    length,
    module: MODULE,
    wormPitchR: WORM_PITCH_R,
    wormRootR: WORM_ROOT_R,
    wormTipR: WORM_TIP_R,
    step: TAU / toothCount,
  };
}

export function solvePreset(id) {
  const preset = PRESETS[id] || PRESETS.fine;
  return {
    solved: solveWorm({ starts: preset.starts, teeth: preset.teeth }),
    hold: preset.hold,
    id,
  };
}

export function matchingPreset(starts, teeth) {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (preset.starts === starts && preset.teeth === teeth) return id;
  }
  return '';
}

/** Wheel rotation about Z. A gap stays seated on the thread as the worm turns. */
export function wheelAngle(wormSpin, solved) {
  return solved.step / 2 + wormSpin * (solved.starts / solved.teeth);
}

/** Axial position of the thread crest nearest the wheel. Slides one lead per worm turn. */
export function contactX(wormSpin, solved) {
  return -(solved.lead * wormSpin) / TAU;
}

export function outputRpm(solved, wormRpm) {
  return wormRpm * solved.speedOut;
}

export function tipRadiusAt(solved, z) {
  const zz = Math.min(Math.abs(z), solved.curveR * 0.96);
  const radial = solved.tipMid - solved.curveR + Math.sqrt(solved.curveR * solved.curveR - zz * zz);
  return Math.max(solved.rootR + 0.025, radial);
}

export function formatTeeth(count) {
  return `${count} T`;
}

export function formatStarts(count) {
  return count === 1 ? '1 start' : `${count} starts`;
}

export function formatRatio(solved) {
  const rounded = Math.round(solved.ratio);
  const text = Math.abs(solved.ratio - rounded) < 1e-6 ? String(rounded) : solved.ratio.toFixed(2);
  return `${text} : 1`;
}

export function ratioLine(solved) {
  return `N wheel / starts = ${solved.teeth} / ${solved.starts} = ${formatRatio(solved)}`;
}

export function paceWord(solved) {
  if (solved.ratio >= 12) return 'very slowly';
  return 'slowly';
}

export function ratioSentence(solved) {
  const times = formatRatio(solved).replace(' : 1', '');
  return `The wheel has ${solved.teeth} teeth and the worm has ${formatStarts(solved.starts)}. Speed ratio N wheel / starts is ${solved.teeth} / ${solved.starts} = ${formatRatio(solved)}. The worm turns ${times} times for one turn of the wheel, so the wheel turns ${paceWord(solved)}.`;
}

export function shaftSentence() {
  return 'The worm shaft and the wheel shaft cross at 90°. They do not meet. The worm sits across the wheel, the way a screw sits against a gear. A bevel pair also turns a shaft 90°, but those shafts meet, and the ratio is one tooth count divided by the other. That ratio is often near 1 : 1. A worm ratio is usually large.';
}

export function inclineSentence(solved) {
  const degrees = (solved.leadAngle * 180) / Math.PI;
  return `The worm is a helical incline, the same idea as a screw, wrapped around a shaft. The wheel tooth rides that incline. One start advances the wheel by one tooth each turn of the worm. This worm’s lead angle is about ${degrees.toFixed(0)}°. More starts make a steeper thread and a smaller ratio.`;
}

export function holdSentence(hold) {
  if (hold) {
    return 'Hold is on. Try the wheel and the worm does not turn. Shop people call a worm that will not run backward self-locking. This switch is a simplified picture. A real worm holds only when friction on the thread is high enough. This bench does not calculate friction.';
  }
  return 'Free reverse is on. The wheel can turn the worm backward. This is still a simplified picture, not a friction calculation. On a real worm, a steeper thread — more starts — is easier to back-drive.';
}

export function liveSentence(solved, rpm, drive, hold) {
  const wheelRpm = outputRpm(solved, rpm);
  const ratio = formatRatio(solved);
  const head = `${solved.teeth} wheel teeth and ${formatStarts(solved.starts)}. Ratio ${ratio}.`;
  if (drive === 'wheel' && hold) {
    return `${head} The wheel is trying to drive, and the pair holds. The worm does not turn. Shafts cross at 90°.`;
  }
  if (drive === 'wheel') {
    return `${head} The wheel drives. The worm turns backward at ${trimNum(rpm)} rpm, and the wheel creeps backward at ${wheelRpm.toFixed(1)} rpm. Shafts cross at 90°.`;
  }
  return `${head} The worm drives at ${trimNum(rpm)} rpm. The wheel turns ${paceWord(solved)} at ${wheelRpm.toFixed(1)} rpm. Shafts cross at 90°.`;
}
