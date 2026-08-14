import { afterEach, describe, expect, it, vi } from 'vitest';
// The client is plain JS served to browsers; the endpoint logic is pure and
// worth testing directly, because a wrong endpoint in a packaged app is only
// discoverable by reinstalling it on a phone.
import { resolveServerUrl, toWebSocketUrl } from './src/config.js';

/**
 * Stands in for a loaded page.
 *
 * `baseURI` is what `<base href>` controls, and it is how the client works out
 * where it is mounted without being told.
 */
function setPage(baseURI: string) {
  const url = new URL(baseURI);
  vi.stubGlobal('location', { protocol: url.protocol, host: url.host });
  vi.stubGlobal('document', { baseURI });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).KEYDATE_SERVER_URL;
});

describe('toWebSocketUrl', () => {
  it('upgrades http and https to their socket schemes', () => {
    expect(toWebSocketUrl('http://example.com')).toBe('ws://example.com/ws');
    expect(toWebSocketUrl('https://example.com')).toBe('wss://example.com/ws');
  });

  it('leaves an explicit socket scheme alone', () => {
    expect(toWebSocketUrl('wss://example.com/ws')).toBe('wss://example.com/ws');
  });

  it('appends the socket path only once', () => {
    expect(toWebSocketUrl('wss://example.com')).toBe('wss://example.com/ws');
    expect(toWebSocketUrl('wss://example.com/ws')).toBe('wss://example.com/ws');
  });

  it('assumes TLS for a bare public host', () => {
    // Anything reachable on the public internet should not be plaintext.
    expect(toWebSocketUrl('play.example.com')).toBe('wss://play.example.com/ws');
  });

  it('assumes plaintext for local addresses', () => {
    // A LAN host has no certificate, so demanding TLS would break local play.
    expect(toWebSocketUrl('localhost:8080')).toBe('ws://localhost:8080/ws');
    expect(toWebSocketUrl('192.168.1.24:8080')).toBe('ws://192.168.1.24:8080/ws');
    expect(toWebSocketUrl('10.0.0.5:8080')).toBe('ws://10.0.0.5:8080/ws');
    expect(toWebSocketUrl('172.16.0.9:8080')).toBe('ws://172.16.0.9:8080/ws');
  });

  it('tolerates trailing slashes and whitespace', () => {
    expect(toWebSocketUrl('  https://example.com/  ')).toBe('wss://example.com/ws');
  });
});

describe('resolveServerUrl', () => {
  it('uses the same origin when served from a domain root', () => {
    setPage('https://play.example.com/');
    expect(resolveServerUrl()).toBe('wss://play.example.com/ws');
  });

  it('follows the mount point when served under a path prefix', () => {
    // The whole point of the base-relative resolution: at
    // play.keydate.ca/the-floor/ the socket is /the-floor/ws, not /ws.
    setPage('https://play.keydate.ca/the-floor/');
    expect(resolveServerUrl()).toBe('wss://play.keydate.ca/the-floor/ws');
  });

  it('handles a nested mount point', () => {
    setPage('https://play.keydate.ca/games/the-floor/');
    expect(resolveServerUrl()).toBe('wss://play.keydate.ca/games/the-floor/ws');
  });

  it('uses plain ws when the page itself is plain http', () => {
    setPage('http://192.168.1.24:8080/the-floor/');
    expect(resolveServerUrl()).toBe('ws://192.168.1.24:8080/the-floor/ws');
  });

  it('prefers an injected endpoint over the page origin', () => {
    setPage('https://cdn.example.com/');
    (globalThis as Record<string, unknown>).KEYDATE_SERVER_URL = 'wss://play.example.com';
    expect(resolveServerUrl()).toBe('wss://play.example.com/ws');
  });

  it('refuses to guess inside a packaged app', () => {
    // Guessing same-origin here points the app at the device itself, which
    // surfaces much later as an unexplained connection failure.
    for (const protocol of ['file:', 'capacitor:', 'ionic:', 'tauri:']) {
      vi.stubGlobal('location', { protocol, host: 'localhost' });
      vi.stubGlobal('document', { baseURI: `${protocol}//localhost/` });
      expect(() => resolveServerUrl()).toThrow(/no server address/i);
    }
  });

  it('works inside a packaged app once an endpoint is injected', () => {
    vi.stubGlobal('location', { protocol: 'capacitor:', host: 'localhost' });
    vi.stubGlobal('document', { baseURI: 'capacitor://localhost/' });
    (globalThis as Record<string, unknown>).KEYDATE_SERVER_URL =
      'https://play.keydate.ca/the-floor';
    expect(resolveServerUrl()).toBe('wss://play.keydate.ca/the-floor/ws');
  });
});
