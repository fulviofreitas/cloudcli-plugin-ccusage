import http from 'node:http';
import { spawn } from 'node:child_process';

// ── Types ──────────────────────────────────────────────────────────────

interface CacheEntry {
  data: unknown;
  ts: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const VALID_RANGES = new Set(['daily', 'monthly', 'session', 'blocks']);
const DATE_RE = /^\d{8}$/;
const CACHE_TTL = 60_000;
const SPAWN_TIMEOUT = 30_000;

// ── Cache ──────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, ts: Date.now() });
}

// ── ccusage runner ─────────────────────────────────────────────────────

function runCcusage(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['ccusage@latest', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SPAWN_TIMEOUT,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: 1 });
    });
  });
}

async function fetchCcusage(args: string[], cacheKey: string, noCache: boolean): Promise<{ status: number; body: unknown }> {
  if (!noCache) {
    const cached = getCached(cacheKey);
    if (cached) return { status: 200, body: cached };
  }

  const result = await runCcusage(args);

  if (result.code !== 0) {
    // If stderr suggests network issue, retry with --offline
    if (result.stderr.includes('fetch') || result.stderr.includes('network') || result.stderr.includes('ENOTFOUND')) {
      const retryArgs = [...args, '--offline'];
      const retry = await runCcusage(retryArgs);
      if (retry.code === 0) {
        try {
          const data = { ...JSON.parse(retry.stdout), _offline: true };
          setCache(cacheKey, data);
          return { status: 200, body: data };
        } catch {
          return { status: 500, body: { error: 'Failed to parse ccusage output', stderr: retry.stderr } };
        }
      }
    }

    // Check for npx not found
    if (result.stderr.includes('not found') || result.stderr.includes('ENOENT')) {
      return { status: 500, body: { error: 'npx not found. Please install Node.js.', stderr: result.stderr } };
    }

    return { status: 500, body: { error: 'ccusage failed', stderr: result.stderr } };
  }

  try {
    const data = JSON.parse(result.stdout);
    setCache(cacheKey, data);
    return { status: 200, body: data };
  } catch {
    return { status: 500, body: { error: 'Failed to parse ccusage JSON output', stderr: result.stderr, stdout: result.stdout.slice(0, 500) } };
  }
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const noCache = url.searchParams.get('nocache') === '1';

  if (req.method === 'GET' && url.pathname === '/summary') {
    const range = url.searchParams.get('range') ?? 'daily';
    if (!VALID_RANGES.has(range)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid range: ${range}. Must be one of: ${[...VALID_RANGES].join(', ')}` }));
      return;
    }

    const args = [range, '--json'];
    const cacheKey = `summary:${range}`;
    const { status, body } = await fetchCcusage(args, cacheKey, noCache);
    res.writeHead(status);
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/breakdown') {
    const range = url.searchParams.get('range') ?? 'daily';
    if (!VALID_RANGES.has(range)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid range: ${range}` }));
      return;
    }

    const args = [range, '--json', '--breakdown'];
    const cacheKey = `breakdown:${range}`;
    const { status, body } = await fetchCcusage(args, cacheKey, noCache);
    res.writeHead(status);
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/range') {
    const range = url.searchParams.get('range') ?? 'daily';
    if (!VALID_RANGES.has(range)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid range: ${range}` }));
      return;
    }

    const args = [range, '--json'];
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');

    if (since) {
      if (!DATE_RE.test(since)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid since date. Must be YYYYMMDD.' }));
        return;
      }
      args.push('--since', since);
    }

    if (until) {
      if (!DATE_RE.test(until)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid until date. Must be YYYYMMDD.' }));
        return;
      }
      args.push('--until', until);
    }

    const cacheKey = `range:${range}:${since ?? ''}:${until ?? ''}`;
    const { status, body } = await fetchCcusage(args, cacheKey, noCache);
    res.writeHead(status);
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Graceful shutdown ──────────────────────────────────────────────────

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

// ── Start ──────────────────────────────────────────────────────────────

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
