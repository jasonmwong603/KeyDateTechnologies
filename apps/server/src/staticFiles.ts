import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * A small static file server for the client.
 *
 * The client ships as plain ES modules with no bundler: the browser loads the
 * same compiled `dist/` output the server imports, resolved through an import
 * map. That keeps exactly one copy of the shared simulation in the repo, which
 * is the point — a bundler that inlined a stale copy would silently break
 * prediction.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticMount {
  /** URL prefix, e.g. '/pkg/sim'. */
  urlPrefix: string;
  /** Absolute directory served under that prefix. */
  directory: string;
}

export class StaticFileServer {
  constructor(
    private readonly mounts: StaticMount[],
    private readonly indexFile: string,
  ) {}

  /** Serves the request, returning false when no mount matches. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '/index.html') {
      await this.sendFile(response, this.indexFile, request.method === 'HEAD');
      return true;
    }

    for (const mount of this.mounts) {
      if (!pathname.startsWith(`${mount.urlPrefix}/`)) continue;

      const relative = pathname.slice(mount.urlPrefix.length + 1);
      const resolved = path.resolve(mount.directory, relative);

      // Reject anything that escapes the mount. `path.resolve` has already
      // collapsed `..`, so a prefix check on the resolved path is sufficient
      // and cannot be fooled by encoded traversal sequences.
      const root = path.resolve(mount.directory);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        response.writeHead(403).end('Forbidden');
        return true;
      }

      const sent = await this.sendFile(response, resolved, request.method === 'HEAD');
      if (!sent) response.writeHead(404).end('Not found');
      return true;
    }

    return false;
  }

  private async sendFile(
    response: ServerResponse,
    filePath: string,
    headOnly: boolean,
  ): Promise<boolean> {
    let size: number;
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return false;
      size = stats.size;
    } catch {
      return false;
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'content-length': size,
      // The client is served from the same process that serves the API, and is
      // rebuilt on every deploy; caching it would mostly serve stale code
      // during development.
      'cache-control': 'no-cache',
    });

    if (headOnly) {
      response.end();
      return true;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(response);
    });
    return true;
  }
}
