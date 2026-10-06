/** Ideal pulleys. No friction, no rope stiffness. Load is the shop 10 lb. */

export const LOAD_LB = 10;
export const HAUL_TRAVEL = 0.7;
export const LOAD_H = 0.4;
export const LOAD_W = 0.5;
export const BEAM_Y = 2.06;
export const BEAM_H = 0.14;
export const BEAM_BOTTOM = BEAM_Y - BEAM_H / 2;

const TACKLE_R = 0.22;

export function supportingParts(configId, parts) {
  if (configId === 'fixed') return 1;
  if (configId === 'movable') return 2;
  const n = Math.round(Number(parts));
  if (n < 2) return 2;
  if (n > 4) return 4;
  return n;
}

export function solve(configId, parts) {
  const supporting = supportingParts(configId, parts);
  const pull = configId === 'movable' ? 'up' : 'down';
  return {
    configId,
    supporting,
    ma: supporting,
    pull,
    loadForce: LOAD_LB,
    effortForce: LOAD_LB / supporting,
    ropePerInch: supporting,
  };
}

export const CONFIG_META = {
  fixed: {
    name: 'Fixed',
    order: 'The wheel stays on the support. One rope part holds the load.',
    shop: 'Flag halyard, clothesline, window sash.',
    between: 'The pulley only turns the pull downward.',
  },
  movable: {
    name: 'Movable',
    order: 'The wheel rides with the load. Two rope parts hold it.',
    shop: 'A hay hoist, a bosun’s chair.',
    between: 'You pull up, and the load rises half as far as the rope.',
  },
  tackle: {
    name: 'Block and tackle',
    order: 'A fixed block and a movable block share the rope.',
    shop: 'A barn hoist, a sail halyard, an engine lift.',
    between: 'Count the brass parts between the blocks. That count is the ideal advantage.',
  },
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function line(x, y0, y1, role) {
  return { from: [x, y0], to: [x, y1], role };
}

function sheave(id, x, y, r, role) {
  return { id, x, y, z: 0, r, role, spinSign: role === 'fixed' ? -1 : 1 };
}

function blockFrom(sheaves, role, extraX) {
  const group = sheaves.filter((item) => item.role === role);
  if (!group.length) return null;
  const xs = group.map((item) => item.x);
  if (Number.isFinite(extraX)) xs.push(extraX);
  const r = group[0].r;
  const min = Math.min(...xs) - r - 0.1;
  const max = Math.max(...xs) + r + 0.1;
  return {
    role,
    x: (min + max) / 2,
    y: group[0].y,
    w: max - min,
    h: r * 2 + 0.2,
  };
}

function hangersFor(block) {
  if (!block) return [];
  const top = block.y + block.h / 2;
  if (block.w < 0.7) {
    return [{ x: block.x, y0: BEAM_BOTTOM, y1: top }];
  }
  const inset = Math.min(block.w * 0.28, 0.34);
  return [
    { x: block.x - block.w / 2 + inset, y0: BEAM_BOTTOM, y1: top },
    { x: block.x + block.w / 2 - inset, y0: BEAM_BOTTOM, y1: top },
  ];
}

function supportBadges(xs, upperY, lowerY) {
  const y = (upperY + lowerY) / 2;
  return xs.map((x, index) => ({ x, y, n: index + 1 }));
}

function layoutFixed(lift) {
  const solved = solve('fixed');
  const rise = clamp01(lift) * HAUL_TRAVEL;
  const r = 0.4;
  const upperY = 1.26;
  const hookY = 0.02 + rise;
  const haulY = 0.42 - rise;
  const xL = -r;
  const xR = r;
  const wheel = sheave('fixed', 0, upperY, r, 'fixed');
  const loadTop = hookY;
  const load = { x: xL, y: loadTop - LOAD_H / 2, top: loadTop };
  const block = blockFrom([wheel], 'fixed');
  return {
    solved,
    lift: clamp01(lift),
    haul: rise,
    sheaves: [wheel],
    arcs: [{ sheaveId: 'fixed', half: 'top', role: 'redirect' }],
    lines: [
      line(xL, upperY, hookY, 'support'),
      line(xR, upperY, haulY, 'haul'),
    ],
    blocks: [block],
    hangers: hangersFor(block),
    load,
    shackle: null,
    effort: { x: xR, y: haulY, dir: -1 },
    standing: null,
    fixedLabel: { x: -r - 0.15, y: upperY + 0.08 },
    movableLabel: null,
    parts: supportBadges([xL], upperY, hookY),
  };
}

function layoutMovable(lift) {
  const solved = solve('movable');
  const t = clamp01(lift);
  const rise = (t * HAUL_TRAVEL) / 2;
  const r = 0.36;
  const sheaveY = 0.24 + rise;
  const handY = 0.66 + t * HAUL_TRAVEL;
  const xL = -r;
  const xR = r;
  const wheel = sheave('movable', 0, sheaveY, r, 'movable');
  const loadTop = sheaveY - r - 0.1;
  const load = { x: 0, y: loadTop - LOAD_H / 2, top: loadTop };
  const block = blockFrom([wheel], 'movable');
  return {
    solved,
    lift: t,
    haul: t * HAUL_TRAVEL,
    sheaves: [wheel],
    arcs: [{ sheaveId: 'movable', half: 'bottom', role: 'support' }],
    lines: [
      line(xL, BEAM_BOTTOM, sheaveY, 'support'),
      line(xR, sheaveY, handY, 'support'),
    ],
    blocks: [block],
    hangers: [],
    load,
    shackle: { x: 0, y0: sheaveY - r - 0.02, y1: loadTop },
    effort: { x: xR, y: handY, dir: 1 },
    standing: { x: xL, y: BEAM_BOTTOM },
    fixedLabel: null,
    movableLabel: { x: 0, y: sheaveY + r + 0.18 },
    parts: [
      { x: xL, y: (BEAM_BOTTOM + sheaveY) / 2, n: 1 },
      { x: xR, y: (sheaveY + handY) / 2, n: 2 },
    ],
  };
}

function layoutTackle(parts, lift) {
  const solved = solve('tackle', parts);
  const n = solved.supporting;
  const t = clamp01(lift);
  const rise = (t * HAUL_TRAVEL) / n;
  const r = TACKLE_R;
  const spacing = r * 2;
  const lineCount = n + 1;
  const x0 = -((lineCount - 1) * spacing) / 2;
  const xs = Array.from({ length: lineCount }, (_, index) => x0 + index * spacing);
  const upperY = 1.48;
  const lowerY = 0.2 + rise;
  const haulY = 0.5 - t * HAUL_TRAVEL;
  const even = n % 2 === 0;
  const sheaves = [];
  const arcs = [];
  for (let index = 0; index < n; index += 1) {
    const lower = even ? index % 2 === 0 : index % 2 === 1;
    const id = `s${index}`;
    sheaves.push(sheave(id, (xs[index] + xs[index + 1]) / 2, lower ? lowerY : upperY, r, lower ? 'movable' : 'fixed'));
    arcs.push({ sheaveId: id, half: lower ? 'bottom' : 'top', role: lower ? 'support' : 'redirect' });
  }
  const lines = [];
  for (let index = 0; index < n; index += 1) {
    const top = even && index === 0 ? BEAM_BOTTOM : upperY;
    lines.push(line(xs[index], top, lowerY, 'support'));
  }
  lines.push(line(xs[n], upperY, haulY, 'haul'));
  const standing = even
    ? { x: xs[0], y: BEAM_BOTTOM }
    : { x: xs[0], y: lowerY };
  const fixedBlock = blockFrom(sheaves, 'fixed');
  const movableBlock = blockFrom(sheaves, 'movable', even ? undefined : standing.x);
  const supportX = xs.slice(0, n);
  const loadX = supportX.reduce((sum, value) => sum + value, 0) / supportX.length;
  const loadTop = lowerY - r - 0.16;
  return {
    solved,
    lift: t,
    haul: t * HAUL_TRAVEL,
    sheaves,
    arcs,
    lines,
    blocks: [fixedBlock, movableBlock].filter(Boolean),
    hangers: hangersFor(fixedBlock),
    load: { x: loadX, y: loadTop - LOAD_H / 2, top: loadTop },
    shackle: { x: loadX, y0: lowerY - r - 0.02, y1: loadTop },
    effort: { x: xs[n], y: haulY, dir: -1 },
    standing,
    fixedLabel: fixedBlock ? { x: fixedBlock.x, y: upperY + r + 0.2 } : null,
    movableLabel: { x: loadX, y: lowerY + r + 0.16 },
    parts: supportBadges(supportX, upperY, lowerY),
  };
}

export function layout(configId, parts, lift) {
  if (configId === 'fixed') return layoutFixed(lift);
  if (configId === 'movable') return layoutMovable(lift);
  return layoutTackle(parts, lift);
}

export function ropeLength(spec) {
  let total = 0;
  for (const item of spec.lines) {
    const dx = item.to[0] - item.from[0];
    const dy = item.to[1] - item.from[1];
    total += Math.hypot(dx, dy);
  }
  for (const arc of spec.arcs) {
    const wheel = spec.sheaves.find((item) => item.id === arc.sheaveId);
    total += Math.PI * wheel.r;
  }
  return total;
}
