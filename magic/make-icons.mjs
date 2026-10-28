// Renders the home-screen icons.
//
// The icon matters more than it looks. The app passes for the system calculator
// the moment it is open, and would give itself away sitting on the home screen
// as a grey globe or a screenshot of a web page. iOS wants PNG for
// `apple-touch-icon` and ignores SVG, so these are drawn as a page and
// photographed — no image library to install, and the browser is here anyway.
//
// A plain calculator, not a copy of anybody's artwork: a dark rounded tile, a
// readout, and a keypad with the operator column picked out in orange.
//
// Run with: node magic/make-icons.mjs

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function launchOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return {};
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium')) continue;
    for (const inner of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(root, entry, inner, 'chrome');
      if (existsSync(candidate)) return { executablePath: candidate };
    }
  }
  return {};
}

const icon = (size) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; width:${size}px; height:${size}px; }
  .tile {
    width:100%; height:100%; background:#1c1c1e;
    display:flex; flex-direction:column;
    padding:${size * 0.13}px ${size * 0.15}px; box-sizing:border-box;
    gap:${size * 0.055}px;
  }
  .readout {
    height:${size * 0.15}px; border-radius:${size * 0.025}px;
    background:#000; display:flex; align-items:center; justify-content:flex-end;
    padding-right:${size * 0.04}px;
    color:#fff; font-family:-apple-system,"Helvetica Neue",sans-serif;
    font-size:${size * 0.11}px; font-weight:300;
  }
  .pad { flex:1; display:grid; grid-template-columns:repeat(4,1fr);
         gap:${size * 0.035}px; }
  .k { border-radius:50%; background:#3a3a3c; }
  .k.op { background:#ff9f0a; }
</style></head><body>
  <div class="tile">
    <div class="readout">0</div>
    <div class="pad">
      ${Array.from({ length: 12 }, (_, i) => `<div class="k${i % 4 === 3 ? ' op' : ''}"></div>`).join('')}
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch(launchOptions());
for (const size of [180, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(icon(size));
  await page.screenshot({ path: path.join(here, `icon-${size}.png`), omitBackground: false });
  await page.close();
  console.log(`wrote icon-${size}.png`);
}
await browser.close();
