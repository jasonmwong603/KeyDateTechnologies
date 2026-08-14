import { generateSessionCode, isSessionCode } from '@keydate/protocol';
import { WorldInstance } from './worldInstance.js';

/**
 * Maps session codes to running worlds.
 *
 * A session code is how a group of friends ends up in the same instance. The
 * public world always exists; private worlds are created on demand when someone
 * joins a code that has no instance yet, and are torn down once empty.
 */

export const PUBLIC_SESSION_CODE = 'LOBBY';

export class SessionRegistry {
  private readonly worlds = new Map<string, WorldInstance>();

  constructor(private readonly random: () => number = Math.random) {
    this.worlds.set(PUBLIC_SESSION_CODE, new WorldInstance(PUBLIC_SESSION_CODE));
  }

  get all(): readonly WorldInstance[] {
    return [...this.worlds.values()];
  }

  get(code: string): WorldInstance | undefined {
    return this.worlds.get(code);
  }

  /**
   * Resolves the world a joining player belongs in.
   *
   * An unrecognised but well-formed code creates that world rather than
   * failing — this is how "make up a code and tell your friends" works without
   * a separate create step.
   */
  resolve(requestedCode: string | undefined): WorldInstance {
    if (requestedCode === undefined || requestedCode === '') {
      return this.worlds.get(PUBLIC_SESSION_CODE) as WorldInstance;
    }

    const code = requestedCode.toUpperCase();
    const existing = this.worlds.get(code);
    if (existing !== undefined) return existing;

    if (!isSessionCode(code) && code !== PUBLIC_SESSION_CODE) {
      return this.worlds.get(PUBLIC_SESSION_CODE) as WorldInstance;
    }

    const world = new WorldInstance(code);
    this.worlds.set(code, world);
    return world;
  }

  /** Allocates a code that is not currently in use. */
  allocateCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = generateSessionCode(this.random);
      if (!this.worlds.has(code)) return code;
    }
    // 24^5 codes against a handful of live worlds makes this effectively
    // unreachable, but a caller still deserves a defined answer.
    throw new Error('Could not allocate an unused session code.');
  }

  /** Advances every world by one tick. */
  update(): void {
    for (const world of this.worlds.values()) world.update();
  }

  /** Drops empty private worlds. The public world is never collected. */
  collectEmpty(): void {
    for (const [code, world] of this.worlds) {
      if (code === PUBLIC_SESSION_CODE) continue;
      if (world.playerCount === 0) this.worlds.delete(code);
    }
  }
}
