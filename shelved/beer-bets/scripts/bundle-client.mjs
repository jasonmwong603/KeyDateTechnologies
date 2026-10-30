/**
 * Builds the standalone client payload — the thing you wrap in an app.
 *
 * In the browser build, the client is served by the game server and resolves
 * everything through absolute paths (`/pkg/sim/index.js`) and its own origin.
 * A packaged app has neither: the files sit on the device, loaded from
 * `file://` or `capacitor://`, and there is no origin server to ask.
 *
 * So this produces a directory that is entirely self-contained — every module
 * it needs copied in, every path rewritten to be relative, and the world
 * server's address injected as a constant. Point Capacitor, Electron or Tauri
 * at the result and you have a native client with no URL for a player to type.
 *
 *   KEYDATE_SERVER_URL=wss://play.example.com node scripts/bundle-client.mjs
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const outDir = process.env.KEYDATE_BUNDLE_DIR ?? path.join(repoRoot, 'dist-client');
const serverUrl = process.env.KEYDATE_SERVER_URL ?? '';

/** Compiled packages the browser loads directly, mapped to their bundle path. */
const PACKAGES = ['protocol', 'netcode', 'sim'];

async function main() {
  // Fail loudly rather than shipping a bundle that cannot connect. Finding this
  // out costs a full reinstall on a phone.
  if (serverUrl === '') {
    console.warn(
      'WARNING: KEYDATE_SERVER_URL is not set.\n' +
        '  The bundle will build, but a packaged app will refuse to connect and\n' +
        '  show the player a configuration error. Set it to your deployed server,\n' +
        '  e.g. KEYDATE_SERVER_URL=wss://play.example.com\n',
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Client sources and assets.
  await cp(path.join(repoRoot, 'apps/client/src'), path.join(outDir, 'js'), { recursive: true });
  await cp(path.join(repoRoot, 'apps/client/assets'), path.join(outDir, 'assets'), {
    recursive: true,
  });

  // Compiled shared packages — the same output the server imports, which is the
  // whole reason prediction and authority agree.
  for (const name of PACKAGES) {
    const from = path.join(repoRoot, 'packages', name, 'dist');
    await cp(from, path.join(outDir, 'pkg', name), { recursive: true });
  }

  await mkdir(path.join(outDir, 'vendor/three'), { recursive: true });
  await cp(
    path.join(repoRoot, 'node_modules/three/build/three.module.js'),
    path.join(outDir, 'vendor/three/three.module.js'),
  );

  await writeIndexHtml();

  console.log(`Bundled client to ${outDir}`);
  console.log(`  server endpoint: ${serverUrl === '' ? '(none — will not connect)' : serverUrl}`);
}

/**
 * Rewrites the page for offline, origin-less loading.
 *
 * Two changes matter: absolute paths become relative (there is no web root in
 * an app), and the server address is injected ahead of the module scripts so it
 * is set before anything reads it.
 */
async function writeIndexHtml() {
  const source = await readFile(path.join(repoRoot, 'apps/client/index.html'), 'utf8');

  // A packaged app has no web root, so the page resolves everything against its
  // own directory. Every other URL in the document is already relative to this.
  let html = source.replace('<base href="/" />', '<base href="./" />');

  // Belt and braces: catch any absolute path a future edit reintroduces, since
  // one would silently break only in the packaged build.
  html = html.replace(/(src|href)="\/([^"]+)"/g, '$1="./$2"');
  html = html.replace(/"\/(pkg|vendor|js|assets)\//g, '"./$1/');

  const injected = `    <script>
      // Injected by scripts/bundle-client.mjs. This is how a packaged client
      // knows which world server to reach without asking the player for a URL.
      window.KEYDATE_SERVER_URL = ${JSON.stringify(serverUrl)};
    </script>
`;

  html = html.replace('  </head>', `${injected}  </head>`);

  await writeFile(path.join(outDir, 'index.html'), html);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
