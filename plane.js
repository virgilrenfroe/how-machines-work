/** Ideal inclined plane. Lengths are feet. No friction.
 * Ideal MA = slope length / height = 1 / sin θ.
 * Effort = load ÷ MA. The load stays 10 lb.
 */

export const LOAD_LB = 10;

export const MIN_ANGLE = 8;
export const MAX_ANGLE = 60;
export const MIN_LENGTH = 2.2;
export const MAX_LENGTH = 14;
export const MIN_HEIGHT = 1;
export const MAX_HEIGHT = 5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rad(deg) {
  return (deg * Math.PI) / 180;
}

function deg(radians) {
  return (radians * 180) / Math.PI;
}

function finish(length, height) {
  const L = clamp(length, MIN_LENGTH, MAX_LENGTH);
  const maxH = Math.min(MAX_HEIGHT, L * Math.sin(rad(MAX_ANGLE)));
  const minH = Math.min(maxH, Math.max(MIN_HEIGHT, L * Math.sin(rad(MIN_ANGLE))));
  const h = clamp(height, minH, maxH);
  const angle = deg(Math.asin(clamp(h / L, 0, 1)));
  const ma = L / h;
  return {
    length: L,
    height: h,
    run: Math.sqrt(Math.max(0, L * L - h * h)),
    angle,
    ma,
    loadForce: LOAD_LB,
    effortForce: LOAD_LB / ma,
    work: LOAD_LB * h,
  };
}

/** Hold the rise and set the angle. Slope length follows, then clamps. */
export function solveFromAngle(angleDeg, height) {
  const angle = clamp(angleDeg, MIN_ANGLE, MAX_ANGLE);
  let h = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
  let length = h / Math.sin(rad(angle));
  if (length < MIN_LENGTH) {
    length = MIN_LENGTH;
    h = length * Math.sin(rad(angle));
  } else if (length > MAX_LENGTH) {
    length = MAX_LENGTH;
    h = length * Math.sin(rad(angle));
  }
  return finish(length, h);
}

/** Hold the rise and set the slope length. The angle follows. */
export function solveFromLength(length, height) {
  return finish(length, height);
}

export const PRESETS = {
  gentle: { label: 'Gentle 10°', angle: 10, height: 2 },
  dock: { label: 'Dock 8 ft', length: 8, height: 2 },
  thirty: { label: '30°', angle: 30, height: 2 },
  fortyfive: { label: '45°', angle: 45, height: 2 },
};

export function solvePreset(id) {
  const preset = PRESETS[id];
  if (!preset) return solveFromLength(8, 2);
  if (preset.angle != null) return solveFromAngle(preset.angle, preset.height);
  return solveFromLength(preset.length, preset.height);
}

export function formatAngle(angle) {
  const rounded = Math.round(angle * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}°` : `${rounded.toFixed(1)}°`;
}

export function formatFeet(value) {
  return `${value.toFixed(2)} ft`;
}

export function formatForce(value) {
  return `${value.toFixed(2)} lb`;
}

export function tradeSentence(solved) {
  if (solved.ma >= 4) {
    return 'The ramp is gentle, so the push is a small share of the load. You walk a long slope to gain a little height.';
  }
  if (solved.ma >= 2) {
    return 'The effort is well under the load. Lengthen the slope for the same height and the push gets lighter.';
  }
  return 'The ramp is steep, so the effort climbs toward the load. Lengthen the slope, or lower the angle, to make the push easier.';
}
