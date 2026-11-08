import http from 'node:http';
import { DASHBOARD_HTML } from './dashboard.js';

/**
 * An OpenAI-compatible HTTP server in front of a Gateway, so projects in any
 * language (Python, etc.) can use it by pointing their OpenAI SDK's base URL here.
 *
 *   POST /v1/chat/completions   (stream or not)
 *   GET  /v1/models
 *   GET  /                      live dashboard (who's answering, cooldowns, reset times)
 *   GET  /status                same data as JSON: { keys, recent }
 */
export function createServer(gateway, { token } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // The dashboard page itself holds no data; it fetches /status with the token.
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(DASHBOARD_HTML);
    }

    if (token) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}` && url.searchParams.get('token') !== token) {
        return sendError(res, 401, 'Invalid or missing keyhopper token');
      }
    }

    try {
      if (req.method === 'GET' && (path === '/status' || path === '/health')) {
        return sendJson(res, 200, {
          ok: true,
          strategy: gateway.strategy,
          now: new Date().toISOString(),
          keys: gateway.status(),
          recent: gateway.history(50).reverse(),
        });
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const ids = ['auto', ...new Set(gateway.providers.map((p) => p.name)), ...gateway.models()];
        return sendJson(res, 200, {
          object: 'list',
          data: ids.map((id) => ({ id, object: 'model', owned_by: 'keyhopper' })),
        });
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Request body must be JSON');
        }
        const ac = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) ac.abort();
        });

        if (!body.stream) {
          const result = await gateway.chat(body, { signal: ac.signal });
          return sendJson(res, 200, result);
        }

        // Pull the first chunk before sending headers so total failure can still
        // return a real HTTP error code instead of a broken stream.
        const it = gateway.stream(body, { signal: ac.signal })[Symbol.asyncIterator]();
        const first = await it.next();
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        try {
          if (!first.done) res.write(`data: ${JSON.stringify(first.value)}\n\n`);
          for (let next = await it.next(); !next.done; next = await it.next()) {
            res.write(`data: ${JSON.stringify(next.value)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } catch (err) {
          if (!ac.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        }
        return void res.end();
      }

      sendError(res, 404, `No route for ${req.method} ${path}`);
    } catch (err) {
      if (res.headersSent) return void res.end();
      sendError(res, err.status ?? 502, err.message, err.attempts);
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, attempts) {
  sendJson(res, status, { error: { message, type: 'keyhopper_error', code: status, attempts } });
}
