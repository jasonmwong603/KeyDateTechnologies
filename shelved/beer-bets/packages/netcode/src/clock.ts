/**
 * Fixed-timestep accumulator.
 *
 * Wall-clock frame times vary — a browser tab throttles, a server GC pauses —
 * but the simulation must advance in identical discrete steps on both sides or
 * prediction diverges. This converts variable elapsed time into a whole number
 * of fixed ticks.
 */
export class FixedTimestep {
  private accumulator = 0;
  private lastTime: number | null = null;

  constructor(
    private readonly dt: number,
    /**
     * Ceiling on ticks produced by one call. Without it, a tab that was
     * backgrounded for a minute returns and tries to simulate 1800 ticks in one
     * frame, freezing the process — the "spiral of death".
     */
    private readonly maxTicksPerAdvance = 5,
  ) {}

  /** Returns how many fixed ticks to run for the elapsed wall-clock time. */
  advance(now: number): number {
    if (this.lastTime === null) {
      this.lastTime = now;
      return 0;
    }

    const elapsed = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Guard against clock jumps (NTP correction, system sleep).
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;

    this.accumulator += elapsed;

    let ticks = 0;
    while (this.accumulator >= this.dt && ticks < this.maxTicksPerAdvance) {
      this.accumulator -= this.dt;
      ticks += 1;
    }

    // Dropped time is discarded rather than banked, so a long stall does not
    // produce a burst of catch-up ticks on the next frame.
    if (ticks === this.maxTicksPerAdvance) this.accumulator = 0;

    return ticks;
  }

  /**
   * How far into the next tick we are, 0..1. Renderers use this to interpolate
   * between the last two simulated states so motion looks smooth at any
   * framerate above the tick rate.
   */
  get alpha(): number {
    return this.accumulator / this.dt;
  }

  reset(): void {
    this.accumulator = 0;
    this.lastTime = null;
  }
}
