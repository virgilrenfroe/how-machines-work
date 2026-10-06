/** Ideal wheel and axle. Radii share one shop unit. No friction. */

export const LOAD_LB = 10;
export const WHEEL_MIN = 2;
export const WHEEL_MAX = 8;
export const AXLE_MIN = 0.5;
export const AXLE_MAX = 7.5;
export const GAP = 0.3;

export const PRESETS = [
  { id: 'winch', wheel: 6, axle: 1.5, label: 'Winch 6 · 1.5' },
  { id: 'knob', wheel: 2.4, axle: 0.6, label: 'Knob 2.4 · 0.6' },
  { id: 'steering', wheel: 8, axle: 0.8, label: 'Steering 8 · 0.8' },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Ideal MA when the effort is on the wheel is R wheel / R axle.
 * Driving the axle flips that ratio.
 */
export function solve(wheelRadius, axleRadius) {
  let wheel = clamp(Number(wheelRadius) || WHEEL_MIN, WHEEL_MIN, WHEEL_MAX);
  let axle = clamp(Number(axleRadius) || AXLE_MIN, AXLE_MIN, AXLE_MAX);
  const axleCeiling = Math.min(AXLE_MAX, wheel - GAP);
  if (axle > axleCeiling) axle = Math.max(AXLE_MIN, axleCeiling);
  if (wheel < axle + GAP) wheel = Math.min(WHEEL_MAX, axle + GAP);
  const maWheel = wheel / axle;
  const maAxle = axle / wheel;
  return {
    wheelRadius: wheel,
    axleRadius: axle,
    maWheel,
    maAxle,
    loadForce: LOAD_LB,
    effortWheel: (LOAD_LB * axle) / wheel,
    effortAxle: (LOAD_LB * wheel) / axle,
  };
}

export const MODES = {
  wheel: {
    id: 'wheel',
    name: 'Drive the wheel',
    order: 'Your effort is on the rim. The load is on the axle.',
    shop: 'Winch, screwdriver, steering wheel, doorknob.',
  },
  axle: {
    id: 'axle',
    name: 'Drive the axle',
    order: 'Your effort is on the axle. The load is on the rim.',
    shop: 'A fan, or a wheel powered at the hub.',
  },
};

export function tradeSentence(mode, solved) {
  const load = solved.loadForce.toFixed(0);
  if (mode === 'axle') {
    return `The axle is the short radius, so you use more force. The rim moves farther than your hand. A ${load} lb load needs more than ${load} lb.`;
  }
  return `The wheel is the long radius, so you use less force. Your hand moves farther than the load. A ${load} lb load needs less than ${load} lb.`;
}
