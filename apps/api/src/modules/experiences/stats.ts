/**
 * A/B statistics for conversion experiments. Two views of the same counts, because they answer
 * different questions: the frequentist z-test ("is the difference real at α?") gates decisions,
 * the Bayesian probability-to-beat-control is what people actually want to read. A winner is
 * declared only when both agree *and* the planned sample size is reached — peeking at an
 * under-powered test is the most common way A/B tests lie.
 */
export interface VariantCounts {
  id: string;
  name: string;
  exposures: number;
  conversions: number;
}

export interface VariantStats extends VariantCounts {
  isControl: boolean;
  rate: number;
  ci95: [number, number];
  /** Relative to control: 0.12 = +12%. Null for the control itself or when control has no conversions. */
  uplift: number | null;
  pValue: number | null;
  probBeatControl: number | null;
}

export type Verdict = 'collecting' | 'winner' | 'control_wins' | 'no_difference' | 'inconclusive';

export interface Analysis {
  variants: VariantStats[];
  requiredPerVariant: number;
  progress: number;
  verdict: Verdict;
  leaderId: string | null;
}

/** Abramowitz & Stegun 7.1.26; |error| < 1.5e-7, plenty for p-values. */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-((x / Math.SQRT2) ** 2));
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Wilson score interval: honest even at 0 or 100% conversion and small n. */
export function wilson(conversions: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = conversions / n;
  const denom = 1 + z ** 2 / n;
  const centre = (p + z ** 2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Two-sided two-proportion z-test p-value. */
export function twoProportionP(c1: number, n1: number, c2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (c2 / n2 - c1 / n1) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** P(rate_B > rate_A) under Beta(1+c, 1+n−c) posteriors, normal approximation. */
export function probBeat(cA: number, nA: number, cB: number, nB: number): number {
  const beta = (c: number, n: number) => {
    const a = 1 + c;
    const b = 1 + n - c;
    return { mean: a / (a + b), variance: (a * b) / ((a + b) ** 2 * (a + b + 1)) };
  };
  const A = beta(cA, nA);
  const B = beta(cB, nB);
  return normalCdf((B.mean - A.mean) / Math.sqrt(A.variance + B.variance));
}

/** Visitors per variant to detect a relative lift of `mde` over `baseline` (α two-sided, power). */
export function requiredSampleSize(baseline: number, mde = 0.1, alpha = 0.05, power = 0.8): number {
  const p1 = Math.min(0.99, Math.max(0.001, baseline));
  const p2 = Math.min(0.999, p1 * (1 + mde));
  const zA = inverseNormal(1 - alpha / 2);
  const zB = inverseNormal(power);
  const pBar = (p1 + p2) / 2;
  const n = (zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}

/** Acklam's rational approximation of the normal quantile. */
export function inverseNormal(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function analyze(variants: VariantCounts[], opts: { controlId?: string; mde?: number; alpha?: number } = {}): Analysis {
  const alpha = opts.alpha ?? 0.05;
  const control = variants.find((v) => v.id === (opts.controlId ?? 'control')) ?? variants[0];
  if (!control) return { variants: [], requiredPerVariant: 0, progress: 0, verdict: 'collecting', leaderId: null };
  const cRate = control.exposures ? control.conversions / control.exposures : 0;
  // Before control has converted anyone, plan for a typical 5% baseline.
  const required = requiredSampleSize(cRate > 0 ? cRate : 0.05, opts.mde ?? 0.1, alpha);
  const stats: VariantStats[] = variants.map((v) => {
    const isControl = v.id === control.id;
    const rate = v.exposures ? v.conversions / v.exposures : 0;
    return {
      ...v,
      isControl,
      rate,
      ci95: wilson(v.conversions, v.exposures),
      // No visitors yet means "unknown", not -100%.
      uplift: isControl || cRate === 0 || !v.exposures ? null : (rate - cRate) / cRate,
      pValue: isControl ? null : twoProportionP(control.conversions, control.exposures, v.conversions, v.exposures),
      probBeatControl: isControl || !v.exposures || !control.exposures ? null : probBeat(control.conversions, control.exposures, v.conversions, v.exposures),
    };
  });
  const minN = Math.min(...variants.map((v) => v.exposures));
  const progress = Math.min(1, minN / required);
  const challengers = stats.filter((s) => !s.isControl);
  const significant = challengers.filter((s) => s.pValue !== null && s.pValue < alpha);
  const best = [...challengers].sort((a, b) => (b.probBeatControl ?? 0) - (a.probBeatControl ?? 0))[0];
  let verdict: Verdict;
  let leaderId: string | null = best && (best.probBeatControl ?? 0) > 0.5 ? best.id : control.id;
  if (progress < 1) verdict = 'collecting';
  else if (best && significant.includes(best) && (best.probBeatControl ?? 0) >= 0.95) verdict = 'winner';
  else if (challengers.length && challengers.every((s) => significant.includes(s) && (s.probBeatControl ?? 1) <= 0.05)) {
    verdict = 'control_wins';
    leaderId = control.id;
  } else if (!significant.length) verdict = 'no_difference';
  else verdict = 'inconclusive';
  return { variants: stats, requiredPerVariant: required, progress, verdict, leaderId };
}
