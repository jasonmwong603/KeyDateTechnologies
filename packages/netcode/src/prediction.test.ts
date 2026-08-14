import { describe, expect, it } from 'vitest';
import { PredictionBuffer, needsCorrection } from './prediction.js';

/**
 * A one-dimensional stand-in for the real simulation. Prediction does not care
 * what the step function does, only that client and server run the same one.
 */
interface TestState {
  x: number;
}
interface TestInput {
  dx: number;
}

const step = (state: TestState, input: TestInput): TestState => ({ x: state.x + input.dx });

describe('PredictionBuffer', () => {
  it('hands out increasing sequence numbers', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    expect(buffer.record({ dx: 1 })).toBe(1);
    expect(buffer.record({ dx: 1 })).toBe(2);
    expect(buffer.record({ dx: 1 })).toBe(3);
    expect(buffer.pendingCount).toBe(3);
  });

  it('drops acknowledged inputs and replays only the rest', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    for (let i = 0; i < 5; i += 1) buffer.record({ dx: 10 });

    // Server has consumed the first three; its state reflects 3 * 10.
    const corrected = buffer.reconcile({ authoritative: { x: 30 }, ackedSeq: 3, step });

    // The two unacknowledged frames are replayed on top.
    expect(corrected.x).toBe(50);
    expect(buffer.pendingCount).toBe(2);
  });

  it('lands exactly where the client already predicted when the server agrees', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    let predicted: TestState = { x: 0 };
    for (let i = 0; i < 4; i += 1) {
      const input = { dx: 7 };
      buffer.record(input);
      predicted = step(predicted, input);
    }

    // Server acknowledges two of the four and reports the matching state.
    const corrected = buffer.reconcile({ authoritative: { x: 14 }, ackedSeq: 2, step });
    expect(corrected).toEqual(predicted);
  });

  it('applies the server correction when prediction was wrong', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    buffer.record({ dx: 5 });
    buffer.record({ dx: 5 });

    // The player was actually blocked: the server never moved them.
    const corrected = buffer.reconcile({ authoritative: { x: 0 }, ackedSeq: 1, step });
    expect(corrected.x).toBe(5);
  });

  it('clears everything on reset', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    buffer.record({ dx: 1 });
    buffer.reset();
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.reconcile({ authoritative: { x: 99 }, ackedSeq: 0, step }).x).toBe(99);
  });

  it('acknowledging everything leaves the server state untouched', () => {
    const buffer = new PredictionBuffer<TestState, TestInput>();
    buffer.record({ dx: 3 });
    buffer.record({ dx: 3 });
    const corrected = buffer.reconcile({ authoritative: { x: 6 }, ackedSeq: 2, step });
    expect(corrected.x).toBe(6);
    expect(buffer.pendingCount).toBe(0);
  });
});

describe('needsCorrection', () => {
  it('ignores drift below the tolerance', () => {
    expect(needsCorrection({ x: 0, y: 0, z: 0 }, { x: 0.01, y: 0.01, z: 0.01 })).toBe(false);
  });

  it('flags divergence above the tolerance', () => {
    expect(needsCorrection({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(true);
  });

  it('measures distance in three dimensions, not per axis', () => {
    // Each axis is under the 0.05 tolerance alone, but the combined distance
    // (~0.069) is not — a per-axis check would wrongly let this through.
    expect(needsCorrection({ x: 0, y: 0, z: 0 }, { x: 0.04, y: 0.04, z: 0.04 })).toBe(true);
  });
});
