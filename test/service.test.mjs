import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configFromEnv } from '../src/config.mjs';
import { createHttpServer } from '../src/http.mjs';
import { SnapshotStore } from '../src/snapshots.mjs';
import { hash, validateBundle, KIT_FILES } from '../src/bundle.mjs';
import { fixture } from './fixtures.mjs';
import { listRecipes } from '../src/recipes.mjs';
const token = 'a'.repeat(40);
test('recipe growth and corrupt artifact rejection',()=>{
 for(const count of [7,1000]) {const files=fixture(count); assert.equal(validateBundle(files).recipes.length,count); files.set('docs.jsonl',Buffer.from('corrupt')); assert.throws(()=>validateBundle(files),/hash/);}
});
test('configuration requires access secrets',()=>{assert.throws(()=>configFromEnv({}),/TOKENS/);});
test('real SDK transport initialize, discovery, search, resources, recipe; HTTP guards',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'xtend-mcp-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=fixture(1000);for(const[n,b]of files){await fs.mkdir(path.dirname(path.join(root,n)),{recursive:true});await fs.writeFile(path.join(root,n),b);}
 const snapshot={root,commit:'a'.repeat(40),repository:'fixture/test',ref:'main',bundle:validateBundle(files)};
 let leases=0;const store={current:snapshot,status:()=>({ready:true}),acquire:()=>{leases++;return{snapshot,release:()=>leases--};}};
 const config=configFromEnv({XTEND_MCP_TOKENS:token,PORT:'0',XTEND_GLOBAL_REQUESTS_SECOND:'100',XTEND_REQUESTS_PER_KEY_MINUTE:'100'});
 const server=createHttpServer(config,store);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}`;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'};
 const call=async(method,params={})=>{const r=await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);const b=await r.json();assert.equal(b.error,undefined,JSON.stringify(b));return b.result;};
 assert.equal((await fetch(url+'/mcp',{method:'POST'})).status,401);
 assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers,origin:'https://evil.invalid'}})).status,403);
 assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers,host:'evil.invalid'}})).status >= 400,true);
 await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
 const tools=await call('tools/list');assert.deepEqual(tools.tools.map(v=>v.name),['xtend_knowledge_search','xtend_knowledge_context','xtend_recipe_list']);
 const result=await call('tools/call',{name:'xtend_knowledge_search',arguments:{query:'Maraca',locale:'de'}});assert.match(result.content[0].text,/Maraca/);
 assert.equal((await call('resources/list')).resources.length,2);
 assert.match((await call('resources/read',{uri:'xtend://docs/de/maraca'})).contents[0].text,/Maraca/);
 assert.match((await call('prompts/get',{name:'xtend_recipe',arguments:{id:'recipe-999'}})).messages[0].content.text,/recipe-999/);
 assert.equal(leases,0);
 assert.equal((await fetch(url+'/mcp',{method:'POST',headers,body:'x'.repeat(70000)})).status,413);
});
test('failed sync retains previous snapshot and is single-flight',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xtend-sync-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config=configFromEnv({XTEND_MCP_TOKENS:token,XTEND_DATA_DIR:dir});let calls=0;
 const store=new SnapshotStore(config,{fetchImpl:async()=>{calls++;return new Response('{}',{status:503});}});await store.initialize();
 const previous={commit:'b'.repeat(40)};store.current=previous;const first=store.sync();assert.equal(store.sync(),first);await first;assert.equal(calls,1);assert.equal(store.current,previous);assert.equal(store.lastError,'upstream_http_503');await store.close();
});
test('validated sync, hot update, pinning and restart without upstream',async t=>{
 const { ARTIFACTS, BUNDLE_ROOT, KIT_ROOT, gitHash }=await import('../src/bundle.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xtend-hot-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let count=7;let commit='c'.repeat(40);let requests=0;let transform=recipe=>recipe;
 const fetchImpl=async url=>{
  requests++;
  const files=fixture(count,transform);
  const source=Buffer.from('canonical fixture source');
  const kit=JSON.parse(files.get('rmt-ai-kit/rmt-ai-kit.manifest.json'));
  kit.sourceHashes=[{path:'tools/fixture.js',sha256:hash(source),bytes:source.length}];
  const kitBytes=Buffer.from(JSON.stringify(kit));files.set('rmt-ai-kit/rmt-ai-kit.manifest.json',kitBytes);
  const menu=Buffer.from(JSON.stringify([{slug:'maraca'}]));
  const manifest=JSON.parse(files.get('knowledge-manifest.json'));
  manifest.docs.menuSha256=hash(menu);manifest.docs.menuEntries=1;
  manifest.rmtKit.artifacts['rmt-ai-kit.manifest.json']={sha256:hash(kitBytes),bytes:kitBytes.length};files.set('knowledge-manifest.json',Buffer.from(JSON.stringify(manifest)));
  const blobs=new Map();const tree=[];
  const add=(name,bytes)=>{const sha=gitHash(bytes);blobs.set(sha,bytes);tree.push({path:name,type:'blob',mode:'100644',sha,size:bytes.length});};
  for(const name of ARTIFACTS)add(`${BUNDLE_ROOT}/${name}`,files.get(name));
  for(const name of KIT_FILES)add(`${KIT_ROOT}/${name}`,files.get(`rmt-ai-kit/${name}`));
  for(const doc of JSON.parse('['+files.get('docs.jsonl').toString().split('\n').join(',')+']'))add(doc.sourcePath,Buffer.from(doc.content));
  add('docs/menu.json',menu);add('tools/fixture.js',source);
  if(url.includes('/commits/'))return Response.json({sha:commit,commit:{tree:{sha:'f'.repeat(40)}}});
  if(url.includes('/git/trees/'))return Response.json({truncated:false,tree});
  const blob=blobs.get(url.split('/').at(-1));assert.ok(blob);return Response.json({encoding:'base64',size:blob.length,content:blob.toString('base64')});
 };
 const config=configFromEnv({XTEND_MCP_TOKENS:token,XTEND_DATA_DIR:dir});
 const store=new SnapshotStore(config,{fetchImpl});await store.initialize();assert.equal(await store.sync(),true);assert.equal(store.current.bundle.recipes.length,7);
 const oldSnapshot=store.current;
 const firstPage=listRecipes(oldSnapshot,{pageSize:2}).structuredContent;
 const lease=store.acquire(commit);count=1000;commit='d'.repeat(40);assert.equal(await store.sync(),true);assert.equal(store.current.bundle.recipes.length,1000);assert.equal(lease.snapshot.bundle.recipes.length,7);lease.release();
 const validCommit=commit;
 // Invalid optional metadata cannot activate a partial catalogue or replace last good data.
 commit='e'.repeat(40);transform=recipe=>({...recipe,compatibility:{schema:'xtend.recipe.compatibility.v1',xtend:'invalid-range'}});
 assert.equal(await store.sync(),false);assert.equal(store.current.commit,validCommit);assert.equal(store.lastError,'INVALID_RECIPE_METADATA');
 await store.close();const before=requests;
 const recovered=new SnapshotStore(config,{fetchImpl});await recovered.initialize();assert.equal(recovered.current.commit,validCommit);assert.equal(recovered.current.bundle.recipes.length,1000);assert.equal(requests,before);
 const recoveredLease=recovered.acquire(oldSnapshot.commit);
 assert.deepEqual(listRecipes(recoveredLease.snapshot,{pageSize:2,cursor:firstPage.nextCursor}),listRecipes(oldSnapshot,{pageSize:2,cursor:firstPage.nextCursor}));
 recoveredLease.release();await recovered.close();
});
test('vendored retrieval matches pinned provenance',async()=>{
 const metadata=JSON.parse(await fs.readFile(new URL('../vendor/upstream.json',import.meta.url)));
 assert.equal(hash(await fs.readFile(new URL('../vendor/xtend-knowledge.mjs',import.meta.url))),metadata.sha256);
});
