/** Ideal wedge. Lengths are inches. No friction.
 * A wedge is two inclined planes back to back, or one face against a stop.
 * Ideal MA = slope length along the face / thickness of the thick end.
 * Effort = load ÷ MA. The split stays 10 lb.
 * Slope length stays at least the thickness, so the point is real.
 */

export const LOAD_LB = 10;

export const MIN_LENGTH = 1.5;
export const MAX_LENGTH = 8;
export const MIN_THICKNESS = 0.25;
export const MAX_THICKNESS = 2.5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deg(radians) {
  return (radians * 180) / Math.PI;
}

function pack(length, thickness) {
  const L = length;
  const t = thickness;
  const half = t / 2;
  const altitude = Math.sqrt(Math.max(L * L - half * half, 1e-8));
  const ma = L / t;
  return {
    length: L,
    thickness: t,
    altitude,
    includedAngle: deg(2 * Math.asin(clamp(half / L, 0, 1))),
    ma,
    loadForce: LOAD_LB,
    effortForce: LOAD_LB / ma,
    work: LOAD_LB * t,
  };
}

/** Hold the thickness and set the slope length. Thickness follows if the face would be too short. */
export function solveFromLength(length, thickness) {
  const L = clamp(length, MIN_LENGTH, MAX_LENGTH);
  const t = clamp(thickness, MIN_THICKNESS, Math.min(MAX_THICKNESS, L));
  return pack(Math.max(L, t), t);
}

/** Hold the slope length and set the thickness. Length follows if the thick end would outrun the face. */
export function solveFromThickness(length, thickness) {
  const t = clamp(thickness, MIN_THICKNESS, MAX_THICKNESS);
  const L = clamp(length, Math.max(MIN_LENGTH, t), MAX_LENGTH);
  return pack(L, t);
}

export const PRESETS = {
  chisel: { label: 'Chisel', length: 4, thickness: 0.5 },
  axe: { label: 'Axe', length: 2, thickness: 1 },
  doorstop: { label: 'Doorstop', length: 5, thickness: 1 },
  split: { label: 'Split', length: 6, thickness: 2 },
};

export function solvePreset(id) {
  const preset = PRESETS[id];
  if (!preset) return solveFromLength(4, 0.5);
  return solveFromLength(preset.length, preset.thickness);
}

export function formatAngle(angle) {
  const rounded = Math.round(angle * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}°` : `${rounded.toFixed(1)}°`;
}

export function formatInches(value) {
  return `${value.toFixed(2)} in`;
}

export function formatForce(value) {
  return `${value.toFixed(2)} lb`;
}

export function tradeSentence(solved) {
  if (solved.ma >= 6) {
    return 'The wedge is long and thin, so the push is a small share of the split. You drive it a long way to open a narrow gap.';
  }
  if (solved.ma >= 3) {
    return 'The effort stays well under the split. Lengthen the face, or make the thick end thinner, and the push gets lighter.';
  }
  return 'The wedge is short and thick, so the effort climbs toward the split. A long thin chisel needs less push than a short thick axe head.';
}
