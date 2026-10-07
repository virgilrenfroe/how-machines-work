/** Ideal belt drive. Diameters are inches. No slip, no stretch, no friction.
 * Speed ratio in the shop sense: driven diameter / driver diameter.
 * That is also how many times the driver turns while the driven pulley turns once.
 * An open belt keeps the same rotation sense. A crossed belt reverses it.
 */

export const CENTER_IN = 18;
export const MIN_DIAMETER = 3;
export const MAX_DIAMETER = 12;
export const MIN_RPM = 200;
export const MAX_RPM = 3600;
export const DRIVER_RPM = 1750;

export const PRESETS = {
  reducer: { driver: 4, driven: 8, label: 'Reducer' },
  even: { driver: 6, driven: 6, label: '1:1' },
  overdrive: { driver: 8, driven: 4, label: 'Overdrive' },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Open belt. φ is signed, so a larger driver still returns the right length. */
export function openBeltLength(r1, r2, center) {
  const phi = Math.asin((r2 - r1) / center);
  return 2 * center * Math.cos(phi) + r1 * (Math.PI - 2 * phi) + r2 * (Math.PI + 2 * phi);
}

/** Crossed belt. Shaft centers must clear the sum of the radii. */
export function crossedBeltLength(r1, r2, center) {
  const sum = r1 + r2;
  const gamma = Math.asin(sum / center);
  return 2 * center * Math.cos(gamma) + sum * (Math.PI + 2 * gamma);
}

export function solveBelt({ driverDiameter, drivenDiameter, driverRpm, crossed }) {
  const driver = clamp(driverDiameter, MIN_DIAMETER, MAX_DIAMETER);
  const driven = clamp(drivenDiameter, MIN_DIAMETER, MAX_DIAMETER);
  const rpm = clamp(driverRpm, MIN_RPM, MAX_RPM);
  const speedRatio = driven / driver;
  const drivenRpm = rpm * (driver / driven);
  const r1 = driver / 2;
  const r2 = driven / 2;
  const isCrossed = Boolean(crossed);
  const beltLengthIn = isCrossed
    ? crossedBeltLength(r1, r2, CENTER_IN)
    : openBeltLength(r1, r2, CENTER_IN);
  return {
    driverDiameter: driver,
    drivenDiameter: driven,
    driverRpm: rpm,
    crossed: isCrossed,
    centerIn: CENTER_IN,
    speedRatio,
    drivenRpm,
    beltSpeedFpm: (Math.PI * driver * rpm) / 12,
    beltLengthIn,
    sense: isCrossed ? 'opposite' : 'same',
    /** Driven angle per driver angle. Negative when the belt is crossed. */
    spinFactor: (isCrossed ? -1 : 1) * (driver / driven),
  };
}

export function solvePreset(id, driverRpm = DRIVER_RPM, crossed = false) {
  const preset = PRESETS[id] || PRESETS.reducer;
  return solveBelt({
    driverDiameter: preset.driver,
    drivenDiameter: preset.driven,
    driverRpm,
    crossed,
  });
}

export function matchingPreset(driverDiameter, drivenDiameter) {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (Math.abs(preset.driver - driverDiameter) < 0.02 && Math.abs(preset.driven - drivenDiameter) < 0.02) {
      return id;
    }
  }
  return '';
}

export function formatInches(value) {
  return `${value.toFixed(2)} in`;
}

export function formatBeltLength(value) {
  return `${value.toFixed(1)} in`;
}

export function formatRpm(value) {
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return `${Math.round(rounded)} rpm`;
  return `${rounded.toFixed(1)} rpm`;
}

export function formatFpm(value) {
  return `${Math.round(value)} ft/min`;
}

export function speedSentence(solved) {
  if (solved.speedRatio > 1.02) {
    return `The driven pulley is larger, so it turns slower. The driver turns ${solved.speedRatio.toFixed(2)} times while the driven pulley turns once.`;
  }
  if (solved.speedRatio < 0.98) {
    const times = (1 / solved.speedRatio).toFixed(2);
    return `The driven pulley is smaller, so it turns faster. It turns ${times} times while the driver turns once.`;
  }
  return 'The pulleys match, so they turn at the same speed. One turn of the driver is one turn of the driven pulley.';
}

export function senseSentence(solved) {
  if (solved.crossed) {
    return 'The belt is crossed, so the driven pulley turns the other way. The speed ratio stays the same.';
  }
  return 'The belt is open, so both pulleys turn the same way.';
}

export function fitSentence(solved) {
  const path = solved.crossed ? 'A crossed belt' : 'An open belt';
  return `The shaft centers stay ${solved.centerIn.toFixed(0)} in apart. ${path} that fits these pulleys is ${formatBeltLength(solved.beltLengthIn)} long. A shorter belt runs tight and heats the belt and the bearings. A longer belt slips in the groove, glazes, and heats up as it slips.`;
}

export function liveSentence(solved) {
  return `${formatInches(solved.drivenDiameter)} ÷ ${formatInches(solved.driverDiameter)} = ${solved.speedRatio.toFixed(2)}. At ${formatRpm(solved.driverRpm)} on the driver, the driven pulley runs at ${formatRpm(solved.drivenRpm)}. The belt speed is ${formatFpm(solved.beltSpeedFpm)} on both pulleys. ${senseSentence(solved)}`;
}

function pushArc(points, cx, cy, radius, a0, a1, z) {
  const span = Math.abs(a1 - a0);
  const steps = Math.max(16, Math.ceil(span / (Math.PI / 28)));
  const start = points.length ? 1 : 0;
  for (let i = start; i <= steps; i += 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    points.push({
      x: cx + Math.cos(a) * radius,
      y: cy + Math.sin(a) * radius,
      z,
    });
  }
}

function pushLine(points, x0, y0, x1, y1, zAmp) {
  const steps = 22;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const lift = zAmp * (1 - Math.cos(Math.PI * 2 * t)) * 0.5;
    points.push({
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      z: lift,
    });
  }
}

/**
 * Closed centerline of the belt, in the same units as the radii.
 * The loop starts on the driver and walks the outside of each pulley.
 */
export function beltLoop(r1, r2, center, crossed) {
  const points = [];
  if (crossed) {
    const alpha = Math.acos((r1 + r2) / center);
    const driverTop = alpha;
    const driverBot = -alpha;
    const drivenBot = Math.PI + alpha;
    const drivenTop = Math.PI - alpha;
    pushArc(points, 0, 0, r1, driverBot, driverTop - Math.PI * 2, 0);
    pushLine(
      points,
      r1 * Math.cos(driverTop),
      r1 * Math.sin(driverTop),
      center + r2 * Math.cos(drivenBot),
      r2 * Math.sin(drivenBot),
      0.85,
    );
    pushArc(points, center, 0, r2, drivenBot, drivenTop + Math.PI * 2, 0);
    pushLine(
      points,
      center + r2 * Math.cos(drivenTop),
      r2 * Math.sin(drivenTop),
      r1 * Math.cos(driverBot),
      r1 * Math.sin(driverBot),
      -0.85,
    );
  } else {
    const phi = Math.asin((r2 - r1) / center);
    const top = Math.PI / 2 + phi;
    const bot = -(Math.PI / 2 + phi);
    pushArc(points, 0, 0, r1, bot, top - Math.PI * 2, 0);
    pushLine(
      points,
      r1 * Math.cos(top),
      r1 * Math.sin(top),
      center + r2 * Math.cos(top),
      r2 * Math.sin(top),
      0,
    );
    pushArc(points, center, 0, r2, top, bot, 0);
    pushLine(
      points,
      center + r2 * Math.cos(bot),
      r2 * Math.sin(bot),
      r1 * Math.cos(bot),
      r1 * Math.sin(bot),
      0,
    );
  }
  if (points.length > 1) points.pop();
  return { points };
}
