import { describe, expect, it } from 'vitest';
import { normalizeBasePath, parseLegacySlugs } from './config.js';

describe('normalizeBasePath', () => {
  it('accepts whatever shape somebody naturally types', () => {
    expect(normalizeBasePath('beer-bets')).toBe('/beer-bets');
    expect(normalizeBasePath('/beer-bets')).toBe('/beer-bets');
    expect(normalizeBasePath('/beer-bets/')).toBe('/beer-bets');
    expect(normalizeBasePath('  beer-bets  ')).toBe('/beer-bets');
  });

  it('treats an empty slug as a root mount', () => {
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
  });
});

describe('parseLegacySlugs', () => {
  it('normalises a comma-separated list', () => {
    expect(parseLegacySlugs('the-floor, /old-name/', '/beer-bets')).toEqual([
      '/the-floor',
      '/old-name',
    ]);
  });

  it('drops empty entries rather than producing a root redirect', () => {
    // A root legacy slug would match every path on the domain.
    expect(parseLegacySlugs('the-floor,,  ,/', '/beer-bets')).toEqual(['/the-floor']);
  });

  it('drops duplicates', () => {
    expect(parseLegacySlugs('the-floor,the-floor,/the-floor/', '/beer-bets')).toEqual([
      '/the-floor',
    ]);
  });

  /**
   * The one that took the site down.
   *
   * `GAME_SLUG` was left at `the-floor` on the host after the game was renamed,
   * while the default legacy list still named `the-floor`. Every request under
   * that path — including the domain root, which redirects into it — answered
   * with a 301 to itself, forever. The process stayed up and its health check
   * stayed green the whole time.
   */
  it('never lists the slug currently being served', () => {
    expect(parseLegacySlugs('the-floor', '/the-floor')).toEqual([]);
  });

  it('keeps the genuinely old slugs when one entry collides with the current one', () => {
    expect(parseLegacySlugs('the-floor,casino,beer-bets', '/beer-bets')).toEqual([
      '/the-floor',
      '/casino',
    ]);
  });

  it('matches the current slug however it was written', () => {
    for (const written of ['the-floor', '/the-floor', '/the-floor/', ' the-floor ']) {
      expect(parseLegacySlugs(written, '/the-floor')).toEqual([]);
    }
  });

  it('drops everything when the game is served from the domain root', () => {
    // With no base path there is nowhere to redirect *to*: the target would be
    // the root, which is inside every legacy path.
    expect(parseLegacySlugs('the-floor', '')).toEqual(['/the-floor']);
    expect(parseLegacySlugs('/', '')).toEqual([]);
  });
});
