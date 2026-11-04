import crypto from 'node:crypto';
import semver from 'semver';
import { z } from 'zod';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const topic = value => value.normalize('NFC').trim().toLowerCase();
const clip = (value, length) => Array.from(value).slice(0, length).join('');
const idSchema = z.string().min(1).max(256).refine(value => value.isWellFormed(), 'Expected a well-formed Unicode ID');
const versionSchema = z.string().min(1).max(128).refine(value => semver.valid(value) === value, 'Expected canonical exact SemVer');
const rangeSchema = z.string().min(1).max(256).refine(value => semver.validRange(value) !== null, 'Expected SemVer range');
const adapterName = z.string().min(1).max(64).regex(/^[a-zA-Z0-9@/_.-]+$/u);
const adapters = valueSchema => z.record(adapterName, valueSchema).refine(value => Object.keys(value).length <= 16, 'At most 16 adapter constraints per record/request').meta({ maxProperties: 16 });
export const targetSchema = z.object({ xtend: versionSchema, adapters: adapters(versionSchema).optional() }).strict();
const compatibilitySchema = z.object({ schema: z.literal('xtend.recipe.compatibility.v1'), xtend: rangeSchema, adapters: adapters(rangeSchema).optional() }).passthrough();
const metadataSchema = z.object({ locale: z.enum(['de', 'en', 'und']).optional(), compatibility: compatibilitySchema.optional() }).passthrough();
export const listRecipesSchema = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  pageSize: z.number().int().min(1).max(100).default(25),
  locale: z.enum(['all', 'de', 'en', 'und']).default('all'),
  topics: z.array(z.string().min(1).max(64).refine(value => topic(value).length > 0)).max(16).default([]),
  topicMode: z.enum(['any', 'all']).default('any'),
  target: targetSchema.optional(),
  includeUnknown: z.boolean().default(true),
  includeIncompatible: z.boolean().default(false)
}).strict();
export const promptArgumentsSchema = z.object({
  id: idSchema.optional(), task: z.string().max(2000).optional(),
  xtendVersion: versionSchema.optional(), adapterVersions: z.string().max(4096).optional(),
  allowIncompatible: z.enum(['true', 'false']).optional()
}).strict().refine(value => value.adapterVersions === undefined || value.xtendVersion !== undefined, 'adapterVersions requires xtendVersion');

export class RecipeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// This is precisely the upstream alias algorithm, never an array-position ID.
export const recipeAlias = id => `xtendRmt_${id.replace(/[^a-zA-Z0-9_]+/gu, '_')}`;

export function createRecipeCatalog(recipes) {
  const byId = new Map(), byAlias = new Map(), byUri = new Map();
  for (const record of recipes) {
    const identity = idSchema.safeParse(record.id);
    const metadata = metadataSchema.safeParse(record);
    if (!identity.success || !metadata.success) throw new RecipeError('INVALID_RECIPE_METADATA', 'Invalid recipe identity, locale or compatibility metadata');
    if (byId.has(record.id)) throw new RecipeError('DUPLICATE_RECIPE_ID', 'Duplicate recipe ID');
    const alias = recipeAlias(record.id);
    if (byAlias.has(alias)) throw new RecipeError('RECIPE_ALIAS_COLLISION', 'Recipe IDs normalize to the same legacy prompt alias');
    const uri = `xtend://rmt/kit/recipe/${encodeURIComponent(record.id)}`;
    const entry = Object.freeze({ record, alias, uri, locale: record.locale || 'und', topics: [...new Set(record.domains.map(topic))].sort(compare) });
    byId.set(record.id, entry); byAlias.set(alias, entry); byUri.set(uri, entry);
  }
  // Array order, locale collation, translated titles and new topics never change IDs.
  const entries = [...byId.values()].sort((a, b) => compare(a.record.id, b.record.id));
  return Object.freeze({ entries, byId, byAlias, byUri, hash: digest(entries.map(entry => entry.record)) });
}

export function recipeCompatibility(entry, target) {
  const requires = entry.record.compatibility;
  if (!requires) return { status: 'unknown', reasons: ['metadata_missing'] };
  if (!target) return { status: 'unknown', reasons: ['target_missing'], requires };
  const reasons = [], unknown = [];
  // node-semver's default prerelease policy: only explicitly matching ranges opt in.
  if (!semver.satisfies(target.xtend, requires.xtend)) reasons.push('xtend_version_mismatch');
  for (const [name, range] of Object.entries(requires.adapters || {})) {
    if (!Object.hasOwn(target.adapters || {}, name)) unknown.push(`adapter_version_missing:${name}`);
    else if (!semver.satisfies(target.adapters[name], range)) reasons.push(`adapter_version_mismatch:${name}`);
  }
  return { status: reasons.length ? 'incompatible' : unknown.length ? 'unknown' : 'compatible', reasons: [...reasons, ...unknown], requires };
}

export function toolResult(data) {
  // Text fallback for clients that ignore structuredContent; budget BOTH copies.
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const cursorSchema = z.object({ v: z.literal(1), kind: z.enum(['recipes', 'prompts']), commit: z.string().regex(/^[a-f0-9]{40}$/u), scope: z.string().length(64), query: z.string().length(64), last: idSchema }).strict();

function pagination(snapshot, catalog, kind, query, cursor) {
  const scope = digest([snapshot.repository, snapshot.ref, catalog.hash]);
  const queryHash = digest(query);
  let last;
  if (cursor !== undefined) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
      const raw = Buffer.from(cursor, 'base64url');
      if (raw.toString('base64url') !== cursor) throw new Error();
      const decoded = cursorSchema.parse(JSON.parse(raw.toString('utf8')));
      if (decoded.kind !== kind || decoded.query !== queryHash) throw new Error();
      if (decoded.commit !== snapshot.commit || decoded.scope !== scope) throw new RecipeError('STALE_CURSOR', 'Select the original X-XTend-Snapshot or restart listing without a cursor');
      last = decoded.last;
    } catch (error) {
      if (error instanceof RecipeError) throw error;
      throw new RecipeError('INVALID_CURSOR', 'Cursor is malformed or does not match this listing and its filters');
    }
  }
  return { last, encode: id => Buffer.from(JSON.stringify({ v: 1, kind, commit: snapshot.commit, scope, query: queryHash, last: id })).toString('base64url') };
}

export const provenanceOf = snapshot => ({ commit: snapshot.commit, repository: snapshot.repository, ref: snapshot.ref });
const summary = (entry, target) => ({
  id: entry.record.id, title: clip(entry.record.title, 200), intent: clip(entry.record.intent, 500),
  locale: entry.locale, topics: entry.topics, uri: entry.uri, prompt: 'xtend_recipe', promptAlias: entry.alias,
  compatibility: recipeCompatibility(entry, target)
});

export function listRecipes(snapshot, rawInput, maxBytes = 65536) {
  const input = listRecipesSchema.parse(rawInput);
  const { cursor, ...query } = input;
  query.topics = [...new Set(input.topics.map(topic))].sort(compare);
  if (query.target) query.target.adapters = Object.fromEntries(Object.entries(query.target.adapters || {}).sort(([a], [b]) => compare(a, b)));
  const catalog = snapshot.bundle.recipeCatalog;
  const paging = pagination(snapshot, catalog, 'recipes', query, cursor);
  const matches = catalog.entries.filter(entry => {
    if (input.locale !== 'all' && entry.locale !== input.locale) return false;
    if (query.topics.length && !query.topics[input.topicMode === 'all' ? 'every' : 'some'](name => entry.topics.includes(name))) return false;
    const { status } = recipeCompatibility(entry, input.target);
    return (input.includeUnknown || status !== 'unknown') && (input.includeIncompatible || status !== 'incompatible');
  });
  const position = paging.last === undefined ? -1 : matches.findIndex(entry => entry.record.id === paging.last);
  if (paging.last !== undefined && position < 0) throw new RecipeError('INVALID_CURSOR', 'Cursor boundary is absent from the filtered catalogue');
  const start = position + 1;
  const items = [];
  const result = () => ({
    schema: 'xtend.mcp.recipe-catalog.v1', provenance: provenanceOf(snapshot), catalogHash: catalog.hash,
    filters: query, total: matches.length, count: items.length, items,
    ...(start + items.length < matches.length && items.length ? { nextCursor: paging.encode(items.at(-1).id) } : {})
  });
  if (bytes(toolResult(result())) > maxBytes) throw new RecipeError('RECIPE_PAGE_BUDGET', 'Listing metadata exceeds the configured page budget');
  for (const entry of matches.slice(start, start + input.pageSize)) {
    items.push(summary(entry, input.target));
    if (bytes(toolResult(result())) > maxBytes) {
      items.pop();
      if (!items.length) throw new RecipeError('RECIPE_PAGE_BUDGET', 'One recipe summary exceeds the configured page budget; increase the budget');
      break;
    }
  }
  return toolResult(result());
}

const genericPrompt = { name: 'xtend_recipe', description: 'Read a recipe by stable ID; discover IDs with xtend_recipe_list or knowledge search.', arguments: [
  { name: 'id', required: true }, { name: 'xtendVersion' }, { name: 'adapterVersions', description: 'JSON object of adapter names and exact SemVer versions' }, { name: 'allowIncompatible' }
] };
export function listRecipePrompts(snapshot, cursor, maxBytes = 65536) {
  const catalog = snapshot.bundle.recipeCatalog;
  const paging = pagination(snapshot, catalog, 'prompts', {}, cursor);
  const position = paging.last === undefined ? -1 : catalog.entries.findIndex(entry => entry.record.id === paging.last);
  if (paging.last !== undefined && position < 0) throw new RecipeError('INVALID_CURSOR', 'Unknown prompt cursor boundary');
  const start = position + 1;
  const prompts = paging.last === undefined ? [genericPrompt] : [];
  let added = 0;
  const result = () => ({ prompts, _meta: { provenance: provenanceOf(snapshot) }, ...(start + added < catalog.entries.length && added ? { nextCursor: paging.encode(catalog.entries[start + added - 1].record.id) } : {}) });
  if (bytes(result()) > maxBytes) throw new RecipeError('RECIPE_PAGE_BUDGET', 'Prompt metadata exceeds the configured page budget');
  for (const entry of catalog.entries.slice(start, start + 25 - prompts.length)) {
    prompts.push({ name: entry.alias, title: clip(entry.record.title, 200), description: clip(entry.record.intent, 500), arguments: [{ name: 'task' }, ...genericPrompt.arguments.slice(1)] });
    added++;
    if (bytes(result()) > maxBytes) {
      prompts.pop(); added--;
      if (!added) throw new RecipeError('RECIPE_PAGE_BUDGET', 'One prompt summary exceeds the configured page budget');
      break;
    }
  }
  return result();
}

export function getRecipePrompt(snapshot, name, rawArguments = {}) {
  const args = promptArgumentsSchema.parse(rawArguments);
  if (name === 'xtend_recipe' && args.id === undefined) throw new RecipeError('INVALID_ARGUMENTS', 'xtend_recipe requires a stable recipe ID');
  const catalog = snapshot.bundle.recipeCatalog;
  const entry = name === 'xtend_recipe' ? catalog.byId.get(args.id) : catalog.byAlias.get(name);
  if (!entry || (name !== 'xtend_recipe' && args.id !== undefined && args.id !== entry.record.id)) throw new RecipeError('RECIPE_NOT_FOUND', 'Unknown recipe or prompt alias');
  let target;
  if (args.xtendVersion !== undefined) {
    let adapterVersions;
    try { adapterVersions = args.adapterVersions === undefined ? undefined : JSON.parse(args.adapterVersions); }
    catch { throw new RecipeError('INVALID_ARGUMENTS', 'adapterVersions must be a JSON object'); }
    target = targetSchema.parse({ xtend: args.xtendVersion, ...(adapterVersions === undefined ? {} : { adapters: adapterVersions }) });
  }
  const compatibility = recipeCompatibility(entry, target);
  if (compatibility.status === 'incompatible' && args.allowIncompatible !== 'true') throw new RecipeError('RECIPE_INCOMPATIBLE', 'Recipe requirements do not match the supplied versions; allowIncompatible=true is required for inspection');
  return { messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify({ provenance: provenanceOf(snapshot), recipe: entry.record, compatibility, ...(args.task ? { task: args.task } : {}) }) } }] };
}
