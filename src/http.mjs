import http from 'node:http';
import crypto from 'node:crypto';
import { NodeStreamableHTTPServerTransport, hostHeaderValidation } from '@modelcontextprotocol/node';
import { createKnowledgeServer } from './mcp.mjs';

export function createHttpServer(config, store) {
  const hostGuard = hostHeaderValidation(config.allowedHosts);
  const tokenHashes = config.tokens.map(token => crypto.createHash('sha256').update(token).digest());
  const buckets = new Map();
  let active = 0;
  const allow = (key, limit, duration) => {
    const now = Date.now();
    for (const [k, item] of buckets) if (item.until <= now) buckets.delete(k);
    let item = buckets.get(key);
    if (!item) { if (buckets.size >= 4096) return false; item = { until: now + duration, count: 0 }; buckets.set(key, item); }
    return ++item.count <= limit;
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status, error) => { if (!res.headersSent && !res.destroyed) { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store', ...(status === 429 ? { 'retry-after':'60' } : {}) }); res.end(JSON.stringify({ error })); } };
    let lease, mcp, timer, admitted = false;
    try {
      if (!hostGuard(req,res)) return;
      if (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) return reply(403, 'origin_denied');
      const endpoint = new URL(req.url, 'http://localhost').pathname;
      if (endpoint === '/health' && req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
      const match = /^Bearer (.{1,256})$/.exec(req.headers.authorization || '');
      const candidate = crypto.createHash('sha256').update(match?.[1] || '').digest();
      const identity = tokenHashes.findIndex(value => crypto.timingSafeEqual(value, candidate));
      if (!match || identity < 0) return reply(401,'unauthorized');
      // Ignore X-Forwarded-For: an untrusted client must never select its limiter identity.
      const ip = req.socket.remoteAddress || 'unknown';
      if (!allow('global',config.globalPerSecond,1000) || !allow(`key:${identity}`,config.perKeyPerMinute,60000) || !allow(`ip:${ip}`,config.perIpPerMinute,60000) || active >= config.maxConcurrent) return reply(429,'rate_limited');
      if (endpoint === '/ready' && req.method === 'GET') { res.writeHead(store.current ? 200 : 503, { 'content-type':'application/json' }); res.end(JSON.stringify(store.status())); return; }
      if (endpoint !== '/mcp') return reply(404,'not_found');
      if (req.method !== 'POST') return reply(405,'method_not_allowed');
      active++; admitted = true;
      timer = setTimeout(() => { reply(408,'request_timeout'); req.destroy(); }, config.requestTimeoutMs);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415,'json_required');
      if (Number(req.headers['content-length']) > config.maxBodyBytes) return reply(413,'body_too_large');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > config.maxBodyBytes) { reply(413,'body_too_large'); return; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400,'invalid_json'); }
      if (Array.isArray(body)) return reply(400,'batch_not_supported');
      lease = store.acquire(req.headers['x-xtend-snapshot']);
      res.setHeader('x-xtend-snapshot',lease.snapshot.commit);
      // Bound SDK output before any bytes leave the process.
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const send = transport.send.bind(transport);
      transport.send = (message, options) => {
        if (Buffer.byteLength(JSON.stringify(message)) > config.maxResponseBytes) message = { jsonrpc:'2.0', id:message.id ?? null, error:{ code:-32603, message:'Response exceeds configured budget' } };
        return send(message, options);
      };
      mcp = createKnowledgeServer(lease.snapshot);
      await mcp.connect(transport);
      await transport.handleRequest(req,res,body);
    } catch { reply(503,'request_failed'); }
    finally { clearTimeout(timer); if (mcp) await mcp.close().catch(()=>{}); lease?.release(); if (admitted) active--; }
  });
  server.maxConnections = config.maxConnections;
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 5000;
  return server;
}
