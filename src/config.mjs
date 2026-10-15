import path from 'node:path';

function number(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function configFromEnv(env = process.env) {
  const tokens = (env.XTEND_MCP_TOKENS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!tokens.length || tokens.length > 64 || tokens.some(value => value.length < 32 || value.length > 256)) {
    throw new Error('XTEND_MCP_TOKENS requires 1–64 comma-separated secrets of 32–256 characters.');
  }
  const repository = env.XTEND_SOURCE_REPOSITORY || 'konnilabs/xtend';
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository)) throw new Error('Invalid XTEND_SOURCE_REPOSITORY');
  const ref = env.XTEND_SOURCE_REF || 'main';
  if (!/^[a-zA-Z0-9_./-]{1,200}$/u.test(ref) || ref.includes('..')) throw new Error('Invalid XTEND_SOURCE_REF');
  const list = (name, fallback = '') => (env[name] || fallback).split(',').map(value => value.trim()).filter(Boolean);
  return {
    host: env.XTEND_MCP_BIND || '127.0.0.1',
    port: number(env, 'PORT', 31415, 0, 65535),
    tokens,
    allowedHosts: list('XTEND_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1]'),
    allowedOrigins: list('XTEND_ALLOWED_ORIGINS'),
    dataDir: path.resolve(env.XTEND_DATA_DIR || './data'),
    repository, ref,
    githubToken: env.GITHUB_TOKEN || '',
    syncIntervalMs: number(env, 'XTEND_SYNC_INTERVAL_SECONDS', 300, 30, 86400) * 1000,
    upstreamTimeoutMs: number(env, 'XTEND_UPSTREAM_TIMEOUT_SECONDS', 20, 1, 120) * 1000,
    maxSnapshotBytes: number(env, 'XTEND_MAX_SNAPSHOT_BYTES', 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    retainSnapshots: number(env, 'XTEND_RETAIN_SNAPSHOTS', 3, 2, 20),
    maxBodyBytes: number(env, 'XTEND_MAX_BODY_BYTES', 65536, 1024, 1024 * 1024),
    maxResponseBytes: number(env, 'XTEND_MAX_RESPONSE_BYTES', 1024 * 1024, 4096, 16 * 1024 * 1024),
    requestTimeoutMs: number(env, 'XTEND_REQUEST_TIMEOUT_SECONDS', 10, 1, 60) * 1000,
    perKeyPerMinute: number(env, 'XTEND_REQUESTS_PER_KEY_MINUTE', 60, 1, 60000),
    perIpPerMinute: number(env, 'XTEND_REQUESTS_PER_IP_MINUTE', 120, 1, 60000),
    globalPerSecond: number(env, 'XTEND_GLOBAL_REQUESTS_SECOND', 10, 1, 10000),
    maxConcurrent: number(env, 'XTEND_MAX_CONCURRENT', 8, 1, 256),
    maxConnections: number(env, 'XTEND_MAX_CONNECTIONS', 128, 1, 10000)
  };
}
