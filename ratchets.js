/** Kinematic ratchet and pawl. No spring rate and no tooth strength.
 * Drive is clockwise. The pawl rides up a tooth and drops into the next one.
 * Reverse does not advance the wheel while the pawl is holding.
 * Lift the pawl and the wheel can turn either way.
 */

export const MIN_TEETH = 6;
export const MAX_TEETH = 48;
export const FINE_TEETH = 36;
export const COARSE_TEETH = 8;
export const CONTACT = Math.PI / 2;
export const RAMP_END = 0.88;
export const TIP_RADIUS = 1.08;

export const PAWL = {
  pivotX: 0.326,
  pivotY: 1.851,
  length: 1.015,
  clearance: 0.04,
  liftClear: 0.42,
};

export const PRESETS = {
  fine: { teeth: FINE_TEETH, label: 'Fine tooth' },
  coarse: { teeth: COARSE_TEETH, label: 'Coarse tooth' },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mod(value, cycle) {
  if (cycle === 0) return 0;
  return ((value % cycle) + cycle) % cycle;
}

export function stepRadians(teeth) {
  return (Math.PI * 2) / teeth;
}

/** Radial tooth depth. Valleys stay deep enough for the pawl to sit in a notch. */
export function toothDepth(teeth) {
  const step = stepRadians(teeth);
  return Math.min(0.36, Math.max(0.24, step * 0.5));
}

export function radii(teeth) {
  const tip = TIP_RADIUS;
  const depth = toothDepth(teeth);
  return { tip, root: tip - depth, depth };
}

export function solveRatchet({ teeth, lifted }) {
  const count = clamp(Math.round(Number(teeth) || FINE_TEETH), MIN_TEETH, MAX_TEETH);
  const stepDeg = 360 / count;
  const isLifted = Boolean(lifted);
  return {
    teeth: count,
    stepDeg,
    stepRad: stepRadians(count),
    lifted: isLifted,
    holding: !isLifted,
    allowed: isLifted ? 'either way' : 'clockwise',
    stepsPerTurn: count,
    radii: radii(count),
  };
}

export function solvePreset(id, lifted = false) {
  const preset = PRESETS[id] || PRESETS.fine;
  return solveRatchet({ teeth: preset.teeth, lifted });
}

export function matchingPreset(teeth) {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (preset.teeth === teeth) return id;
  }
  return '';
}

/** Snap a drive angle onto a tooth so the pawl can sit in a notch. */
export function nearestTooth(drive, teeth) {
  const step = stepRadians(teeth);
  return Math.round(drive / step) * step;
}

/**
 * How far the pawl has climbed the tooth under the contact.
 * 0 is seated in the notch. 1 is on the crest, about to drop.
 */
export function ride(driveAngle, teeth) {
  const step = stepRadians(teeth);
  const u = mod(driveAngle, step) / step;
  if (u <= RAMP_END) {
    return { u, climb: u / RAMP_END, dropping: false };
  }
  const drop = (u - RAMP_END) / (1 - RAMP_END);
  return { u, climb: 1 - drop, dropping: true };
}

/** Local radius of the tooth under the fixed contact, for a clockwise drive angle. */
export function toothRadius(driveAngle, teeth) {
  const { root, tip } = radii(teeth);
  const { climb } = ride(driveAngle, teeth);
  return root + (tip - root) * climb;
}

/** Tooth surface radius at a world angle. The wheel's clockwise drive is -Z rotation. */
export function surfaceRadiusAt(worldAngle, driveAngle, teeth) {
  const local = worldAngle + driveAngle;
  return toothRadius(local - CONTACT, teeth);
}

/**
 * Time fraction 0..1 through one click.
 * The wheel spends most of the click climbing, then falls through the face.
 */
export function stepPhase(timeFraction) {
  const u = clamp(timeFraction, 0, 1);
  if (u < 0.78) return (u / 0.78) * RAMP_END;
  const v = (u - 0.78) / 0.22;
  return RAMP_END + (1 - RAMP_END) * v * v;
}

/** Reverse can only take up the steep face. It cannot climb the ramp. */
export function backlash(teeth) {
  return stepRadians(teeth) * (1 - RAMP_END) * 0.85;
}

export function formatStep(degrees) {
  const rounded = Math.round(degrees * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return `${Math.round(rounded)}°`;
  return `${rounded.toFixed(1)}°`;
}

export function formatTeeth(count) {
  return `${count} T`;
}

export function directionLabel(solved) {
  return solved.lifted ? 'Either way' : 'Clockwise';
}

export function pawlLabel(solved) {
  return solved.lifted ? 'Lifted' : 'Holding';
}

export function stepSentence(solved) {
  const step = formatStep(solved.stepDeg);
  if (solved.teeth >= 24) {
    return `The wheel has ${solved.teeth} teeth, so one turn is ${solved.teeth} clicks and each click is ${step}. A fine wheel takes more steps to come around.`;
  }
  if (solved.teeth <= 12) {
    return `The wheel has ${solved.teeth} teeth, so one turn is ${solved.teeth} clicks and each click is ${step}. A coarse wheel takes fewer, larger steps.`;
  }
  return `The wheel has ${solved.teeth} teeth, so one turn is ${solved.teeth} clicks and each click is ${step}.`;
}

export function holdSentence(solved) {
  if (solved.lifted) {
    return 'The pawl is lifted clear of the teeth. Drive and reverse are both free, so the wheel can turn either way and nothing holds the place it just left.';
  }
  return 'The pawl sits in a tooth. Clockwise drive is allowed, and the pawl rides up the tooth and drops into the next one. That drop is the click. Reverse is blocked, so the wheel cannot give back the step it just took.';
}

export function liveSentence(solved) {
  const step = formatStep(solved.stepDeg);
  if (solved.lifted) {
    return `${solved.teeth} teeth, ${step} each step. The pawl is lifted, so the wheel can turn either way.`;
  }
  return `${solved.teeth} teeth, ${step} each step. Clockwise drive is allowed and reverse is blocked. The pawl is holding.`;
}

/** Pawl tip for a rotation about the pivot. Zero points toward -Y. */
export function pawlTip(alpha, pawl = PAWL) {
  return {
    x: pawl.pivotX + Math.sin(alpha) * pawl.length,
    y: pawl.pivotY - Math.cos(alpha) * pawl.length,
  };
}

/** Rotation that puts the tip on a chosen radius, nearest the top of the wheel. */
export function alphaForRadius(targetR, pawl = PAWL) {
  const px = pawl.pivotX;
  const py = pawl.pivotY;
  const length = pawl.length;
  const d = Math.hypot(px, py);
  if (d < 1e-6) return 0;
  const x = (d * d + targetR * targetR - length * length) / (2 * d);
  const h2 = targetR * targetR - x * x;
  if (h2 < 0) return null;
  const h = Math.sqrt(Math.max(0, h2));
  const ux = px / d;
  const uy = py / d;
  const points = [
    { x: ux * x - uy * h, y: uy * x + ux * h },
    { x: ux * x + uy * h, y: uy * x - ux * h },
  ];
  points.sort((a, b) => b.y - a.y);
  const tip = points[0];
  const dx = tip.x - px;
  const dy = tip.y - py;
  return Math.atan2(dx, -dy);
}

function clearanceAt(alpha, driveAngle, teeth, pawl = PAWL) {
  const tip = pawlTip(alpha, pawl);
  const radius = Math.hypot(tip.x, tip.y);
  const world = Math.atan2(tip.y, tip.x);
  const surface = surfaceRadiusAt(world, driveAngle, teeth);
  return radius - surface;
}

/** World angle of the tooth notch (phase 0) for this drive angle. */
export function notchAngle(driveAngle) {
  return CONTACT - driveAngle;
}

/** Pawl angle that sets the tip in the notch, just clear of the tooth. */
export function seatedAlpha(driveAngle, teeth, pawl = PAWL) {
  const { root } = radii(teeth);
  const world = notchAngle(driveAngle);
  const goalR = root + pawl.clearance;
  const goal = {
    x: Math.cos(world) * goalR,
    y: Math.sin(world) * goalR,
  };
  let best = liftedAlpha(teeth, pawl);
  let bestScore = Infinity;
  const start = best - 0.4;
  const end = best + 2.4;
  for (let i = 0; i <= 96; i += 1) {
    const alpha = start + ((end - start) * i) / 96;
    const gap = clearanceAt(alpha, driveAngle, teeth, pawl);
    if (gap < 0.02) continue;
    const tip = pawlTip(alpha, pawl);
    const miss = Math.hypot(tip.x - goal.x, tip.y - goal.y);
    const score = miss + Math.max(0, gap - 0.12) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = alpha;
    }
  }
  return best;
}

export function liftedAlpha(teeth, pawl = PAWL) {
  const target = radii(teeth).tip + pawl.liftClear;
  const found = alphaForRadius(target, pawl);
  if (found == null) return 0.9;
  return found;
}

export function pawlPose(driveAngle, teeth, liftedBlend, pawl = PAWL) {
  const seated = seatedAlpha(driveAngle, teeth, pawl);
  const lifted = liftedAlpha(teeth, pawl);
  const blend = clamp(liftedBlend, 0, 1);
  const alpha = seated + (lifted - seated) * blend;
  const tip = pawlTip(alpha, pawl);
  return { alpha, seated, lifted, tip, radius: Math.hypot(tip.x, tip.y) };
}
