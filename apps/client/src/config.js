/**
 * Where the client should look for the world server.
 *
 * There are two very different situations to serve:
 *
 *  - **Served by the game server** (a browser, hitting the server's own URL).
 *    The server is whatever origin sent the page, so the client can work it out
 *    for itself and no configuration exists to get wrong.
 *
 *  - **Packaged as an app** (Capacitor, Electron, or anything loading from
 *    `file://`). There is no origin server — the page is on the device. The
 *    endpoint has to be baked in at build time, which is exactly how a native
 *    game client knows where to connect without ever showing a player a URL.
 *
 * The bundler injects `window.KEYDATE_SERVER_URL` into the packaged HTML. In a
 * browser build it is absent and same-origin is used.
 */

/** Origins that mean "this page is packaged", not "served over the web". */
const PACKAGED_PROTOCOLS = new Set(['file:', 'capacitor:', 'ionic:', 'tauri:']);

/**
 * Returns the WebSocket URL for the world server.
 *
 * Throws when the page is packaged but no endpoint was configured, rather than
 * guessing. A silent same-origin guess inside an app produces a connection
 * attempt to the device itself, which surfaces much later as an unexplained
 * "cannot connect" with nothing in the logs to explain why.
 */
export function resolveServerUrl() {
  const configured = globalThis.KEYDATE_SERVER_URL;

  if (typeof configured === 'string' && configured.length > 0) {
    return toWebSocketUrl(configured);
  }

  if (PACKAGED_PROTOCOLS.has(location.protocol)) {
    throw new Error(
      'This build has no server address. Set KEYDATE_SERVER_URL when bundling ' +
        '(see docs/distribution.md) so the app knows which world server to reach.',
    );
  }

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

/**
 * Normalises a configured address into a `ws://` or `wss://` endpoint.
 *
 * Accepts what someone would naturally paste — `example.com`,
 * `https://example.com`, `wss://example.com/ws` — because getting this wrong
 * costs a full rebuild-and-reinstall cycle to discover on a phone.
 */
export function toWebSocketUrl(value) {
  let address = value.trim().replace(/\/+$/, '');

  if (address.startsWith('http://')) address = `ws://${address.slice(7)}`;
  else if (address.startsWith('https://')) address = `wss://${address.slice(8)}`;
  else if (!address.startsWith('ws://') && !address.startsWith('wss://')) {
    // A bare host. Assume TLS unless it is plainly a local address, since
    // anything reachable on the public internet should not be plaintext.
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
    address = `${isLocal ? 'ws' : 'wss'}://${address}`;
  }

  return address.endsWith('/ws') ? address : `${address}/ws`;
}
