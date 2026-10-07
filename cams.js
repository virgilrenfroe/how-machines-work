/** Plate-cam kinematics. Lengths are inches.
 * The roller center moves in a straight line. Lift is that travel above the low point.
 * One full turn is one lift cycle. No spring, no friction, no bounce.
 */

export const ROLLER_RADIUS = 0.15;
export const PITCH_BASE = 1.22;
export const CHART_MAX = 1;

const ECCENTRIC = { R: 1.47, e: 0.4 };
const DWELL_LIFT = 1;
const PEAK_LIFT = 1;
const PEAK_CENTER = 180;
const PEAK_HALF = 52;

const DWELL_BANDS = [
  { start: 0, end: 100, phase: 'dwell-low' },
  { start: 100, end: 160, phase: 'rise' },
  { start: 160, end: 280, phase: 'dwell-high' },
  { start: 280, end: 340, phase: 'return' },
  { start: 340, end: 360, phase: 'dwell-low' },
];

export const PRESETS = {
  eccentric: { id: 'eccentric', label: 'Eccentric', maxLift: ECCENTRIC.e * 2 },
  dwell: { id: 'dwell', label: 'Dwell', maxLift: DWELL_LIFT },
  peak: { id: 'peak', label: 'Peak', maxLift: PEAK_LIFT },
};

const PHASES = {
  rise: {
    label: 'Rise',
    sentence: 'This part of the profile is the rise, so the follower is climbing.',
  },
  return: {
    label: 'Return',
    sentence: 'This part of the profile is the return, so the follower is coming back down.',
  },
  'dwell-low': {
    label: 'Low dwell',
    sentence: 'This part of the profile is a low dwell, so the follower holds still.',
  },
  'dwell-high': {
    label: 'High dwell',
    sentence: 'This part of the profile is a high dwell, so the follower stays up.',
  },
  high: {
    label: 'High point',
    sentence: 'The follower is at the high point of this turn.',
  },
  low: {
    label: 'Low point',
    sentence: 'The follower is at the low point of this turn.',
  },
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function wrapAngle(deg) {
  let angle = deg % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function rad(deg) {
  return (deg * Math.PI) / 180;
}

function cycloid(unit) {
  const u = clamp01(unit);
  return u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);
}

function eccentricCenter(angleDeg) {
  const angle = rad(wrapAngle(angleDeg));
  const reach = ECCENTRIC.R + ROLLER_RADIUS;
  const under = reach * reach - ECCENTRIC.e * ECCENTRIC.e * Math.sin(angle) * Math.sin(angle);
  return -ECCENTRIC.e * Math.cos(angle) + Math.sqrt(Math.max(0, under));
}

/** Follower travel above the low point. The roller center is PITCH_BASE + lift. */
export function liftOf(presetId, angleDeg) {
  if (presetId === 'eccentric') return Math.max(0, eccentricCenter(angleDeg) - PITCH_BASE);
  return designedLift(presetId, angleDeg);
}

function designedLift(presetId, angleDeg) {
  const angle = wrapAngle(angleDeg);
  if (presetId === 'dwell') {
    if (angle < 100 || angle >= 340) return 0;
    if (angle < 160) return DWELL_LIFT * cycloid((angle - 100) / 60);
    if (angle < 280) return DWELL_LIFT;
    return DWELL_LIFT * (1 - cycloid((angle - 280) / 60));
  }
  const delta = Math.abs(angle - PEAK_CENTER);
  if (delta >= PEAK_HALF) return 0;
  return (PEAK_LIFT / 2) * (1 + Math.cos((Math.PI * delta) / PEAK_HALF));
}

export function followerCenter(presetId, angleDeg) {
  return PITCH_BASE + liftOf(presetId, angleDeg);
}

function pitchPoint(presetId, angleDeg) {
  const radius = followerCenter(presetId, angleDeg);
  const theta = rad(wrapAngle(angleDeg));
  return {
    x: -Math.sin(theta) * radius,
    y: Math.cos(theta) * radius,
  };
}

/** Cam outline in the plate's own coordinates, in inches. Roller radius is already offset. */
export function camOutline(presetId, steps = 480) {
  if (presetId === 'eccentric') {
    const points = [];
    for (let i = 0; i < steps; i += 1) {
      const theta = (i / steps) * Math.PI * 2;
      points.push({
        x: Math.sin(theta) * ECCENTRIC.R,
        y: -ECCENTRIC.e + Math.cos(theta) * ECCENTRIC.R,
      });
    }
    return points;
  }

  const points = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * 360;
    const prev = pitchPoint(presetId, angle - 0.35);
    const next = pitchPoint(presetId, angle + 0.35);
    const curr = pitchPoint(presetId, angle);
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const length = Math.hypot(tx, ty) || 1;
    tx /= length;
    ty /= length;
    let nx = ty;
    let ny = -tx;
    if (nx * curr.x + ny * curr.y < 0) {
      nx = -nx;
      ny = -ny;
    }
    points.push({
      x: curr.x - nx * ROLLER_RADIUS,
      y: curr.y - ny * ROLLER_RADIUS,
    });
  }
  return points;
}

export function phaseBands(presetId) {
  if (presetId === 'dwell') return DWELL_BANDS;
  if (presetId === 'peak') {
    return [
      { start: 0, end: PEAK_CENTER - PEAK_HALF, phase: 'dwell-low' },
      { start: PEAK_CENTER - PEAK_HALF, end: PEAK_CENTER, phase: 'rise' },
      { start: PEAK_CENTER, end: PEAK_CENTER + PEAK_HALF, phase: 'return' },
      { start: PEAK_CENTER + PEAK_HALF, end: 360, phase: 'dwell-low' },
    ];
  }
  return [
    { start: 0, end: 180, phase: 'rise' },
    { start: 180, end: 360, phase: 'return' },
  ];
}

export function phaseOf(presetId, angleDeg) {
  const angle = wrapAngle(angleDeg);
  let id;
  if (presetId === 'eccentric' && (angle <= 1.2 || angle >= 358.8)) id = 'low';
  else if (presetId === 'eccentric' && Math.abs(angle - 180) <= 1.2) id = 'high';
  else if (presetId === 'peak' && Math.abs(angle - PEAK_CENTER) <= 1.2) id = 'high';
  else {
    id = 'rise';
    for (const band of phaseBands(presetId)) {
      if (angle >= band.start && angle < band.end) {
        id = band.phase;
        break;
      }
    }
  }
  return { id, ...PHASES[id] };
}

export function readCam(presetId, angleDeg) {
  const angle = wrapAngle(angleDeg);
  const phase = phaseOf(presetId, angle);
  return {
    presetId,
    angle,
    lift: liftOf(presetId, angle),
    center: followerCenter(presetId, angle),
    maxLift: PRESETS[presetId].maxLift,
    phase: phase.id,
    label: phase.label,
    sentence: phase.sentence,
  };
}

export function displacementSamples(presetId, count = 361) {
  const samples = [];
  const steps = Math.max(2, count);
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / (steps - 1)) * 360;
    samples.push({ angle, lift: liftOf(presetId, angle) });
  }
  return samples;
}

export function formatAngle(deg) {
  const rounded = Math.round(wrapAngle(deg));
  return `${rounded === 360 ? 0 : rounded}°`;
}

export function formatLift(inches) {
  return `${inches.toFixed(2)} in`;
}

export function formatRpm(rpm) {
  const rounded = Math.round(rpm * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)} rpm` : `${rounded.toFixed(1)} rpm`;
}

export function liveSentence(read, rpm) {
  return `Cam angle ${formatAngle(read.angle)}. Follower lift ${formatLift(read.lift)}. ${read.sentence} One full turn of the cam is one lift cycle. At ${formatRpm(rpm)} the lift at this angle stays the same.`;
}

export const SHAFT_RADIUS = 0.24;
