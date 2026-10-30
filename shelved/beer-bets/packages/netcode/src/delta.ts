/**
 * Snapshot delta encoding.
 *
 * At 30Hz with a room full of players, sending every field of every entity
 * every tick is mostly retransmitting numbers that did not change. Deltas send
 * only what moved, against a baseline the client is known to hold.
 */

export interface Baseline<T> {
  tick: number;
  entities: Map<number, T>;
}

/** Fields worth quantising before comparison, so sub-millimetre noise is not "a change". */
export interface DeltaOptions {
  /** Positions are compared at this resolution, in metres. */
  positionEpsilon?: number;
  /** Angles are compared at this resolution, in radians. */
  angleEpsilon?: number;
}

const POSITION_KEYS = ['x', 'y', 'z'] as const;
const ANGLE_KEYS = ['yaw', 'pitch'] as const;

function changed(key: string, a: unknown, b: unknown, options: Required<DeltaOptions>): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    const epsilon = (POSITION_KEYS as readonly string[]).includes(key)
      ? options.positionEpsilon
      : (ANGLE_KEYS as readonly string[]).includes(key)
        ? options.angleEpsilon
        : 0;
    return Math.abs(a - b) > epsilon;
  }
  return a !== b;
}

/**
 * Returns the subset of `current`'s fields that differ from `previous`.
 *
 * Returns null when nothing changed, so the caller can omit the entity from the
 * snapshot entirely — an idle player at a table costs zero bytes per tick.
 */
export function diffEntity<T extends object>(
  previous: T | undefined,
  current: T,
  idKey: keyof T,
  options: DeltaOptions = {},
): Partial<T> | null {
  const resolved: Required<DeltaOptions> = {
    positionEpsilon: options.positionEpsilon ?? 0.001,
    angleEpsilon: options.angleEpsilon ?? 0.001,
  };

  if (previous === undefined) return { ...current };

  const delta: Partial<T> = {};
  let dirty = false;

  // Snapshots are plain data objects; reading them through an index signature
  // keeps this generic over any replicated entity shape.
  const previousFields = previous as Record<string, unknown>;
  const currentFields = current as Record<string, unknown>;

  for (const key of Object.keys(currentFields)) {
    if (changed(key, previousFields[key], currentFields[key], resolved)) {
      (delta as Record<string, unknown>)[key] = currentFields[key];
      dirty = true;
    }
  }

  if (!dirty) return null;
  // The id is what lets the client apply the delta to the right entity, so it
  // rides along even though it never changes.
  delta[idKey] = current[idKey];
  return delta;
}

/** Applies a delta onto a baseline entity, producing the full current state. */
export function applyEntityDelta<T extends object>(baseline: T | undefined, delta: Partial<T>): T {
  return { ...(baseline ?? ({} as T)), ...delta };
}
