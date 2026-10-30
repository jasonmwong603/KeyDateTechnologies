import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Finds the apps to serve.
 *
 * An app is a folder under `apps/` with an `app.json` in it. That is the whole
 * registration: drop a folder in, give it a slug, and it is served. Nothing in
 * the host names a particular trick, so adding the next one touches no shared
 * code and cannot break the one that is already being performed.
 */

/** `calc` and `/calc/` and `//calc` all mean the same mount. */
export function normalizeSlug(slug) {
  const trimmed = String(slug ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/**
 * Reads every app's manifest.
 *
 * A folder with no `app.json`, or an unreadable one, is skipped rather than
 * fatal: a half-finished trick in a working copy should not stop the host
 * serving the finished one.
 */
export async function discoverApps(appsDir) {
  let entries;
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const apps = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const directory = path.join(appsDir, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(directory, 'app.json'), 'utf8'));
    } catch {
      continue;
    }

    /*
     * The slug can be overridden per app from the environment, named after the
     * folder: `SLUG_CLOCKWORK=xyz`.
     *
     * The address is the only part of a performed app an audience could ever
     * see — it is on screen while you install it, and once or twice when you
     * hand someone the phone. Being able to change it on the host, without a
     * commit, is what lets it stay dull. Setting it empty takes the app off the
     * air entirely.
     */
    const override = process.env[`SLUG_${entry.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    const slug = normalizeSlug(override ?? manifest.slug ?? entry.name);
    if (slug === '') continue;

    apps.push({
      id: entry.name,
      name: typeof manifest.name === 'string' ? manifest.name : entry.name,
      slug,
      directory,
    });
  }

  // Longest slug first, so `/calc-two` is not swallowed by a mount at `/calc`.
  return apps.sort((a, b) => b.slug.length - a.slug.length);
}

/**
 * What the world is allowed to see: each app's `public/`, and nothing beside it.
 *
 * An app folder also holds its README, its tests and its icon generator — and
 * for a trick, the README *is* the method. The server this replaced mounted the
 * whole folder, so `/calc/README.md` handed a complete explanation of how the
 * trick works to anyone who guessed one filename.
 *
 * Making the boundary a directory rather than a list of exclusions is the
 * point. There is nothing to remember to update when the next trick adds a
 * file: a file is published by being put in `public/`, and by nothing else.
 */
export function mountsFor(apps) {
  return apps.map((app) => ({
    urlPrefix: app.slug,
    directory: path.join(app.directory, 'public'),
  }));
}
