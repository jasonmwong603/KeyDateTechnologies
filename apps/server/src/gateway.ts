import { randomUUID } from 'node:crypto';
import {
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@keydate/protocol';
import { TICK_RATE } from '@keydate/sim';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import type { SessionRegistry } from './sessionRegistry.js';
import type { WorldInstance } from './worldInstance.js';

/**
 * Translates sockets into world intents.
 *
 * Everything security-relevant about an inbound message happens here — parsing,
 * rate limiting, and binding a socket to exactly one player identity — so the
 * world never sees an unvalidated frame or has to ask who is talking.
 */

interface Session {
  socket: WebSocket;
  playerId: string | null;
  world: WorldInstance | null;
  /** Sliding-window counters for the rate limiter. */
  windowStart: number;
  messagesInWindow: number;
  lastSeen: number;
}

export class Gateway {
  private readonly sessions = new Map<WebSocket, Session>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly now: () => number = () => Date.now(),
  ) {}

  handleConnection(socket: WebSocket): void {
    const session: Session = {
      socket,
      playerId: null,
      world: null,
      windowStart: this.now(),
      messagesInWindow: 0,
      lastSeen: this.now(),
    };
    this.sessions.set(socket, session);

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleMessage(session, data);
    });

    socket.on('close', () => {
      if (session.playerId !== null && session.world !== null) {
        session.world.disconnectPlayer(session.playerId);
      }
      this.sessions.delete(socket);
    });

    socket.on('error', () => {
      // A socket error is always followed by 'close'; cleanup lives there.
    });
  }

  private handleMessage(session: Session, data: Buffer | ArrayBuffer | Buffer[]): void {
    session.lastSeen = this.now();

    if (!this.checkRate(session)) {
      this.send(session, {
        type: 'error',
        code: 'rate_limited',
        message: 'Slow down.',
      });
      return;
    }

    let parsed: ClientMessage | null;
    try {
      // Oversized frames are rejected by the ws server itself (maxPayload), so
      // anything reaching here is small enough to parse safely.
      parsed = parseClientMessage(JSON.parse(String(data)));
    } catch {
      parsed = null;
    }

    if (parsed === null) {
      this.send(session, {
        type: 'error',
        code: 'bad_message',
        message: 'Malformed message.',
      });
      return;
    }

    if (parsed.type === 'hello') {
      this.handleHello(session, parsed);
      return;
    }

    if (parsed.type === 'ping') {
      const world = session.world;
      this.send(session, {
        type: 'pong',
        clientTime: parsed.clientTime,
        serverTime: this.now(),
        serverTick: world?.currentTick ?? 0,
      });
      return;
    }

    // Every remaining message requires an established identity. Refusing them
    // before `hello` is what stops a socket acting on someone else's behalf.
    const { playerId, world } = session;
    if (playerId === null || world === null) {
      this.send(session, {
        type: 'error',
        code: 'not_authorized',
        message: 'Send hello first.',
      });
      return;
    }

    switch (parsed.type) {
      case 'input':
        world.queueInput(playerId, parsed.frames);
        break;
      case 'interact':
        world.handleInteract(playerId, parsed.entityId);
        break;
      case 'table:leave':
        world.handleLeaveTable(playerId);
        break;
      case 'table:wager':
        world.handleWager(playerId, parsed.spotId, parsed.amount);
        break;
      case 'table:action':
        world.handleTableAction(playerId, parsed.actionId);
        break;
      case 'bar:buy':
        world.handleBuyDrink(playerId, parsed.drinkId);
        break;
      case 'table:clear':
        world.handleClearWagers(playerId);
        break;
      case 'table:ready':
        world.handleReady(playerId, parsed.ready);
        break;
      case 'chat':
        world.handleChat(playerId, parsed.channel, parsed.text);
        break;
      case 'view-mode':
        // Cosmetic and client-local; accepted and ignored server-side for now.
        break;
    }
  }

  private handleHello(session: Session, message: Extract<ClientMessage, { type: 'hello' }>): void {
    if (session.playerId !== null) {
      this.send(session, {
        type: 'error',
        code: 'not_authorized',
        message: 'Already connected.',
      });
      return;
    }

    const world = this.registry.resolve(message.sessionCode);
    const send = (outbound: ServerMessage): void => this.send(session, outbound);

    // A resume token reclaims the avatar and — more importantly — the chip
    // stack of a player who dropped, so a flaky connection is not a loss.
    if (message.resumeToken !== undefined) {
      const resumed = world.resumePlayer(message.resumeToken, send);
      if (resumed !== null) {
        session.playerId = resumed.playerId;
        session.world = world;
        this.sendWelcome(session, world, resumed.playerId, resumed.entityId, resumed.resumeToken);
        return;
      }
      // An unknown or expired token falls through to a fresh join rather than
      // erroring — from the player's side it just looks like a new session.
    }

    if (world.isFull()) {
      this.send(session, {
        type: 'error',
        code: 'world_full',
        message: 'That world is full.',
      });
      return;
    }

    const playerId = randomUUID();
    const resumeToken = randomUUID();
    const record = world.addPlayer(playerId, message.displayName, send, resumeToken);

    session.playerId = playerId;
    session.world = world;
    this.sendWelcome(session, world, playerId, record.entityId, resumeToken);
  }

  private sendWelcome(
    session: Session,
    world: WorldInstance,
    playerId: string,
    entityId: number,
    resumeToken: string,
  ): void {
    this.send(session, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      playerId,
      entityId,
      resumeToken,
      sessionCode: world.sessionCode,
      tickRate: TICK_RATE,
      serverTick: world.currentTick,
      world: world.world,
    });
  }

  /**
   * Sliding-window rate limit.
   *
   * Input is expected at the tick rate plus pings and table actions; the cap
   * sits well above that, so it only catches a client that is genuinely
   * flooding rather than one on a bad connection catching up.
   */
  private checkRate(session: Session): boolean {
    const now = this.now();
    if (now - session.windowStart >= 1000) {
      session.windowStart = now;
      session.messagesInWindow = 0;
    }
    session.messagesInWindow += 1;
    return session.messagesInWindow <= config.maxMessagesPerSecond;
  }

  private send(session: Session, message: ServerMessage): void {
    // readyState 1 === OPEN. Writing to a closing socket throws.
    if (session.socket.readyState !== 1) return;
    session.socket.send(JSON.stringify(message));
  }

  /** Closes sockets that have gone silent, freeing their resume window to start. */
  sweepIdle(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastSeen > config.socketTimeoutMs) session.socket.close();
    }
  }
}
