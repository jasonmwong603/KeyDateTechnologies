import { PROTOCOL_VERSION } from '@keydate/protocol';
import { resolveServerUrl } from './config.js';

/**
 * The socket connection to the world server.
 *
 * Owns exactly one concern: getting well-formed messages in and out, and
 * reconnecting when the link drops. It knows nothing about rendering or
 * simulation — callers subscribe to typed events.
 */
export class Connection {
  constructor() {
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {Map<string, Set<(payload: any) => void>>} */
    this.handlers = new Map();

    this.playerId = null;
    this.entityId = null;
    this.resumeToken = null;
    this.sessionCode = null;
    this.tickRate = 30;

    /** Smoothed round-trip time in milliseconds. */
    this.ping = 0;
    this.connected = false;

    this._displayName = '';
    this._requestedCode = '';
    this._reconnectAttempts = 0;
    this._pingTimer = null;
    this._outboundInputs = [];
  }

  /** @param {string} type @param {(payload: any) => void} handler */
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  _emit(type, payload) {
    const set = this.handlers.get(type);
    if (set === undefined) return;
    for (const handler of set) handler(payload);
  }

  /** @param {string} displayName @param {string} sessionCode */
  connect(displayName, sessionCode) {
    this._displayName = displayName;
    this._requestedCode = sessionCode;
    this._open();
  }

  _open() {
    // Resolved per attempt rather than cached, so a packaged build that had its
    // endpoint injected late still picks it up on reconnect.
    let endpoint;
    try {
      endpoint = resolveServerUrl();
    } catch (error) {
      this._emit('config-error', error);
      return;
    }

    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this._reconnectAttempts = 0;
      const hello = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        displayName: this._displayName,
      };
      if (this._requestedCode) hello.sessionCode = this._requestedCode;
      // Presenting the token from a previous session is what reclaims the same
      // avatar and chip stack after a refresh or a dropped mobile connection.
      if (this.resumeToken) hello.resumeToken = this.resumeToken;
      this.send(hello);

      this._pingTimer = setInterval(() => {
        this.send({ type: 'ping', clientTime: performance.now() });
      }, 2000);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handle(message);
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this._emit('disconnected', null);
      this._scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnect logic lives there.
    });
  }

  _scheduleReconnect() {
    // Exponential backoff, capped, so a server restart does not turn into a
    // reconnect storm from every client at once.
    this._reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (this._reconnectAttempts - 1), 15000);
    const jitter = Math.random() * 500;
    setTimeout(() => this._open(), delay + jitter);
  }

  _handle(message) {
    switch (message.type) {
      case 'welcome':
        this.connected = true;
        this.playerId = message.playerId;
        this.entityId = message.entityId;
        this.resumeToken = message.resumeToken;
        this.sessionCode = message.sessionCode;
        this.tickRate = message.tickRate;
        this._emit('welcome', message);
        break;

      case 'snapshot':
        this._emit('snapshot', message);
        break;

      case 'events':
        for (const event of message.events) this._emit(`event:${event.kind}`, event);
        this._emit('events', message);
        break;

      case 'pong': {
        const rtt = performance.now() - message.clientTime;
        // Exponential moving average: a single slow packet should nudge the
        // displayed ping, not spike it.
        this.ping = this.ping === 0 ? rtt : this.ping * 0.8 + rtt * 0.2;
        break;
      }

      case 'error':
        this._emit('server-error', message);
        break;
    }
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Queues an input frame for the next flush.
   *
   * Frames are batched rather than sent one per tick: at 30Hz that would be 30
   * tiny packets a second per client, and coalescing a few costs a couple of
   * milliseconds of latency while cutting packet overhead sharply.
   */
  queueInput(frame) {
    this._outboundInputs.push(frame);
    if (this._outboundInputs.length >= 3) this.flushInputs();
  }

  flushInputs() {
    if (this._outboundInputs.length === 0) return;
    this.send({ type: 'input', frames: this._outboundInputs });
    this._outboundInputs = [];
  }
}
