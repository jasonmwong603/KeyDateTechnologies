import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticHost } from './staticHost.mjs';
import { discoverApps, mountsFor, normalizeSlug } from './apps.mjs';

/**
 * The host has two jobs beyond handing over bytes: answering the front door of
 * an app, and refusing to serve anything outside it. The first is the address
 * someone types; the second is the entire security surface of serving files
 * from a disk.
 *
 * These came over with the code from the game server that used to do this, and
 * are the reason that code was carried across rather than rewritten.
 */

let root;
let host;

/** Collects what a handler wrote, so assertions can read it back. */
function fakeResponse() {
  const sink = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      sink.status = status;
      sink.headers = headers;
      return sink;
    },
    end(chunk) {
      if (typeof chunk === 'string') sink.body = chunk;
      else if (chunk instanceof Buffer) sink.body = chunk.toString('utf8');
      return sink;
    },
    // Enough of a stream sink for `createReadStream().pipe()`.
    on: () => sink,
    once: () => sink,
    emit: () => true,
    write: (chunk) => {
      sink.body += chunk.toString();
      return true;
    },
    destroy: () => sink,
  };
  return sink;
}

const get = async (url) => {
  const response = fakeResponse();
  const handled = await host.handle({ method: 'GET', url }, response);
  return { handled, ...response };
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'host-'));
  mkdirSync(path.join(root, 'prop'));
  mkdirSync(path.join(root, 'prop', 'deep'));
  writeFileSync(path.join(root, 'prop', 'index.html'), '<p>prop</p>');
  writeFileSync(path.join(root, 'prop', 'sw.js'), '// worker');
  writeFileSync(path.join(root, 'prop', 'manifest.webmanifest'), '{}');
  writeFileSync(path.join(root, 'prop', 'deep', 'index.html'), '<p>deep</p>');
  writeFileSync(path.join(root, 'secret.txt'), 'do not serve me');

  host = new StaticHost([{ urlPrefix: '/calc', directory: path.join(root, 'prop') }]);
});

describe('a mounted app', () => {
  it('answers its own front door', async () => {
    const response = await get('/calc/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('prop');
  });

  it('redirects the bare mount to its trailing slash', async () => {
    /*
     * Not a tidiness preference — a working app versus a broken one.
     *
     * Every URL inside these apps is relative, so at `/calc` the browser
     * resolves `./sw.js` against `/` and gets nothing. The page renders
     * perfectly and has no service worker and no manifest: no offline, and
     * Safari's chrome across the top of it once it is on a home screen. The
     * server this replaced served the index at both addresses, so the broken
     * one looked healthy.
     */
    const response = await get('/calc');
    expect(response.status).toBe(301);
    expect(response.headers.location).toBe('/calc/');
  });

  it('serves a named file', async () => {
    const response = await get('/calc/sw.js');
    expect(response.status).toBe(200);
    expect(response.body).toContain('worker');
  });

  it('gives the manifest the one type browsers accept', async () => {
    // Anything else and the manifest is ignored, which costs the standalone
    // display mode — the thing that makes it stop looking like a web page.
    const response = await get('/calc/manifest.webmanifest');
    expect(response.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
  });

  it('never lets a cache hold a version back', async () => {
    // The service worker decides what to keep. An HTTP cache in front of it can
    // only hold an update back after the worker has asked for it.
    const response = await get('/calc/index.html');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('indexes a directory inside the app too', async () => {
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
    // `/calculator` is somebody else's mount, not this one's.
    const response = await get('/calculator/thing');
    expect(response.handled).toBe(false);
  });
});

describe('escaping the app folder', () => {
  it('never serves a file outside it, however the climb is spelled', async () => {
    // Two defences, and the test deliberately does not care which one fires. A
    // plain `../` is collapsed by URL parsing before this code sees it, so the
    // path stops matching the mount and falls through unhandled. An encoded one
    // survives parsing and is caught by the resolved-path check. What matters
    // is only that the bytes never leave.
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
    const response = await get('/calc/..%2Fsecret.txt');
    expect(response.handled).toBe(true);
    expect(response.status).toBe(403);
  });

  it('answers a malformed escape sequence without throwing', async () => {
    const response = await get('/calc/%E0%A4%A');
    expect(response.status).toBe(400);
  });
});

describe('finding the apps', () => {
  it('reads a slug from each app.json', async () => {
    mkdirSync(path.join(root, 'apps', 'clockwork'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps', 'clockwork', 'app.json'),
      JSON.stringify({ name: 'Clockwork', slug: 'calc' }),
    );

    const apps = await discoverApps(path.join(root, 'apps'));
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: 'clockwork', name: 'Clockwork', slug: '/calc' });
  });

  it('skips a folder that is not an app yet', async () => {
    // A trick half-built in a working copy must not stop the host serving the
    // one that is being performed tonight.
    mkdirSync(path.join(root, 'apps', 'wip'), { recursive: true });
    mkdirSync(path.join(root, 'apps', 'done'), { recursive: true });
    writeFileSync(path.join(root, 'apps', 'done', 'app.json'), JSON.stringify({ slug: 'x' }));

    const apps = await discoverApps(path.join(root, 'apps'));
    expect(apps.map((app) => app.id)).toEqual(['done']);
  });

  it('lets the host rename a slug, and take an app off the air', async () => {
    mkdirSync(path.join(root, 'apps', 'clockwork'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps', 'clockwork', 'app.json'),
      JSON.stringify({ slug: 'calc' }),
    );

    process.env.SLUG_CLOCKWORK = 'sums';
    expect((await discoverApps(path.join(root, 'apps')))[0].slug).toBe('/sums');

    process.env.SLUG_CLOCKWORK = '';
    expect(await discoverApps(path.join(root, 'apps'))).toHaveLength(0);
    delete process.env.SLUG_CLOCKWORK;
  });

  it('orders mounts so a longer slug is not swallowed by a shorter one', async () => {
    for (const [id, slug] of [
      ['one', 'calc'],
      ['two', 'calc-two'],
    ]) {
      mkdirSync(path.join(root, 'apps', id), { recursive: true });
      writeFileSync(path.join(root, 'apps', id, 'app.json'), JSON.stringify({ slug }));
    }

    const apps = await discoverApps(path.join(root, 'apps'));
    expect(apps.map((app) => app.slug)).toEqual(['/calc-two', '/calc']);
  });

  it('publishes the public folder and nothing beside it', async () => {
    /*
     * The one that would end a trick rather than break it.
     *
     * An app folder holds the README that explains the method, the script that
     * verifies the arithmetic, and the browser test that walks the whole
     * routine. The previous server mounted the folder itself, so every one of
     * those was a GET away from anyone who guessed a filename — no exploit, no
     * traversal, just `/calc/README.md`.
     */
    const app = path.join(root, 'apps', 'clockwork');
    mkdirSync(path.join(app, 'public'), { recursive: true });
    writeFileSync(path.join(app, 'app.json'), JSON.stringify({ slug: 'calc' }));
    writeFileSync(path.join(app, 'README.md'), 'the whole method, in plain English');
    writeFileSync(path.join(app, 'check.mjs'), '// the arithmetic');
    writeFileSync(path.join(app, 'public', 'index.html'), '<p>a calculator</p>');

    host = new StaticHost(mountsFor(await discoverApps(path.join(root, 'apps'))));

    const page = await get('/calc/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('a calculator');

    for (const secret of ['/calc/README.md', '/calc/check.mjs', '/calc/app.json']) {
      const response = await get(secret);
      expect(response.status, secret).not.toBe(200);
      expect(response.body).not.toContain('method');
    }
  });

  it('serves an app at its folder name when app.json names no slug', async () => {
    // The usual case, and the reason a trick needs no configuration: drop
    // `apps/mindreader/` in and it is at /mindreader.
    const app = path.join(root, 'apps', 'mindreader');
    mkdirSync(path.join(app, 'public'), { recursive: true });
    writeFileSync(path.join(app, 'app.json'), JSON.stringify({ name: 'Mind Reader' }));

    const apps = await discoverApps(path.join(root, 'apps'));
    expect(apps[0].slug).toBe('/mindreader');
  });

  describe('refusing to start rather than serving less than it was asked to', () => {
    /*
     * Skipping a folder with no app.json is right: that trick is not finished.
     * Each of these is the opposite — the app is finished and would be silently
     * unreachable. Nobody re-checks a URL that worked last month, so the place
     * it gets found out is a stage.
     */
    const appAt = (id, manifest) => {
      const dir = path.join(root, 'apps', id);
      mkdirSync(path.join(dir, 'public'), { recursive: true });
      writeFileSync(path.join(dir, 'app.json'), JSON.stringify(manifest));
    };

    it('says which two apps collided, and that one would vanish', async () => {
      appAt('alpha', { slug: 'cards' });
      appAt('beta', { slug: 'cards' });

      await expect(discoverApps(path.join(root, 'apps'))).rejects.toThrow(
        /alpha.*cards|cards.*alpha/s,
      );
    });

    it('refuses an app that would sit on a route the host answers itself', async () => {
      appAt('healthz', {});
      await expect(discoverApps(path.join(root, 'apps'))).rejects.toThrow(/healthz/);
    });

    it('refuses an address that would need escaping in a URL', async () => {
      // A folder called `Mind Reader` would be served at /Mind%20Reader, which
      // is neither dull nor typeable.
      appAt('Mind Reader', {});
      await expect(discoverApps(path.join(root, 'apps'))).rejects.toThrow(/escap/i);
    });

    it('still lets a finished app be taken off the air deliberately', async () => {
      // Empty is a decision, not a mistake, and must not be confused for one.
      appAt('clockwork', { slug: 'calc' });
      process.env.SLUG_CLOCKWORK = '';
      await expect(discoverApps(path.join(root, 'apps'))).resolves.toHaveLength(0);
      delete process.env.SLUG_CLOCKWORK;
    });
  });

  it('treats a slug the same however it is punctuated', () => {
    for (const written of ['calc', '/calc', 'calc/', '//calc//']) {
      expect(normalizeSlug(written)).toBe('/calc');
    }
    expect(normalizeSlug('')).toBe('');
  });
});
