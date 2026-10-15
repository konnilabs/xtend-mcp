import { configFromEnv } from './config.mjs';
import { SnapshotStore } from './snapshots.mjs';
import { createHttpServer } from './http.mjs';
const config = configFromEnv();
const store = new SnapshotStore(config);
await store.initialize();
const server = createHttpServer(config, store);
await new Promise(resolve => server.listen(config.port, config.host, resolve));
console.log(JSON.stringify({ event:'listening', port:server.address().port }));
let stopping = false;
let timer;
async function tick() { await store.sync(); if (!stopping) timer = setTimeout(tick, config.syncIntervalMs * (0.9 + Math.random() * 0.2)); }
void tick();
async function stop() { if (stopping) return; stopping = true; clearTimeout(timer); server.close(); server.closeAllConnections(); await store.close(); }
process.once('SIGTERM',stop); process.once('SIGINT',stop);
