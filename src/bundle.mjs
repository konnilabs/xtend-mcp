import crypto from 'node:crypto';

export const KIT_FILES = Object.freeze([
  'rmt-ai-kit.compact.md', 'rmt-ai-kit.guardrails.json', 'rmt-ai-kit.manifest.json',
  'rmt-ai-kit.prompts.md', 'rmt-ai-kit.recipes.jsonl', 'rmt-ai-kit.reference.jsonl'
]);
export const ARTIFACTS = Object.freeze(['knowledge-manifest.json', 'docs.jsonl', ...KIT_FILES.map(name => `rmt-ai-kit/${name}`)]);
export const BUNDLE_ROOT = 'products/xtend-mcp/generated';
export const KIT_ROOT = 'tools/rmt-language/generated/rmt-ai-developer-kit';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const gitHash = value => {
  const bytes = Buffer.from(value);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const json = value => JSON.parse(Buffer.from(value).toString('utf8'));
const jsonl = value => Buffer.from(value).toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const requireValue = (value, label) => { if (!value) throw new Error(`Invalid knowledge bundle: ${label}`); };

export function validateBundle(files) {
  ARTIFACTS.forEach(name => requireValue(Buffer.isBuffer(files.get(name)), `missing ${name}`));
  const manifest = json(files.get('knowledge-manifest.json'));
  requireValue(manifest.schema === 'xtend.mcp.knowledge-manifest.v1', 'unsupported manifest schema');
  requireValue(manifest.docs?.artifact === 'docs.jsonl', 'docs artifact path');
  requireValue(hash(files.get('docs.jsonl')) === manifest.docs.artifactSha256, 'docs artifact hash');
  const docs = jsonl(files.get('docs.jsonl'));
  requireValue(docs.length > 0 && docs.length === manifest.docs.count, 'docs count');
  const uris = new Set();
  const sourcePaths = new Set();
  for (const doc of docs) {
    requireValue(doc.schema === 'xtend.mcp.docs-resource.v1', 'document schema');
    requireValue(['de', 'en'].includes(doc.locale) && /^[a-z0-9-]+$/u.test(doc.slug), 'document identity');
    requireValue(doc.uri === `xtend://docs/${doc.locale}/${doc.slug}` && !uris.has(doc.uri), 'unique document URI');
    requireValue(typeof doc.sourcePath === 'string' && doc.sourcePath.startsWith(`docs/${doc.locale}/`) && doc.sourcePath.endsWith('.md') && !doc.sourcePath.split('/').some(part => part === '..' || part === '.' || part === '') && !sourcePaths.has(doc.sourcePath), 'document source');
    requireValue(typeof doc.content === 'string' && hash(doc.content) === doc.sha256 && Buffer.byteLength(doc.content) === doc.bytes, 'document hash/bytes');
    uris.add(doc.uri); sourcePaths.add(doc.sourcePath);
  }
  for (const locale of ['de', 'en']) requireValue(docs.filter(doc => doc.locale === locale).length === manifest.docs.counts?.[locale], 'locale counts');
  for (const name of KIT_FILES) {
    const data = files.get(`rmt-ai-kit/${name}`);
    const expected = manifest.rmtKit?.artifacts?.[name];
    requireValue(expected && hash(data) === expected.sha256 && data.length === expected.bytes, `kit hash ${name}`);
  }
  const kitManifest = json(files.get('rmt-ai-kit/rmt-ai-kit.manifest.json'));
  requireValue(kitManifest.kitSchema === 'xtend.rmt.ai-developer-kit.v1', 'unsupported kit schema');
  json(files.get('rmt-ai-kit/rmt-ai-kit.guardrails.json'));
  const recipes = jsonl(files.get('rmt-ai-kit/rmt-ai-kit.recipes.jsonl'));
  const references = jsonl(files.get('rmt-ai-kit/rmt-ai-kit.reference.jsonl'));
  requireValue(recipes.length === manifest.rmtKit.recordCounts.recipes && recipes.length === kitManifest.recordCounts?.recipes, 'recipe count consistency');
  requireValue(references.length === manifest.rmtKit.recordCounts.reference && references.length === kitManifest.recordCounts?.reference, 'reference count consistency');
  for (const [records, type] of [[recipes, 'recipe'], [references, 'reference']]) {
    const ids = new Set();
    for (const record of records) {
      requireValue(typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 256 && !ids.has(record.id), `unique ${type} ID`);
      requireValue(record.schema === `xtend.rmt.ai-developer-kit.${type}-record.v1`, `${type} schema`);
      if (type === 'recipe') requireValue(typeof record.title === 'string' && typeof record.intent === 'string' && Array.isArray(record.domains) && record.domains.every(domain => typeof domain === 'string'), 'recipe metadata');
      ids.add(record.id);
    }
  }
  return { manifest, docs, recipes, references, kitManifest };
}

// Verify freshness against actual canonical source blobs in the SAME Git tree.
// A self-consistent generated manifest alone cannot prove source freshness.
export function verifySourceTree(bundle, files, tree, menuBytes) {
  requireValue(tree.truncated === false && Array.isArray(tree.tree), 'complete source tree');
  const entries = new Map(tree.tree.filter(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode)).map(item => [item.path, item.sha]));
  const sourceDocs = [...entries.keys()].filter(name => /^docs\/(de|en)\/.+\.md$/u.test(name));
  requireValue(sourceDocs.length === bundle.docs.length, 'canonical docs coverage');
  for (const doc of bundle.docs) {
    const expected = entries.get(doc.sourcePath);
    requireValue(expected && (gitHash(doc.content) === expected || gitHash(doc.content.replace(/\n/gu, '\r\n')) === expected), `stale document ${doc.sourcePath}`);
  }
  requireValue(entries.get('docs/menu.json') === gitHash(menuBytes), 'canonical menu blob');
  const normalizedMenu = menuBytes.toString('utf8').replace(/\r\n/gu, '\n');
  requireValue(hash(normalizedMenu) === bundle.manifest.docs.menuSha256, 'canonical menu hash');
  const menu = JSON.parse(normalizedMenu);
  requireValue(menu.length === bundle.manifest.docs.menuEntries, 'menu coverage');
  for (const item of menu) for (const locale of ['de', 'en']) requireValue(bundle.docs.some(doc => doc.locale === locale && doc.slug === item.slug), 'localized menu coverage');
  for (const name of KIT_FILES) requireValue(entries.get(`${KIT_ROOT}/${name}`) === gitHash(files.get(`rmt-ai-kit/${name}`)), `stale canonical kit ${name}`);
}
