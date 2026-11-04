import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './fixtures.mjs';
import { validateBundle } from '../src/bundle.mjs';
import { configFromEnv } from '../src/config.mjs';
import { createHttpServer } from '../src/http.mjs';
import { SnapshotStore } from '../src/snapshots.mjs';
import { listRecipes, listRecipePrompts, createRecipeCatalog, recipeCompatibility } from '../src/recipes.mjs';

const snapshotOf = (count = 7, transform) => ({ commit: 'a'.repeat(40), repository: 'fixture/test', ref: 'main', bundle: validateBundle(fixture(count, transform)) });
const data = result => { assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); return result.structuredContent; };
const compatible = (recipe, i) => ({ ...recipe, locale: i % 2 ? 'de' : 'en', compatibility: { schema: 'xtend.recipe.compatibility.v1', xtend: '>=0.8.0 <1.0.0', adapters: { react: '^19.0.0' } } });

async function httpFixture(t, snapshot, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xtend-recipes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  snapshot.root = root;
  const files = fixture(snapshot.bundle.recipes.length, (_, i) => snapshot.bundle.recipes[i]);
  for (const [name, value] of files) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), value); }
  const config = configFromEnv({ XTEND_MCP_TOKENS: 'x'.repeat(40), PORT: '0', XTEND_GLOBAL_REQUESTS_SECOND: '10000', XTEND_REQUESTS_PER_KEY_MINUTE: '60000', XTEND_REQUESTS_PER_IP_MINUTE: '60000', ...overrides });
  const store = new SnapshotStore(config);
  snapshot.leases = 0; store.snapshots.set(snapshot.commit, snapshot); store.current = snapshot;
  const server = createHttpServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let id = 0;
  const rpc = async (method, params = {}, commit, requestId) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(commit ? { 'x-xtend-snapshot': commit } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId ?? ++id, method, params }) });
    const wire = await response.text();
    assert.ok(Buffer.byteLength(wire) <= config.maxResponseBytes);
    return { status: response.status, chosen: response.headers.get('x-xtend-snapshot'), body: JSON.parse(wire), bytes: Buffer.byteLength(wire) };
  };
  const call = async (method, params = {}, commit) => {
    const response = await rpc(method, params, commit);
    assert.equal(response.status, 200); assert.equal(response.body.error, undefined, JSON.stringify(response.body));
    return response.body.result;
  };
  return { rpc, call, store, config };
}

test('complete, deterministic traversal at empty, small, 1,000 and larger inventory sizes', () => {
  for (const count of [0, 1, 7, 1000, 1403]) {
    const snapshot = snapshotOf(count);
    const seen = []; let cursor;
    do {
      const page = data(listRecipes(snapshot, { pageSize: 37, ...(cursor ? { cursor } : {}) }));
      assert.equal(page.total, count); assert.ok(page.count <= 37); assert.equal(page.count, page.items.length);
      for (const item of page.items) {
        assert.equal(item.compatibility.status, 'unknown'); assert.equal(item.locale, 'und');
        assert.equal(item.uri, `xtend://rmt/kit/recipe/${encodeURIComponent(item.id)}`);
        assert.equal('source' in item, false); assert.equal('steps' in item, false);
      }
      seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, count);
    assert.deepEqual(seen, snapshot.bundle.recipes.map(recipe => recipe.id).sort());
    const reversed = { ...snapshot, bundle: { recipeCatalog: createRecipeCatalog([...snapshot.bundle.recipes].reverse()) } };
    assert.deepEqual(listRecipes(reversed, {}), listRecipes(snapshot, {}));
  }
});

test('language is explicit, topics remain open and any/all filters are exact', () => {
  const snapshot = snapshotOf(9, (recipe, i) => ({ ...recipe, ...(i ? { locale: i % 2 ? 'de' : 'en' } : {}), domains: i % 2 ? ['Maraca', 'future-topic-v42'] : ['SSR'] }));
  assert.equal(data(listRecipes(snapshot, { locale: 'de' })).total, 4);
  assert.equal(data(listRecipes(snapshot, { locale: 'en' })).total, 4);
  assert.equal(data(listRecipes(snapshot, { locale: 'und' })).total, 1);
  assert.equal(data(listRecipes(snapshot, { topics: ['MARACA', 'ssr'] })).total, 9);
  assert.equal(data(listRecipes(snapshot, { topics: ['MARACA', ' future-topic-v42 '], topicMode: 'all' })).total, 4);
  assert.equal(data(listRecipes(snapshot, { topics: ['maraca', 'ssr'], topicMode: 'all' })).count, 0);
  assert.equal(data(listRecipes(snapshot, { topics: ['mar'] })).count, 0);
});

test('compatibility uses exact target SemVer, adapter constraints and explicit unknown states', () => {
  const entry = createRecipeCatalog([compatible(snapshotOf(1).bundle.recipes[0], 0)]).entries[0];
  assert.equal(recipeCompatibility(entry).status, 'unknown');
  assert.equal(recipeCompatibility(entry, { xtend: '0.9.0' }).status, 'unknown');
  assert.equal(recipeCompatibility(entry, { xtend: '0.9.0', adapters: { react: '19.2.0' } }).status, 'compatible');
  assert.equal(recipeCompatibility(entry, { xtend: '1.0.0', adapters: { react: '19.2.0' } }).status, 'incompatible');
  assert.equal(recipeCompatibility(entry, { xtend: '0.9.0', adapters: { react: '18.3.0' } }).status, 'incompatible');
  assert.equal(recipeCompatibility(entry, { xtend: '0.9.0-beta.1', adapters: { react: '19.2.0' } }).status, 'incompatible');
  const prerelease = createRecipeCatalog([{ ...entry.record, compatibility: { schema: 'xtend.recipe.compatibility.v1', xtend: '>=0.9.0-beta.1 <0.9.0' } }]).entries[0];
  assert.equal(recipeCompatibility(prerelease, { xtend: '0.9.0-beta.2' }).status, 'compatible');
  const snapshot = snapshotOf(3, (recipe, i) => i ? { ...recipe, compatibility: { schema: 'xtend.recipe.compatibility.v1', xtend: i === 1 ? '^0.9.0' : '^1.0.0' } } : recipe);
  const target = { xtend: '0.9.0' };
  assert.deepEqual(data(listRecipes(snapshot, { target })).items.map(item => item.compatibility.status), ['unknown', 'compatible']);
  assert.equal(data(listRecipes(snapshot, { target, includeUnknown: false })).total, 1);
  assert.equal(data(listRecipes(snapshot, { target, includeIncompatible: true })).total, 3);
});

test('cursor binds snapshot, full filter and listing kind; malformed cursors are rejected', () => {
  const snapshot = snapshotOf(7);
  const query = { pageSize: 2, topics: ['future-topic', 'FUTURE-TOPIC'] };
  const first = data(listRecipes(snapshot, query));
  const next = data(listRecipes(snapshot, { ...query, topics: [' FUTURE-TOPIC '], cursor: first.nextCursor }));
  assert.equal(next.items[0].id, 'recipe-2');
  assert.throws(() => listRecipes(snapshot, { ...query, locale: 'de', cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  assert.throws(() => listRecipes(snapshot, { ...query, pageSize: 3, cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  assert.throws(() => listRecipePrompts(snapshot, first.nextCursor), { code: 'INVALID_CURSOR' });
  assert.throws(() => listRecipes({ ...snapshot, commit: 'b'.repeat(40) }, { ...query, cursor: first.nextCursor }), { code: 'STALE_CURSOR' });
  for (const cursor of ['', '!!!', '1', 'e30', 'a'.repeat(4097)]) assert.throws(() => listRecipes(snapshot, { ...query, cursor }));
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url')); forged.last = 'absent';
  assert.throws(() => listRecipes(snapshot, { ...query, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), { code: 'INVALID_CURSOR' });
});

test('summary pages measure UTF-8 and duplicated tool content; oversized records are never skipped', () => {
  const snapshot = snapshotOf(60, recipe => ({ ...recipe, title: '🦔'.repeat(500), intent: '"漢\\'.repeat(1000), source: 'private recipe source'.repeat(5000) }));
  let cursor; const seen = [];
  do {
    const result = listRecipes(snapshot, { pageSize: 100, ...(cursor ? { cursor } : {}) }, 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    const page = data(result); assert.ok(page.count > 0 && page.count < 100);
    seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, snapshot.bundle.recipes.length);
  assert.throws(() => listRecipes(snapshot, {}, 300), { code: 'RECIPE_PAGE_BUDGET' });
  const hugeTopic = snapshotOf(1, recipe => ({ ...recipe, domains: ['x'.repeat(100000)] }));
  assert.throws(() => listRecipes(hugeTopic, {}, 4096), { code: 'RECIPE_PAGE_BUDGET' });
  let promptCursor; const aliases = [];
  do {
    const page = listRecipePrompts(snapshot, promptCursor, 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    aliases.push(...page.prompts.map(prompt => prompt.name)); promptCursor = page.nextCursor;
  } while (promptCursor);
  assert.equal(new Set(aliases).size, snapshot.bundle.recipes.length + 1);
});

test('metadata validation rejects ambiguous aliases, duplicate IDs, unsupported schema and invalid ranges', () => {
  const recipe = snapshotOf(1).bundle.recipes[0];
  assert.throws(() => createRecipeCatalog([recipe, recipe]), { code: 'DUPLICATE_RECIPE_ID' });
  assert.throws(() => createRecipeCatalog([{ ...recipe, id: 'a-b' }, { ...recipe, id: 'a_b' }]), { code: 'RECIPE_ALIAS_COLLISION' });
  for (const compatibility of [{ schema: 'xtend.recipe.compatibility.v2', xtend: '*' }, { schema: 'xtend.recipe.compatibility.v1', xtend: 'tomorrow' }]) {
    assert.throws(() => snapshotOf(1, recipe => ({ ...recipe, compatibility })), { code: 'INVALID_RECIPE_METADATA' });
  }
  assert.throws(() => snapshotOf(1, recipe => ({ ...recipe, locale: 'guess' })), { code: 'INVALID_RECIPE_METADATA' });
  assert.throws(() => snapshotOf(1, recipe => ({ ...recipe, id: '\uD800' })), { code: 'INVALID_RECIPE_METADATA' });
  assert.doesNotThrow(() => snapshotOf(7, recipe => ({ ...recipe, extraFutureMetadata: true })));
});

test('canonical IDs retain case and escaping; compatibility filters remain cursor-bound', () => {
  const snapshot = snapshotOf(3, (recipe, i) => ({ ...recipe, id: ['Demo/A?B#C%', 'MiXeD', 'different'][i], compatibility: { schema: 'xtend.recipe.compatibility.v1', xtend: '*' } }));
  const first = data(listRecipes(snapshot, { pageSize: 1, target: { xtend: '0.9.0' } }));
  assert.equal(first.items[0].id, 'Demo/A?B#C%');
  assert.equal(first.items[0].uri, 'xtend://rmt/kit/recipe/Demo%2FA%3FB%23C%25');
  assert.throws(() => listRecipes(snapshot, { pageSize: 1, target: { xtend: '1.0.0' }, cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  assert.throws(() => listRecipes(snapshot, { pageSize: 1, target: { xtend: '0.9.0' }, includeUnknown: false, cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
});

test('SDK HTTP contract: tool schemas, every 1,000-recipe page, paginated aliases and legacy reads', async t => {
  const snapshot = snapshotOf(1000);
  const { call, rpc } = await httpFixture(t, snapshot);
  const tools = await call('tools/list'); const tool = tools.tools.find(tool => tool.name === 'xtend_recipe_list');
  assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.pageSize.maximum, 100); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.required, undefined, 'Defaulted inputs must remain optional in the advertised input schema');
  assert.equal(tool.inputSchema.properties.target.properties.adapters.maxProperties, 16);
  const seen = []; let cursor;
  do {
    const page = data(await call('tools/call', { name: tool.name, arguments: { pageSize: 71, ...(cursor ? { cursor } : {}) } }, snapshot.commit));
    assert.equal(page.provenance.commit, snapshot.commit); seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, snapshot.bundle.recipes.length); assert.equal(seen.length, snapshot.bundle.recipes.length);
  const aliases = []; let promptCursor;
  do {
    const page = await call('prompts/list', promptCursor ? { cursor: promptCursor } : {});
    assert.ok(page.prompts.length <= 25); aliases.push(...page.prompts.map(prompt => prompt.name)); promptCursor = page.nextCursor;
  } while (promptCursor);
  assert.equal(aliases[0], 'xtend_recipe'); assert.equal(new Set(aliases).size, snapshot.bundle.recipes.length + 1);
  const generic = JSON.parse((await call('prompts/get', { name: 'xtend_recipe', arguments: { id: 'recipe-999' } })).messages[0].content.text);
  const alias = JSON.parse((await call('prompts/get', { name: 'xtendRmt_recipe_999', arguments: { task: 'Example context' } })).messages[0].content.text);
  assert.deepEqual(alias.recipe, generic.recipe); assert.equal(alias.task, 'Example context');
  const resource = await call('resources/read', { uri: 'xtend://rmt/kit/recipe/recipe-999' });
  assert.deepEqual(JSON.parse(resource.contents[0].text), generic.recipe);
  const bad = await rpc('tools/call', { name: tool.name, arguments: { pageSize: 1001 } });
  assert.equal(bad.body.error.code, -32602); assert.equal(bad.body.error.data.code, 'INVALID_ARGUMENTS');
  assert.equal(snapshot.leases, 0);
});

test('SDK HTTP snapshot switching requires pinning and fails explicitly after eviction', async t => {
  const a = snapshotOf(7); const b = { ...snapshotOf(1000), commit: 'b'.repeat(40), leases: 0 };
  const { call, rpc, store } = await httpFixture(t, a);
  const first = data(await call('tools/call', { name: 'xtend_recipe_list', arguments: { pageSize: 2 } }));
  store.snapshots.set(b.commit, b); store.current = b;
  const arguments_ = { pageSize: 2, cursor: first.nextCursor };
  const stale = await call('tools/call', { name: 'xtend_recipe_list', arguments: arguments_ });
  assert.equal(stale.isError, true); assert.equal(JSON.parse(stale.content[0].text).error, 'STALE_CURSOR');
  const pinned = data(await call('tools/call', { name: 'xtend_recipe_list', arguments: arguments_ }, a.commit));
  assert.equal(pinned.provenance.commit, a.commit); assert.equal(pinned.total, 7);
  store.snapshots.delete(a.commit);
  const evicted = await rpc('tools/call', { name: 'xtend_recipe_list', arguments: arguments_ }, a.commit);
  assert.equal(evicted.status, 503); assert.equal(evicted.body.error, 'request_failed');
  assert.equal(a.leases, 0); assert.equal(b.leases, 0);
});

test('SDK HTTP prompt compatibility errors and bounded response budgets', async t => {
  const snapshot = snapshotOf(7, compatible);
  const { rpc, call } = await httpFixture(t, snapshot, { XTEND_RECIPE_PAGE_BYTES: '4096', XTEND_MAX_RESPONSE_BYTES: '8192' });
  const incompatible = await rpc('prompts/get', { name: 'xtend_recipe', arguments: { id: 'recipe-0', xtendVersion: '1.0.0' } });
  assert.equal(incompatible.body.error.data.code, 'RECIPE_INCOMPATIBLE');
  const inspected = JSON.parse((await call('prompts/get', { name: 'xtend_recipe', arguments: { id: 'recipe-0', xtendVersion: '1.0.0', allowIncompatible: 'true' } })).messages[0].content.text);
  assert.equal(inspected.compatibility.status, 'incompatible');
  const compatiblePrompt = JSON.parse((await call('prompts/get', { name: 'xtendRmt_recipe_0', arguments: { xtendVersion: '0.9.0', adapterVersions: '{"react":"19.2.0"}' } })).messages[0].content.text);
  assert.equal(compatiblePrompt.compatibility.status, 'compatible');
  for (const args of [{ xtendVersion: '^0.9.0' }, { xtendVersion: '0.9.0', adapterVersions: 'invalid' }, { adapterVersions: '{}' }]) {
    const result = await rpc('prompts/get', { name: 'xtend_recipe', arguments: { id: 'recipe-0', ...args } }); assert.equal(result.body.error.code, -32602);
  }
  const result = await call('tools/call', { name: 'xtend_recipe_list', arguments: {} });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096); assert.ok(data(result).nextCursor);
  const hugeId = await rpc('tools/call', { name: 'xtend_recipe_list', arguments: {} }, undefined, 'x'.repeat(9000));
  assert.equal(hugeId.status, 413); assert.equal(hugeId.body.error, 'request_id_too_large');
});
