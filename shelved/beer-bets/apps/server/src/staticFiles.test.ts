import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticFileServer } from './staticFiles.js';

/**
 * These cover the two jobs the static server has beyond handing over bytes:
 * answering the front door of a mount, and refusing to serve anything outside
 * it. Both are load-bearing — the first is the address a person types, and the
 * second is the whole security surface of serving files from disk.
 */

let root: string;
let server: StaticFileServer;

/** Collects what a handler wrote, so assertions can read it back. */
function fakeResponse() {
  const sink = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string> = {}) {
      sink.status = status;
      sink.headers = headers;
      return sink;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') sink.body = chunk;
      else if (chunk instanceof Buffer) sink.body = chunk.toString('utf8');
      return sink;
    },
    // Enough of a stream sink for `createReadStream().pipe()`.
    on: () => sink,
    once: () => sink,
    emit: () => true,
    write: (chunk: Buffer | string) => {
      sink.body += chunk.toString();
      return true;
    },
    destroy: () => sink,
  };
  return sink;
}

const get = async (url: string) => {
  const response = fakeResponse();
  const handled = await server.handle({ method: 'GET', url } as never, response as never);
  return { handled, ...response };
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'static-'));
  mkdirSync(path.join(root, 'prop'));
  mkdirSync(path.join(root, 'prop', 'deep'));
  writeFileSync(path.join(root, 'prop', 'index.html'), '<p>prop</p>');
  writeFileSync(path.join(root, 'prop', 'sw.js'), '// worker');
  writeFileSync(path.join(root, 'prop', 'deep', 'index.html'), '<p>deep</p>');
  writeFileSync(path.join(root, 'secret.txt'), 'do not serve me');
  writeFileSync(path.join(root, 'game.html'), '<base href="/" />');

  server = new StaticFileServer(
    [{ urlPrefix: '/calc', directory: path.join(root, 'prop') }],
    path.join(root, 'game.html'),
    '/game',
  );
});

describe('a mounted directory', () => {
  it('answers its own front door', async () => {
    // The address somebody actually types. Without this every deep link works
    // and `/calc/` alone is a 404, which is the one URL that gets shared.
    const response = await get('/calc/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('prop');
  });

  it('answers the same without the trailing slash', async () => {
    const response = await get('/calc');
    expect(response.status).toBe(200);
    expect(response.body).toContain('prop');
  });

  it('serves a named file', async () => {
    const response = await get('/calc/sw.js');
    expect(response.status).toBe(200);
    expect(response.body).toContain('worker');
  });

  it('indexes a directory inside the mount too', async () => {
    const response = await get('/calc/deep/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('deep');
  });

  it('404s a file that is not there rather than falling through', async () => {
    const response = await get('/calc/nope.txt');
    expect(response.handled).toBe(true);
    expect(response.status).toBe(404);
  });

  it('does not claim a path that merely starts with the same letters', async () => {
    // `/calculator` is somebody else's route, not this mount's.
    const response = await get('/calculator/thing');
    expect(response.handled).toBe(false);
  });
});

describe('escaping the mount', () => {
  it('never serves a file outside it, however the climb is spelled', async () => {
    // Two different defences, and the test deliberately does not care which one
    // fires. A plain `../` is collapsed by URL parsing before this code sees it,
    // so the path stops matching the mount and falls through unhandled. An
    // encoded one survives parsing and is caught by the resolved-path check.
    // What matters is only that the bytes never leave.
    for (const attempt of [
      '/calc/../secret.txt',
      '/calc/../../etc/passwd',
      '/calc/deep/../../secret.txt',
      '/calc/..%2Fsecret.txt',
      '/calc/%2e%2e%2fsecret.txt',
    ]) {
      const response = await get(attempt);
      expect(response.body).not.toContain('do not serve me');
      expect(response.status).not.toBe(200);
    }
  });

  it('refuses an encoded climb outright rather than leaking a 404 either way', async () => {
    // This one does reach the guard, and should be a flat refusal.
    const response = await get('/calc/..%2Fsecret.txt');
    expect(response.handled).toBe(true);
    expect(response.status).toBe(403);
  });
});

describe('the game index', () => {
  it('still has its base href rewritten to the mount point', async () => {
    const response = await get('/game/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('<base href="/game/" />');
  });
});
