import { hash, KIT_FILES } from '../src/bundle.mjs';

export function fixture(count = 7, transform = recipe => recipe) {
 const docs = ['de','en'].map(locale => {const content = '# Maraca\nMaraca application services'; return {schema:'xtend.mcp.docs-resource.v1',locale,slug:'maraca',uri:`xtend://docs/${locale}/maraca`,title:'Maraca',sourcePath:`docs/${locale}/maraca.md`,content,sha256:hash(content),bytes:Buffer.byteLength(content)};});
 const recipes = Array.from({length:count},(_,i)=>transform({schema:'xtend.rmt.ai-developer-kit.recipe-record.v1',id:`recipe-${i}`,title:`Recipe ${i}`,intent:'Maraca recipe',domains:['future-topic'],steps:['Use app services']},i));
 const files = new Map(); const put=(n,v)=>files.set(n,Buffer.from(typeof v === 'string'?v:JSON.stringify(v)));
 put('docs.jsonl',docs.map(v=>JSON.stringify(v)).join('\n'));
 put('rmt-ai-kit/rmt-ai-kit.recipes.jsonl',recipes.map(v=>JSON.stringify(v)).join('\n'));
 put('rmt-ai-kit/rmt-ai-kit.reference.jsonl','');
 put('rmt-ai-kit/rmt-ai-kit.manifest.json',{kitSchema:'xtend.rmt.ai-developer-kit.v1',recordCounts:{recipes:count,reference:0}});
 put('rmt-ai-kit/rmt-ai-kit.guardrails.json',{});
 put('rmt-ai-kit/rmt-ai-kit.compact.md','Maraca'); put('rmt-ai-kit/rmt-ai-kit.prompts.md','Recipe prompts');
 put('knowledge-manifest.json',{schema:'xtend.mcp.knowledge-manifest.v1',docs:{artifact:'docs.jsonl',artifactSha256:hash(files.get('docs.jsonl')),count:2,counts:{de:1,en:1}},rmtKit:{recordCounts:{recipes:count,reference:0},artifacts:Object.fromEntries(KIT_FILES.map(n=>[n,{sha256:hash(files.get(`rmt-ai-kit/${n}`)),bytes:files.get(`rmt-ai-kit/${n}`).length}]))}});
 return files;
}
