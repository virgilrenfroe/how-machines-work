/** Ideal lever classes. Lengths are in the same shop unit. No friction. */

export const BEAM = 4;
export const INSET = 0.28;
export const LOAD_LB = 10;

const GAP = 0.38;

export function fulcrumX(classId) {
  return classId === 1 ? BEAM / 2 : INSET;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Allowed slider ranges. Class 2 keeps the load between the fulcrum and the effort.
 * Class 3 keeps the effort between the fulcrum and the load.
 */
export function ranges(classId, effort, load) {
  const fulcrum = fulcrumX(classId);
  if (classId === 1) {
    return {
      effort: [INSET, fulcrum - GAP],
      load: [fulcrum + GAP, BEAM - INSET],
    };
  }
  if (classId === 2) {
    const effortRange = [fulcrum + GAP * 3, BEAM - INSET];
    const effortClamped = clamp(effort, effortRange[0], effortRange[1]);
    return {
      effort: effortRange,
      load: [fulcrum + GAP, Math.max(fulcrum + GAP + 0.05, effortClamped - GAP)],
    };
  }
  const loadRange = [fulcrum + GAP * 3, BEAM - INSET];
  const loadClamped = clamp(load, loadRange[0], loadRange[1]);
  return {
    effort: [fulcrum + GAP, Math.max(fulcrum + GAP + 0.05, loadClamped - GAP)],
    load: loadRange,
  };
}

export function solve(classId, effort, load) {
  const first = ranges(classId, effort, load);
  let effortX = clamp(effort, first.effort[0], first.effort[1]);
  let loadX = clamp(load, first.load[0], first.load[1]);
  const second = ranges(classId, effortX, loadX);
  effortX = clamp(effortX, second.effort[0], second.effort[1]);
  loadX = clamp(loadX, second.load[0], second.load[1]);
  const fulcrum = fulcrumX(classId);
  const effortArm = Math.abs(effortX - fulcrum);
  const loadArm = Math.abs(loadX - fulcrum);
  const ma = effortArm / loadArm;
  return {
    classId,
    fulcrum,
    effort: effortX,
    load: loadX,
    effortArm,
    loadArm,
    ma,
    loadForce: LOAD_LB,
    effortForce: LOAD_LB / ma,
    ranges: second,
  };
}

export function effortDirection(classId) {
  return classId === 1 ? -1 : 1;
}

export const CLASS_META = {
  1: {
    name: 'First class',
    order: 'Fulcrum between effort and load.',
    shop: 'Crowbar, seesaw, pliers.',
    between: 'fulcrum',
  },
  2: {
    name: 'Second class',
    order: 'Load between fulcrum and effort.',
    shop: 'Wheelbarrow, nutcracker, bottle opener.',
    between: 'load',
  },
  3: {
    name: 'Third class',
    order: 'Effort between fulcrum and load.',
    shop: 'Tweezers, fishing rod, your forearm.',
    between: 'effort',
  },
};

export function tradeSentence(classId, ma) {
  if (classId === 2) {
    return 'The effort arm is longer, so you use less force. The load moves less than your hand.';
  }
  if (classId === 3) {
    return 'The effort arm is shorter, so you use more force. The load moves farther than your hand.';
  }
  if (ma >= 1) {
    return 'The effort arm is longer, so you use less force.';
  }
  return 'The effort arm is shorter, so you use more force and the load moves farther.';
}
