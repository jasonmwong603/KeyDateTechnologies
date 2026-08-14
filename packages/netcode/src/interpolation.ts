/**
 * Entity interpolation for everyone who is not the local player.
 *
 * Remote avatars arrive as discrete snapshots at the tick rate. Drawing them at
 * the newest snapshot makes them stutter and teleport. Instead the client
 * renders them slightly in the past — by `delayMs` — and interpolates between
 * the two snapshots that straddle that render time. The cost is that you see
 * others where they were ~100ms ago; the benefit is smooth motion that survives
 * jitter and the occasional dropped packet.
 */

export interface Timestamped {
  /** Server tick this sample belongs to. */
  tick: number;
}

export interface InterpolationOptions {
  /** How far behind the newest snapshot to render, in milliseconds. */
  delayMs?: number;
  /** Milliseconds per server tick. */
  tickIntervalMs: number;
  /** Snapshots retained. Two would be the minimum; more absorbs packet loss. */
  maxSamples?: number;
}

export class InterpolationBuffer<T extends Timestamped> {
  private samples: T[] = [];
  private readonly delayMs: number;
  private readonly tickIntervalMs: number;
  private readonly maxSamples: number;

  constructor(options: InterpolationOptions) {
    this.delayMs = options.delayMs ?? 100;
    this.tickIntervalMs = options.tickIntervalMs;
    this.maxSamples = options.maxSamples ?? 32;
  }

  /** Inserts a snapshot, keeping the buffer ordered by tick. */
  push(sample: T): void {
    const last = this.samples[this.samples.length - 1];
    if (last === undefined || sample.tick > last.tick) {
      this.samples.push(sample);
    } else if (sample.tick === last.tick) {
      this.samples[this.samples.length - 1] = sample;
    } else {
      // Out-of-order arrival: splice it into place rather than dropping it,
      // since it may still be needed as the older half of an interpolation pair.
      const index = this.samples.findIndex((entry) => entry.tick > sample.tick);
      if (index === -1) this.samples.push(sample);
      else this.samples.splice(index, 0, sample);
    }

    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  get latest(): T | undefined {
    return this.samples[this.samples.length - 1];
  }

  get size(): number {
    return this.samples.length;
  }

  /**
   * Returns the two samples straddling the render time, plus the blend factor.
   *
   * `null` means there is nothing to draw yet. When the buffer has run dry —
   * the newest sample is already older than the render time — this returns that
   * sample with `t = 1` on both ends, which holds the entity still rather than
   * extrapolating it into a wall.
   */
  sampleAt(currentTick: number, fractionIntoTick = 0): { from: T; to: T; t: number } | null {
    if (this.samples.length === 0) return null;

    const delayTicks = this.delayMs / this.tickIntervalMs;
    const renderTick = currentTick + fractionIntoTick - delayTicks;

    const newest = this.samples[this.samples.length - 1] as T;
    const oldest = this.samples[0] as T;

    if (renderTick >= newest.tick) return { from: newest, to: newest, t: 1 };
    if (renderTick <= oldest.tick) return { from: oldest, to: oldest, t: 0 };

    for (let i = this.samples.length - 1; i > 0; i -= 1) {
      const to = this.samples[i] as T;
      const from = this.samples[i - 1] as T;
      if (renderTick >= from.tick && renderTick <= to.tick) {
        const span = to.tick - from.tick;
        const t = span === 0 ? 1 : (renderTick - from.tick) / span;
        return { from, to, t };
      }
    }

    return { from: oldest, to: oldest, t: 0 };
  }

  clear(): void {
    this.samples = [];
  }
}
