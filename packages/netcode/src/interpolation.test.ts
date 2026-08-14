import { describe, expect, it } from 'vitest';
import { InterpolationBuffer } from './interpolation.js';

interface Sample {
  tick: number;
  x: number;
}

/** 30Hz ticks with a 100ms render delay — exactly three ticks behind. */
function makeBuffer(): InterpolationBuffer<Sample> {
  return new InterpolationBuffer<Sample>({ tickIntervalMs: 1000 / 30, delayMs: 100 });
}

describe('InterpolationBuffer', () => {
  it('returns null while empty', () => {
    expect(makeBuffer().sampleAt(10)).toBeNull();
  });

  it('interpolates between the two samples straddling the render time', () => {
    const buffer = makeBuffer();
    buffer.push({ tick: 10, x: 0 });
    buffer.push({ tick: 11, x: 10 });
    buffer.push({ tick: 12, x: 20 });
    buffer.push({ tick: 13, x: 30 });

    // Render time is tick 13 - 3 = 10, so it should sit right on the first sample.
    const result = buffer.sampleAt(13);
    expect(result).not.toBeNull();
    expect(result?.from.tick).toBe(10);
    expect(result?.t).toBeCloseTo(0, 6);
  });

  it('blends halfway between samples', () => {
    const buffer = new InterpolationBuffer<Sample>({ tickIntervalMs: 1000 / 30, delayMs: 50 });
    buffer.push({ tick: 10, x: 0 });
    buffer.push({ tick: 11, x: 10 });
    buffer.push({ tick: 12, x: 20 });

    // 50ms at 33.3ms/tick is 1.5 ticks of delay: render time is tick 10.5.
    const result = buffer.sampleAt(12);
    expect(result?.from.tick).toBe(10);
    expect(result?.to.tick).toBe(11);
    expect(result?.t).toBeCloseTo(0.5, 5);
  });

  it('holds still rather than extrapolating when the buffer runs dry', () => {
    const buffer = makeBuffer();
    buffer.push({ tick: 10, x: 100 });

    // Render time is well past the newest sample: freeze on it, do not guess.
    const result = buffer.sampleAt(30);
    expect(result?.from.x).toBe(100);
    expect(result?.to.x).toBe(100);
    expect(result?.t).toBe(1);
  });

  it('clamps to the oldest sample when the render time predates the buffer', () => {
    const buffer = makeBuffer();
    buffer.push({ tick: 50, x: 5 });
    buffer.push({ tick: 51, x: 6 });

    const result = buffer.sampleAt(10);
    expect(result?.from.tick).toBe(50);
    expect(result?.t).toBe(0);
  });

  it('accepts out-of-order arrivals and keeps the buffer sorted', () => {
    const buffer = makeBuffer();
    buffer.push({ tick: 10, x: 0 });
    buffer.push({ tick: 12, x: 20 });
    // A reordered packet, which is routine on a real network.
    buffer.push({ tick: 11, x: 10 });

    const result = buffer.sampleAt(14);
    expect(result?.from.tick).toBe(11);
    expect(result?.to.tick).toBe(12);
  });

  it('replaces a resent sample rather than duplicating the tick', () => {
    const buffer = makeBuffer();
    buffer.push({ tick: 10, x: 0 });
    buffer.push({ tick: 10, x: 999 });
    expect(buffer.size).toBe(1);
    expect(buffer.latest?.x).toBe(999);
  });

  it('bounds its memory use', () => {
    const buffer = new InterpolationBuffer<Sample>({ tickIntervalMs: 33, maxSamples: 8 });
    for (let tick = 0; tick < 100; tick += 1) buffer.push({ tick, x: tick });
    expect(buffer.size).toBe(8);
    expect(buffer.latest?.tick).toBe(99);
  });
});
