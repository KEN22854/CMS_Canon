import { describe, expect, it } from 'vitest';
import { analyze, inverseNormal, normalCdf, probBeat, requiredSampleSize, twoProportionP, wilson } from '../../src/modules/experiences/stats';

describe('A/B statistics', () => {
  it('has accurate normal functions', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(inverseNormal(0.975)).toBeCloseTo(1.96, 2);
    expect(inverseNormal(0.8)).toBeCloseTo(0.8416, 3);
  });

  it('computes Wilson intervals, p-values and probability to beat control', () => {
    const [lo, hi] = wilson(50, 1000);
    expect(lo).toBeCloseTo(0.0381, 3);
    expect(hi).toBeCloseTo(0.0653, 3);
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(twoProportionP(100, 2000, 140, 2000)!).toBeLessThan(0.01);
    expect(twoProportionP(100, 2000, 104, 2000)!).toBeGreaterThan(0.5);
    expect(probBeat(100, 2000, 140, 2000)).toBeGreaterThan(0.99);
    expect(probBeat(140, 2000, 100, 2000)).toBeLessThan(0.01);
  });

  it('plans sample sizes like standard calculators', () => {
    // 5% baseline, +20% relative lift, α=0.05, power 0.8 → ≈ 8,150 per arm.
    const n = requiredSampleSize(0.05, 0.2);
    expect(n).toBeGreaterThan(7_900);
    expect(n).toBeLessThan(8_400);
  });

  it('never declares a winner before the planned sample size', () => {
    const early = analyze([{ id: 'control', name: 'A', exposures: 200, conversions: 10 }, { id: 'b', name: 'B', exposures: 200, conversions: 25 }]);
    expect(early.verdict).toBe('collecting');
    expect(early.leaderId).toBe('b');
    const done = analyze([{ id: 'control', name: 'A', exposures: 40_000, conversions: 2_000 }, { id: 'b', name: 'B', exposures: 40_000, conversions: 2_300 }], { mde: 0.1 });
    expect(done.verdict).toBe('winner');
    expect(done.variants[1]!.uplift).toBeCloseTo(0.15, 2);
    const flat = analyze([{ id: 'control', name: 'A', exposures: 40_000, conversions: 2_000 }, { id: 'b', name: 'B', exposures: 40_000, conversions: 2_010 }]);
    expect(flat.verdict).toBe('no_difference');
    const worse = analyze([{ id: 'control', name: 'A', exposures: 40_000, conversions: 2_300 }, { id: 'b', name: 'B', exposures: 40_000, conversions: 2_000 }]);
    expect(worse.verdict).toBe('control_wins');
  });
});
