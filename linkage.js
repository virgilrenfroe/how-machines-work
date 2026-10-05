/** Crank–rocker four-bar. Lengths are in the same module so the crank is shortest. */
export const DEFAULT_LINKS = {
  crank: 1,
  coupler: 2.55,
  rocker: 2.05,
  ground: 2.35,
};

export function isCrankRocker(links) {
  const lengths = [links.crank, links.coupler, links.rocker, links.ground];
  const sorted = [...lengths].sort((a, b) => a - b);
  const grashof = sorted[0] + sorted[3] < sorted[1] + sorted[2] + 1e-6;
  const crankShortest = links.crank <= Math.min(links.coupler, links.rocker, links.ground) + 1e-6;
  return grashof && crankShortest;
}

function circleIntersect(centerA, radiusA, centerB, radiusB) {
  const dx = centerB.x - centerA.x;
  const dy = centerB.y - centerA.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-8 || dist > radiusA + radiusB || dist < Math.abs(radiusA - radiusB)) return null;
  const along = (radiusA * radiusA - radiusB * radiusB + dist * dist) / (2 * dist);
  const heightSq = radiusA * radiusA - along * along;
  const height = Math.sqrt(Math.max(0, heightSq));
  const ux = dx / dist;
  const uy = dy / dist;
  const px = centerA.x + along * ux;
  const py = centerA.y + along * uy;
  return [
    { x: px + -uy * height, y: py + ux * height },
    { x: px - -uy * height, y: py - ux * height },
  ];
}

/**
 * θ is the crank angle from the ground link, radians.
 * previousC keeps the same assembly so the rocker does not flip.
 */
export function solvePose(theta, links = DEFAULT_LINKS, previousC = null) {
  const A = { x: 0, y: 0 };
  const D = { x: links.ground, y: 0 };
  const B = {
    x: links.crank * Math.cos(theta),
    y: links.crank * Math.sin(theta),
  };
  const hits = circleIntersect(B, links.coupler, D, links.rocker);
  if (!hits) return null;
  let C = hits[0];
  if (previousC) {
    const d0 = (hits[0].x - previousC.x) ** 2 + (hits[0].y - previousC.y) ** 2;
    const d1 = (hits[1].x - previousC.x) ** 2 + (hits[1].y - previousC.y) ** 2;
    C = d1 < d0 ? hits[1] : hits[0];
  } else {
    C = hits[0].y >= hits[1].y ? hits[0] : hits[1];
  }
  return {
    A,
    B,
    C,
    D,
    theta,
    rocker: Math.atan2(C.y - D.y, C.x - D.x),
    coupler: Math.atan2(C.y - B.y, C.x - B.x),
  };
}

/** Point fixed on the coupler, off the B–C line, so its path is a coupler curve. */
export function tracerPoint(pose, along = 0.58, offset = 0.62) {
  const dx = pose.C.x - pose.B.x;
  const dy = pose.C.y - pose.B.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x: pose.B.x + ux * along * len + -uy * offset,
    y: pose.B.y + uy * along * len + ux * offset,
  };
}

export function sampleRevolution(links = DEFAULT_LINKS, steps = 180) {
  const poses = [];
  let previous = null;
  for (let i = 0; i < steps; i += 1) {
    const theta = (i / steps) * Math.PI * 2;
    const pose = solvePose(theta, links, previous);
    if (!pose) return null;
    previous = pose.C;
    poses.push(pose);
  }
  const close = solvePose(0, links, previous);
  if (!close) return null;
  return poses;
}

export function rockerRange(poses) {
  let min = Infinity;
  let max = -Infinity;
  for (const pose of poses) {
    min = Math.min(min, pose.rocker);
    max = Math.max(max, pose.rocker);
  }
  return { min, max };
}

export function toDegrees(radians) {
  return ((radians * 180) / Math.PI + 360) % 360;
}
