/**
 * Simulation tuning.
 *
 * These values are part of the network contract, not just feel: the client
 * predicts with exactly these numbers and the server corrects with exactly
 * these numbers. Changing one without redeploying both sides shows up as
 * rubber-banding, so they live in shared code rather than in either app.
 */

/** Simulation frequency, in Hz. Fixed — never tied to render framerate. */
export const TICK_RATE = 30;

/** Seconds per simulated tick. */
export const TICK_DT = 1 / TICK_RATE;

/** Player capsule, approximated as a box for collision. */
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
/** Camera height above the player's feet in first person. */
export const PLAYER_EYE_HEIGHT = 1.65;

export const WALK_SPEED = 4.2;
export const SPRINT_SPEED = 7.4;
/** How fast horizontal velocity chases the desired velocity, in m/s^2. */
export const GROUND_ACCEL = 45;
/** Air control is deliberately weak so jumping is not a movement exploit. */
export const AIR_ACCEL = 8;
export const GROUND_FRICTION = 38;
export const GRAVITY = 22;
export const JUMP_VELOCITY = 7.2;

/**
 * How close a player must stand to an interactable to trigger it, in metres.
 *
 * Sized by the worst approach, which is straight at a stool. Six of them ring
 * every table at 2.1m, and a player walking head-on into one comes to rest
 * about 2.76m from the table's centre — their own half-width plus the stool's,
 * with no room to slide either way. Anything under that and a table would be
 * reachable only from the angles that happen to line up with a gap between
 * stools, which is a maddening thing to debug and a worse thing to play.
 *
 * Walking in between two stools still gets you to about 1.69m, stopped by the
 * table body itself.
 */
export const INTERACT_RANGE = 3.1;

/**
 * Extra range the server allows on top of `INTERACT_RANGE`.
 *
 * The client decides whether to show the "sit here" prompt using its *predicted*
 * position, which is slightly ahead of the server's. Without a margin, a player
 * who presses the key exactly as the prompt appears can have their request
 * rejected by a server that has not seen them arrive yet.
 *
 * It is kept small on purpose: every centimetre here is distance a player can
 * interact from while the UI says they cannot.
 */
export const INTERACT_RANGE_SERVER_TOLERANCE = 0.75;

/**
 * Ledge tolerance. Without this, the sub-millimetre gap between two floor
 * boxes reads as "not grounded" and the player cannot jump while walking
 * across a seam.
 */
export const GROUND_EPSILON = 0.02;
