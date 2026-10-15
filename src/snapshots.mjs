import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARTIFACTS, BUNDLE_ROOT, validateBundle, verifySourceTree, hash, gitHash } from './bundle.mjs';
import { readLimited } from './io.mjs';
import { clearXtendKnowledgeCache, getXtendDocsCatalog } from '../vendor/xtend-knowledge.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const errorCode = error => error?.code || (error?.name === 'TimeoutError' ? 'upstream_timeout' : 'sync_validation_failed');

export class SnapshotStore {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.snapshots = new Map();
    this.current = null;
    this.inFlight = null;
    this.closed = false;
    this.controller = new AbortController();
    this.lastError = null;
    this.checkedAt = null;
    this.retryAt = 0;
  }

  async initialize() {
    await fs.mkdir(path.join(this.config.dataDir, 'snapshots'), { recursive: true });
    const dirs = await fs.readdir(path.join(this.config.dataDir, 'snapshots'));
    // Only our fixed staging-name pattern is removable on recovery.
    for (const name of dirs.filter(name => /^\.staging-[a-f0-9-]+$/u.test(name))) await fs.rm(path.join(this.config.dataDir, 'snapshots', name), { recursive: true, force: true });
    let pointer;
    try { pointer = JSON.parse(await fs.readFile(path.join(this.config.dataDir, 'active.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') this.lastError = 'invalid_cached_pointer'; }
    for (const commit of dirs.filter(name => SHA.test(name))) {
      try {
        const root = path.join(this.config.dataDir, 'snapshots', commit);
        const metadata = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'));
        if (metadata.commit !== commit || metadata.repository !== this.config.repository || metadata.ref !== this.config.ref || metadata.sourceVerified !== true) continue;
        const files = new Map();
        let size = 0;
        for (const name of ARTIFACTS) {
          const file = path.join(root, name);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || (size += stat.size) > this.config.maxSnapshotBytes) throw new Error('Invalid cached snapshot size');
          files.set(name, await fs.readFile(file));
        }
        const bundle = validateBundle(files);
        this.snapshots.set(commit, { ...metadata, bundle, root, leases: 0 });
      } catch { this.lastError = 'invalid_cached_snapshot'; }
    }
    this.current = this.snapshots.get(pointer?.commit) || [...this.snapshots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    if (this.current) this.checkedAt = this.current.createdAt;
    await this.prune();
  }

  acquire(commit) {
    if (commit && !SHA.test(commit)) throw Object.assign(new Error('Invalid snapshot ID'), { status: 400 });
    const snapshot = commit ? this.snapshots.get(commit) : this.current;
    if (!snapshot) throw Object.assign(new Error('Requested snapshot is unavailable'), { status: 503 });
    snapshot.leases++;
    return { snapshot, release: () => { snapshot.leases--; } };
  }

  status() {
    return {
      ready: Boolean(this.current), repository: this.config.repository, ref: this.config.ref,
      commit: this.current?.commit || null, activatedAt: this.current?.createdAt || null,
      checkedAt: this.checkedAt, lastError: this.lastError, syncing: Boolean(this.inFlight),
      retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null,
      availableSnapshots: [...this.snapshots.keys()],
      docs: this.current?.bundle.docs.length || 0, recipes: this.current?.bundle.recipes.length || 0
    };
  }

  async api(endpoint, { etag, limit = this.config.maxSnapshotBytes * 2 } = {}) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.upstreamTimeoutMs)]);
    const response = await this.fetch(`https://api.github.com/repos/${this.config.repository}/${endpoint}`, {
      signal, redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'XTend-MCP-Server/0.1.0',
        ...(this.config.githubToken ? { authorization: `Bearer ${this.config.githubToken}` } : {}),
        ...(etag ? { 'if-none-match': etag } : {})
      }
    });
    if (response.status === 304) return { unchanged: true };
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const delay = retry && /^\d+$/u.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
      if (response.status === 429 || response.status === 403) this.retryAt = Math.max(Date.now() + Math.max(delay || 0, 60000), response.headers.get('x-ratelimit-remaining') === '0' && reset ? reset : 0);
      throw Object.assign(new Error('GitHub request failed'), { code: `upstream_http_${response.status}` });
    }
    const bytes = await readLimited(response, limit, signal);
    return { data: JSON.parse(bytes.toString('utf8')), etag: response.headers.get('etag') || '' };
  }

  async blob(sha) {
    if (!SHA.test(sha)) throw new Error('Invalid upstream blob SHA');
    const { data } = await this.api(`git/blobs/${sha}`);
    if (data.encoding !== 'base64' || !Number.isSafeInteger(data.size) || data.size > this.config.maxSnapshotBytes) throw new Error('Unsupported blob encoding/size');
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.length !== data.size || gitHash(bytes) !== sha) throw new Error('Truncated or mismatched upstream blob');
    return bytes;
  }

  sync() {
    if (this.closed) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    this.inFlight = this.syncOnce().catch(error => {
      if (!this.closed) {
        this.lastError = errorCode(error);
        this.retryAt = Math.max(this.retryAt, Date.now() + 30000);
      }
      return false;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async syncOnce() {
    const { data, etag, unchanged } = await this.api(`commits/${encodeURIComponent(this.config.ref)}`, { etag: this.current?.etag, limit: 4 * 1024 * 1024 });
    this.checkedAt = new Date().toISOString();
    if (unchanged) { if (!this.current) throw new Error('304 without cache'); this.lastError = null; this.retryAt = 0; return false; }
    const commit = data?.sha;
    if (!SHA.test(commit) || !SHA.test(data.commit?.tree?.sha)) throw new Error('Invalid commit identity');
    if (commit === this.current?.commit) { this.current.etag = etag; this.lastError = null; this.retryAt = 0; return false; }
    const { data: tree } = await this.api(`git/trees/${data.commit.tree.sha}?recursive=1`, { limit: 16 * 1024 * 1024 });
    if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete upstream tree');
    const entries = new Map(tree.tree.filter(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode)).map(item => [item.path, item]));
    const files = new Map();
    let total = 0;
    for (const name of ARTIFACTS) {
      const entry = entries.get(`${BUNDLE_ROOT}/${name}`);
      if (!entry || !Number.isSafeInteger(entry.size) || (total += entry.size) > this.config.maxSnapshotBytes) throw new Error('Snapshot exceeds byte budget or is incomplete');
      const bytes = await this.blob(entry.sha);
      files.set(name, bytes);
    }
    const bundle = validateBundle(files);
    // Check declared kit source hashes against canonical blobs, without executing source.
    if (!Array.isArray(bundle.kitManifest.sourceHashes) || !bundle.kitManifest.sourceHashes.length) throw new Error('Missing kit source provenance');
    for (const source of bundle.kitManifest.sourceHashes) {
      const entry = entries.get(source.path);
      if (!entry || !Number.isSafeInteger(entry.size) || (total += entry.size) > this.config.maxSnapshotBytes) throw new Error('Source provenance exceeds budget');
      const bytes = (await this.blob(entry.sha)).toString('utf8').replace(/\r\n/gu, '\n');
      if (hash(bytes) !== source.sha256 || Buffer.byteLength(bytes) !== source.bytes) throw new Error('Stale kit source');
    }
    const menuEntry = entries.get('docs/menu.json');
    if (!menuEntry || total + menuEntry.size > this.config.maxSnapshotBytes) throw new Error('Canonical menu exceeds byte budget');
    verifySourceTree(bundle, files, tree, await this.blob(menuEntry.sha));
    const root = path.join(this.config.dataDir, 'snapshots', commit);
    const staging = path.join(this.config.dataDir, 'snapshots', `.staging-${crypto.randomUUID()}`);
    const metadata = { schema: 'xtend.hosted.snapshot.v1', repository: this.config.repository, ref: this.config.ref, commit, etag, sourceVerified: true, createdAt: new Date().toISOString() };
    try {
      for (const [name, bytes] of files) {
        await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
        await fs.writeFile(path.join(staging, name), bytes, { mode: 0o600 });
      }
      // Reuse the unchanged upstream index implementation, never downloaded code.
      getXtendDocsCatalog('all', { bundleDir: staging });
      await fs.writeFile(path.join(staging, 'snapshot.json'), JSON.stringify(metadata), { mode: 0o600 });
      if (!this.snapshots.has(commit)) {
        try { await fs.rename(staging, root); } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          // A stale, inactive directory may remain after a crash. Never replace a leased snapshot.
          await fs.rm(root, { recursive: true, force: true });
          await fs.rename(staging, root);
        }
      }
      const pointer = path.join(this.config.dataDir, `active-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(pointer, JSON.stringify(metadata), { mode: 0o600 });
      await fs.rename(pointer, path.join(this.config.dataDir, 'active.json'));
      this.current = this.snapshots.get(commit) || { ...metadata, bundle, root, leases: 0 };
      this.snapshots.set(commit, this.current);
      this.lastError = null; this.retryAt = 0;
      clearXtendKnowledgeCache();
      await this.prune();
      return true;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }

  async prune() {
    clearXtendKnowledgeCache();
    const snapshots = [...this.snapshots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const keep = new Set([this.current?.commit, ...snapshots.slice(0, this.config.retainSnapshots).map(item => item.commit)]);
    for (const snapshot of snapshots) {
      if (!keep.has(snapshot.commit) && snapshot.leases === 0) {
        this.snapshots.delete(snapshot.commit);
        await fs.rm(snapshot.root, { recursive: true, force: true });
      }
    }
  }

  async close() { this.closed = true; this.controller.abort(); await this.inFlight; }
}
