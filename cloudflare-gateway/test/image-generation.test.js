import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleGeneration, MODEL } from '../src/image-generation.js';
import { resolveGenerationReference } from '../src/generation-reference.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAEHElEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADg3QABAAH9QmP5AAAAAElFTkSuQmCC';
function setup(t, ai){const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../migrations/0005_image_generation.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE ownership(kind TEXT,id TEXT,user_id TEXT)');t.after(()=>db.close());
 const DB={prepare(sql){let params=[];return {bind(...p){params=p;return this},async first(column){const r=db.prepare(sql).get(...params);return column?r?.[column]??null:r??null},async run(){return db.prepare(sql).run(...params)}}}};
 const pending=[];return {db,env:{DB,AI:{run:ai|| (async()=>({image}))},IMAGE_GENERATION_ENABLED:'1'},ctx:{waitUntil(p){pending.push(p)}},async drain(){await Promise.all(pending)}};}
const submit={action:'submit',operationId:'one',prompt:'A blue chair',width:256,height:256,seed:7};
test('submit returns immediately and generated image is available through an owned get',async t=>{let calls=0;const s=setup(t,async(model,args)=>{calls++;assert.equal(model,MODEL);assert.match(args.multipart.contentType,/multipart\/form-data; boundary=/);return {image}});
 const r=await handleGeneration(s.env,s.ctx,'alice',submit);assert.equal(r.structuredContent.state,'running');await s.drain();const out=await handleGeneration(s.env,s.ctx,'alice',{action:'get',jobId:r.structuredContent.jobId});assert.equal(out.structuredContent.state,'succeeded');assert.ok(out.content.some(c=>c.type==='image'));assert.equal(calls,1);});
test('idempotency never repeats inference and conflicting input is rejected',async t=>{let calls=0;const s=setup(t,async()=>{calls++;return {image}});const a=await handleGeneration(s.env,s.ctx,'a',submit);const b=await handleGeneration(s.env,s.ctx,'a',submit);assert.equal(a.structuredContent.jobId,b.structuredContent.jobId);await s.drain();assert.equal(calls,1);const conflict=await handleGeneration(s.env,s.ctx,'a',{...submit,seed:8});assert.equal(conflict.structuredContent.error.code,'GENERATION_OPERATION_CONFLICT');});
test('cross-user get cancel delete and raw owner injection are denied',async t=>{const s=setup(t);const a=await handleGeneration(s.env,s.ctx,'a',submit);await s.drain();for(const action of ['get','cancel','delete']){const r=await handleGeneration(s.env,s.ctx,'b',{action,jobId:a.structuredContent.jobId});assert.equal(r.structuredContent.error.code,'GENERATION_NOT_FOUND');}const injected=await handleGeneration(s.env,s.ctx,'b',{...submit,user_id:'a'});assert.equal(injected.structuredContent.error.code,'INVALID_GENERATION_REQUEST');});
test('user quota applies after three reservations and global quota is atomic in SQLite',async t=>{const s=setup(t);for(let i=0;i<3;i++)assert.equal((await handleGeneration(s.env,s.ctx,'a',{...submit,operationId:'a'+i})).isError,false);const limited=await handleGeneration(s.env,s.ctx,'a',{...submit,operationId:'a4'});assert.equal(limited.structuredContent.error.code,'GENERATION_USER_QUOTA');for(let i=0;i<31;i++)await handleGeneration(s.env,s.ctx,'user'+i,{...submit,operationId:'global'+i});const global=await handleGeneration(s.env,s.ctx,'last',{...submit,operationId:'end'});assert.equal(global.structuredContent.error.code,'GENERATION_DAILY_QUOTA');assert.ok(s.db.prepare('SELECT SUM(neuron_units) AS n FROM image_generation_jobs').get().n<=90000);await s.drain();});
test('cancellation cannot be overwritten by late provider completion and delete purges the image',async t=>{let done;const s=setup(t,()=>new Promise(r=>{done=r}));const a=await handleGeneration(s.env,s.ctx,'a',submit);await handleGeneration(s.env,s.ctx,'a',{action:'cancel',jobId:a.structuredContent.jobId});done({image});await s.drain();assert.equal((await handleGeneration(s.env,s.ctx,'a',{action:'get',jobId:a.structuredContent.jobId})).structuredContent.state,'cancelled');await handleGeneration(s.env,s.ctx,'a',{action:'delete',jobId:a.structuredContent.jobId});assert.equal(s.db.prepare('SELECT image FROM image_generation_jobs').get().image,null);});
test('provider failures are redacted and rejected dimensions never invoke AI',async t=>{let calls=0;const s=setup(t,async()=>{calls++;throw Error('private-token')});const bad=await handleGeneration(s.env,s.ctx,'a',{...submit,width:1024});assert.equal(bad.structuredContent.error.code,'INVALID_GENERATION_REQUEST');assert.equal(calls,0);const a=await handleGeneration(s.env,s.ctx,'a',submit);await s.drain();const failed=await handleGeneration(s.env,s.ctx,'a',{action:'get',jobId:a.structuredContent.jobId});assert.equal(failed.structuredContent.error,'GENERATION_PROVIDER_ERROR');assert.ok(!JSON.stringify(failed).includes('private-token'));});
test('result expiry removes image and an interrupted job is not regenerated',async t=>{const s=setup(t);const a=await handleGeneration(s.env,s.ctx,'a',submit);await s.drain();s.db.prepare('UPDATE image_generation_jobs SET created_at=?').run(Date.now()-86400001);assert.equal((await handleGeneration(s.env,s.ctx,'a',{action:'get',jobId:a.structuredContent.jobId})).structuredContent.state,'expired');assert.equal(s.db.prepare('SELECT image FROM image_generation_jobs').get().image,null);s.db.prepare("UPDATE image_generation_jobs SET state='running',updated_at=?").run(Date.now()-120001);assert.equal((await handleGeneration(s.env,s.ctx,'a',{action:'get',jobId:a.structuredContent.jobId})).structuredContent.error,'GENERATION_INTERRUPTED');});
test('feature disabled and missing authentication fail closed',async t=>{const s=setup(t);s.env.IMAGE_GENERATION_ENABLED='0';assert.equal((await handleGeneration(s.env,s.ctx,'a',submit)).structuredContent.error.code,'GENERATION_DISABLED');s.env.IMAGE_GENERATION_ENABLED='1';assert.equal((await handleGeneration(s.env,s.ctx,null,submit)).structuredContent.error.code,'GENERATION_AUTH_REQUIRED');});

function referenceTransport(records, mode='preview'){
 return async(url,options)=>{
  assert.equal(options.redirect,'manual','Workers rejects redirect:error before sending a request');
  records.push({url,headers:options.headers,body:JSON.parse(options.body)});
  const params=JSON.parse(options.body).params;
  if(params.arguments.op==='document.info')return Response.json({result:{structuredContent:{result:{document:{canvas:{width:1200,height:1000}}}}}});
  if(mode==='unavailable')return new Response('private origin details',{status:503});
  if(params.name==='artforge_export')return Response.json({result:{content:[{type:'image',mimeType:'image/png',data:image}]}});
  if(mode==='fallback')return Response.json({result:{isError:true,structuredContent:{error:{code:'RESPONSE_TOO_LARGE'}}}});
  return Response.json({result:{structuredContent:{result:{base64:mode==='invalid'?'not-png':image}}}});
 };
}
function owned(s){s.db.prepare('INSERT INTO ownership VALUES(?,?,?)').run('doc','doc_owned','alice');s.env.ORIGIN_URL='https://renderer.example';s.env.ORIGIN_TOKEN='test-only-placeholder';}

test('owned drawing is sent as actual binary input_image_0 with independently checked provenance',async t=>{
 let submitted;const s=setup(t,async(model,args)=>{
  const form=await new Response(args.multipart.body,{headers:{'Content-Type':args.multipart.contentType}}).formData();
  submitted=Buffer.from(await form.get('input_image_0').arrayBuffer());return {image};
 });owned(s);const calls=[];
 const resolver=(...args)=>resolveGenerationReference(...args,referenceTransport(calls));
 const r=await handleGeneration(s.env,s.ctx,'alice',{...submit,documentId:'doc_owned'},resolver);assert.equal(r.isError,false);
 await s.drain();assert.deepEqual(submitted,Buffer.from(image,'base64'));
 const out=await handleGeneration(s.env,s.ctx,'alice',{action:'get',jobId:r.structuredContent.jobId});
 assert.equal(out.structuredContent.source.mode,'image-to-image');
 const expected=Buffer.from(await crypto.subtle.digest('SHA-256',submitted)).toString('hex');
 assert.equal(out.structuredContent.source.referenceSha256,expected);assert.equal(out.structuredContent.source.referenceDocumentId,'doc_owned');
 assert.equal(calls[0].headers.Authorization,'Bearer test-only-placeholder');assert.equal(calls[1].body.params.arguments.params.maxWidth,511);
 const row=s.db.prepare('SELECT spec,neuron_units FROM image_generation_jobs').get();assert.equal(row.neuron_units,5210);assert.ok(!row.spec.includes(image));
});

test('cross-tenant and unknown reference ids are denied before origin calls, quota reservation or inference',async t=>{
 let aiCalls=0,originCalls=0;const s=setup(t,async()=>{aiCalls++;return{image}});owned(s);
 const resolver=(...args)=>resolveGenerationReference(...args,async()=>{originCalls++;});
 for(const [user,id]of [['bob','doc_owned'],['alice','doc_missing']]){
  const r=await handleGeneration(s.env,s.ctx,user,{...submit,documentId:id},resolver);
  assert.equal(r.structuredContent.error.code,'GENERATION_REFERENCE_NOT_FOUND');
 }
 assert.equal(aiCalls,0);assert.equal(originCalls,0);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM image_generation_jobs').get().n,0);
});

test('large MCP text previews use the existing bounded export image block',async t=>{
 const s=setup(t);owned(s);const calls=[];
 const reference=await resolveGenerationReference(s.env,'alice','doc_owned',referenceTransport(calls,'fallback'));
 assert.equal(calls.length,3);assert.equal(calls[2].body.params.name,'artforge_export');
 assert.equal(calls[2].body.params.arguments.previewWidth,511);assert.equal(reference.width,256);assert.equal(reference.height,256);
});

test('malformed or unavailable references never silently use text-only generation',async t=>{
 let inference=0;const s=setup(t,async()=>{inference++;return{image}});owned(s);
 for(const mode of ['unavailable','invalid']){
  const r=await handleGeneration(s.env,s.ctx,'alice',{...submit,documentId:'doc_owned'},(...args)=>resolveGenerationReference(...args,referenceTransport([],mode)));
  assert.equal(r.isError,true);assert.match(r.structuredContent.error.code,/^GENERATION_REFERENCE_/);assert.ok(!JSON.stringify(r).includes('private'));
 }
 assert.equal(inference,0);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM image_generation_jobs').get().n,0);
});

test('reference SHA participates in durable deduplication and different drawings conflict',async t=>{
 let inference=0;const s=setup(t,async()=>{inference++;return{image}});
 let hash='a'.repeat(64);const resolver=async()=>({documentId:'doc_owned',sha256:hash,width:256,height:256,bytes:Buffer.from(image,'base64')});
 const args={...submit,documentId:'doc_owned'};
 const one=await handleGeneration(s.env,s.ctx,'alice',args,resolver);await s.drain();
 const two=await handleGeneration(s.env,s.ctx,'alice',args,resolver);assert.equal(one.structuredContent.jobId,two.structuredContent.jobId);
 hash='b'.repeat(64);const conflict=await handleGeneration(s.env,s.ctx,'alice',args,resolver);
 assert.equal(conflict.structuredContent.error.code,'GENERATION_OPERATION_CONFLICT');assert.equal(inference,1);
});

test('client URLs, paths, raw images, owners and malformed document identifiers are rejected',async t=>{
 const s=setup(t);for(const extra of [{documentId:'../../secret'},{documentId:'https://example.com/x'},{referenceImage:image},{url:'https://example.com/x'},{owner:'alice'}]){
  const r=await handleGeneration(s.env,s.ctx,'alice',{...submit,...extra});assert.equal(r.structuredContent.error.code,'INVALID_GENERATION_REQUEST');
 }assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM image_generation_jobs').get().n,0);
});

test('origin redirects are rejected without forwarding credentials or running inference',async t=>{
 let requests=0,inference=0;const s=setup(t,async()=>{inference++;return{image}});owned(s);
 const resolver=(...args)=>resolveGenerationReference(...args,async(_url,options)=>{
  requests++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://other.example/'}});
 });
 const out=await handleGeneration(s.env,s.ctx,'alice',{...submit,documentId:'doc_owned'},resolver);
 assert.equal(out.structuredContent.error.code,'GENERATION_REFERENCE_UNAVAILABLE');assert.equal(out.structuredContent.error.phase,'info-http');
 assert.equal(out.structuredContent.error.status,302);assert.equal(requests,1);assert.equal(inference,0);
});
