// -------------------------------------------------------------------------
// Binomial confidence intervals, implemented from first principles.
//
// Preregistration 001 §2 names three interval methods for its endpoints:
//   - Clopper–Pearson exact  (H1, silent-divergence upper bound)
//   - Newcombe hybrid-score   (H2, difference of two proportions)
//   - Wilson score            (H3, single-proportion lower bound)
//
// No statistics dependency is pulled in: the analysis script is part of the
// registered commit and every number it reports must be reproducible from the
// source alone. All intervals are two-sided 95% by default.
// -------------------------------------------------------------------------

/** Two-sided z for a 95% interval (1 - alpha, alpha = 0.05). */
export const Z_95 = 1.959963984540054;

export interface Interval {
  lower: number;
  upper: number;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Wilson score interval for a binomial proportion. Closed form; anchored in the
 * tests against published values (0/120 -> [0, 0.0310], 108/120 ->
 * [0.8333, 0.9419]).
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): Interval {
  if (trials <= 0) {
    return { lower: 0, upper: 1 };
  }
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const halfWidth =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    lower: clamp01(center - halfWidth),
    upper: clamp01(center + halfWidth),
  };
}

// --- Regularized incomplete beta, for the Clopper–Pearson (exact) interval ---

/** Lanczos approximation of ln Γ(x). */
function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941678, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += cof[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

/** Continued-fraction expansion for the incomplete beta (Numerical Recipes). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-14;
  const FLOOR = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FLOOR) d = FLOOR;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FLOOR) d = FLOOR;
    c = 1 + aa / c;
    if (Math.abs(c) < FLOOR) c = FLOOR;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FLOOR) d = FLOOR;
    c = 1 + aa / c;
    if (Math.abs(c) < FLOOR) c = FLOOR;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function regularizedIncompleteBeta(
  a: number,
  b: number,
  x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Inverse of the regularized incomplete beta (the Beta(a, b) quantile). Solved
 * by bisection on [0, 1]; I_x(a, b) is monotone increasing in x, so 200 halving
 * steps resolve x far below 4-decimal reporting precision and are fully
 * deterministic.
 */
export function betaQuantile(
  probability: number,
  a: number,
  b: number,
): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < probability) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/**
 * Clopper–Pearson exact interval for a binomial proportion, built from Beta
 * quantiles. Anchored in the tests against the preregistration's own reference
 * (0/120 -> upper 0.0303, at or below the H1 threshold of 0.05).
 */
export function clopperPearsonInterval(
  successes: number,
  trials: number,
  confidence = 0.95,
): Interval {
  if (trials <= 0) {
    return { lower: 0, upper: 1 };
  }
  const alpha = 1 - confidence;
  const lower =
    successes === 0
      ? 0
      : betaQuantile(alpha / 2, successes, trials - successes + 1);
  const upper =
    successes === trials
      ? 1
      : betaQuantile(1 - alpha / 2, successes + 1, trials - successes);
  return { lower: clamp01(lower), upper: clamp01(upper) };
}

/**
 * Newcombe hybrid-score interval (method 10 of Newcombe 1998) for the
 * difference p1 - p2 between two independent proportions. Each group's Wilson
 * roots are combined by the square-and-add rule:
 *   L = (p1 - p2) - sqrt((p1 - l1)^2 + (u2 - p2)^2)
 *   U = (p1 - p2) + sqrt((u1 - p1)^2 + (p2 - l2)^2)
 * where (l1, u1) and (l2, u2) are the Wilson intervals for group 1 and group 2.
 */
export function newcombeDifferenceInterval(
  successes1: number,
  trials1: number,
  successes2: number,
  trials2: number,
  z: number = Z_95,
): Interval {
  const p1 = trials1 === 0 ? 0 : successes1 / trials1;
  const p2 = trials2 === 0 ? 0 : successes2 / trials2;
  const g1 = wilsonInterval(successes1, trials1, z);
  const g2 = wilsonInterval(successes2, trials2, z);
  const difference = p1 - p2;
  const lower =
    difference - Math.sqrt((p1 - g1.lower) ** 2 + (g2.upper - p2) ** 2);
  const upper =
    difference + Math.sqrt((g1.upper - p1) ** 2 + (p2 - g2.lower) ** 2);
  return {
    lower: Math.max(-1, lower),
    upper: Math.min(1, upper),
  };
}
