/** Ideal screw: an inclined plane wrapped around a cylinder. No friction, no wrench. */

export const LOAD_LB = 10;

export const LIMITS = {
  pitch: [0.08, 0.5],
  meanDiameter: [0.5, 1.5],
};

export const PRESETS = {
  fine: { name: 'Fine', pitch: 0.1, meanDiameter: 1 },
  vise: { name: 'Vise', pitch: 0.2, meanDiameter: 1 },
  coarse: { name: 'Coarse', pitch: 0.4, meanDiameter: 1 },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Ideal mechanical advantage is the mean circumference of the thread divided by the pitch.
 * In one turn the tangential effort walks π × mean diameter, and the clamp advances one pitch.
 * Effort = load / MA, for a constant clamp.
 */
export function solve(pitch, meanDiameter) {
  const p = clamp(Number(pitch), LIMITS.pitch[0], LIMITS.pitch[1]);
  const d = clamp(Number(meanDiameter), LIMITS.meanDiameter[0], LIMITS.meanDiameter[1]);
  const circumference = Math.PI * d;
  const ma = circumference / p;
  return {
    pitch: p,
    meanDiameter: d,
    circumference,
    ma,
    tpi: 1 / p,
    load: LOAD_LB,
    effort: LOAD_LB / ma,
    advancePerTurn: p,
  };
}

export function formatPitch(inches) {
  return `${inches.toFixed(3)} in`;
}

export function formatInches(inches) {
  return `${inches.toFixed(3)} in`;
}

export function formatPounds(lb) {
  return `${lb.toFixed(2)} lb`;
}

export function formatMa(ma) {
  return `${ma.toFixed(2)} : 1`;
}

export function formatTpi(tpi) {
  return `${tpi.toFixed(2).replace(/\.?0+$/, '')} TPI`;
}

export function tradeSentence(solved) {
  const effort = formatPounds(solved.effort);
  const pitch = formatPitch(solved.pitch);
  const wrap = formatInches(solved.circumference);
  if (solved.pitch <= 0.12) {
    return `Fine pitch, ${pitch} per turn. The unwrapped ramp is shallow, so tangential effort is ${effort} for a 10 lb clamp, and the jaw creeps.`;
  }
  if (solved.pitch >= 0.32) {
    return `Coarse pitch, ${pitch} per turn. The ramp is steeper, so tangential effort rises to ${effort}, and the jaw advances farther each turn.`;
  }
  return `Pitch ${pitch} per turn. The jaw climbs that far along a ${wrap} wrap. Tangential effort is ${effort}.`;
}
