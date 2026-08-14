import { afterEach, describe, expect, it, vi } from 'vitest';
// The client is plain JS served to browsers; the endpoint logic is pure and
// worth testing directly, because a wrong endpoint in a packaged app is only
// discoverable by reinstalling it on a phone.
import { resolveServerUrl, toWebSocketUrl } from './src/config.js';

function setLocation(protocol: string, host = 'example.com') {
  vi.stubGlobal('location', { protocol, host });
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
  it('uses the same origin when served over the web', () => {
    setLocation('https:', 'play.example.com');
    expect(resolveServerUrl()).toBe('wss://play.example.com/ws');
  });

  it('uses plain ws when the page itself is plain http', () => {
    setLocation('http:', '192.168.1.24:8080');
    expect(resolveServerUrl()).toBe('ws://192.168.1.24:8080/ws');
  });

  it('prefers an injected endpoint over the page origin', () => {
    setLocation('https:', 'cdn.example.com');
    (globalThis as Record<string, unknown>).KEYDATE_SERVER_URL = 'wss://play.example.com';
    expect(resolveServerUrl()).toBe('wss://play.example.com/ws');
  });

  it('refuses to guess inside a packaged app', () => {
    // Guessing same-origin here points the app at the device itself, which
    // surfaces much later as an unexplained connection failure.
    for (const protocol of ['file:', 'capacitor:', 'ionic:', 'tauri:']) {
      setLocation(protocol, 'localhost');
      expect(() => resolveServerUrl()).toThrow(/no server address/i);
    }
  });

  it('works inside a packaged app once an endpoint is injected', () => {
    setLocation('capacitor:', 'localhost');
    (globalThis as Record<string, unknown>).KEYDATE_SERVER_URL = 'https://play.example.com';
    expect(resolveServerUrl()).toBe('wss://play.example.com/ws');
  });
});
