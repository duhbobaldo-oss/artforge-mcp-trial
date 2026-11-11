'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const canvas = require('../../drawing-tool/node_modules/@napi-rs/canvas');
const { documentReference } = require('../src/engine/generation-reference');
const { GenerativeImageAdapter } = require('../src/engine/generative-image-adapter');
const { validatePng } = require('../src/engine/png-contract');
const { createMcpEngine } = require('../src');
const { McpServer } = require('../src/mcp');
const { CloudflareImageProvider } = require('../src/engine/cloudflare-image-provider');
const png = (w, h = w) => canvas.createCanvas(w,h).toBuffer('image/png');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const request = { operationId:'cartoon', prompt:'Make the actual drawing a 3D cartoon', width:256, height:256, documentId:'doc_test' };

test('landscape, portrait and square document references are actual validated renderer snapshots below 512px', async () => {
  for (const [w,h] of [[1200,1000],[500,2000],[512,512],[100,80]]) {
    const calls=[];
    const bridge={call:async(op,p)=>{calls.push({op,p});if(op==='document.info')return {data:{document:{canvas:{width:w,height:h}}}};
      const width=p.maxWidth,height=Math.round(h*width/w);return {data:{width,height,base64:png(width,height).toString('base64')}};}};
    const r=await documentReference(bridge,'doc_test');
    assert.ok(r.width<512&&r.height<512);assert.equal(r.sha256,hash(r.bytes));validatePng(r.bytes,r);
    assert.equal(calls[1].p.static,true);assert.equal(calls[0].p.documentId,'doc_test');
  }
});

test('references never accept paths, URLs, traversal or invalid/missing documents', async () => {
  let calls=0;const bridge={call:async()=>{calls++;throw Error('secret filesystem path');}};
  for(const id of ['../../secret','https://example.com/image.png','C:\\secret.png','doc_../x',null])
    await assert.rejects(documentReference(bridge,id),{code:'INVALID_GENERATION_REFERENCE'});
  assert.equal(calls,0);
  await assert.rejects(documentReference(bridge,'doc_missing'),e=>e.code==='GENERATION_REFERENCE_UNAVAILABLE'&&!e.message.includes('secret'));
});

test('malformed PNG and oversized renderer output are rejected before native/provider use', async()=>{
  for(const data of [{width:512,height:511,base64:png(512,511).toString('base64')},
    {width:10,height:10,base64:Buffer.from('not png').toString('base64')},
    {width:10,height:10,base64:png(9,10).toString('base64')}]){
    const bridge={call:async op=>({data:op==='document.info'?{document:{canvas:{width:100,height:100}}}:data})};
    await assert.rejects(documentReference(bridge,'doc_test'),{code:'INVALID_GENERATION_REFERENCE'});
  }
});

test('MCP reference travels through owner adapter into Cloudflare multipart with an exact byte hash',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'artforge-ref-'));
  const reference=png(300,250),output=png(256);let providerCalls=0,posted;
  const provider=new CloudflareImageProvider({accountId:'a'.repeat(32),freePlanConfirmed:true,canvasModule:canvas,budgetDir:dir,
    credentials:async()=>({token:'test-only-placeholder'}),fetch:async(url,options)=>{providerCalls++;posted=options.body;return Response.json({image:output.toString('base64')});}});
  t.after(()=>{provider.close();fs.rmSync(dir,{recursive:true,force:true});});
  const engine=createMcpEngine({dataDir:path.join(dir,'data'),logDir:path.join(dir,'logs'),autoStart:false,
    generativeImages:{enabled:true,provider:{id:provider.id,supportsReferenceImage:true,generate:(input,ctx)=>provider.generate(
      {version:1,operationId:ctx.operationId,prompt:input.prompt,width:input.width,height:input.height,seed:7},
      {...ctx,jobId:ctx.operationId,referenceImage:input.referenceImage})}}});
  engine.bridge.call=async(op,p)=>{
    assert.equal(p.documentId,'doc_test');
    if(op==='document.info')return {data:{document:{canvas:{width:300,height:250}}}};
    assert.equal(op,'document.preview');return {data:{width:300,height:250,base64:reference.toString('base64')}};
  };
  const server=new McpServer(engine);
  const call=params=>server.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'artforge_tool_op',arguments:{op:'generation.generate',params}}});
  const r=await call(request);assert.equal(r.result.isError,false);
  const source=r.result.structuredContent.source;assert.equal(source.mode,'image-to-image');assert.equal(source.referenceDocumentId,'doc_test');
  assert.equal(source.referenceSha256,hash(reference));assert.equal(posted.get('input_image_0').type,'image/png');
  assert.deepEqual(Buffer.from(await posted.get('input_image_0').arrayBuffer()),reference);
  assert.equal(posted.get('prompt'),request.prompt);assert.equal(providerCalls,1);
  const repeat=await call(request);assert.equal(repeat.result.isError,false);assert.equal(providerCalls,1);
});

test('changed drawing under the same operation id conflicts instead of repeating inference',async()=>{
  let calls=0;let ref=png(10);const adapter=new GenerativeImageAdapter({enabled:true,validatePng,
    resolveReference:async()=>({documentId:'doc_test',bytes:ref,mimeType:'image/png',width:10,height:10,sha256:hash(ref)}),
    provider:{id:'mock',supportsReferenceImage:true,generate:async()=>{calls++;return{mimeType:'image/png',bytes:png(256)};}}});
  await adapter.generate(request);ref=png(11);
  await assert.rejects(adapter.generate(request),{code:'GENERATION_OPERATION_CONFLICT'});assert.equal(calls,1);
});

test('unsupported providers and missing documents cannot silently become text-to-image',async()=>{
  let calls=0;const provider={id:'mock',generate:async()=>{calls++;}};
  const adapter=new GenerativeImageAdapter({enabled:true,validatePng,provider});
  await assert.rejects(adapter.generate(request),{code:'GENERATION_REFERENCE_UNSUPPORTED'});
  const enabled=new GenerativeImageAdapter({enabled:true,validatePng,provider:{...provider,supportsReferenceImage:true},
    resolveReference:async()=>{throw Object.assign(Error('GENERATION_REFERENCE_UNAVAILABLE'),{code:'GENERATION_REFERENCE_UNAVAILABLE'});}});
  await assert.rejects(enabled.generate(request),{code:'GENERATION_REFERENCE_UNAVAILABLE'});assert.equal(calls,0);
});

test('invalid direct provider references fail before credentials, budget or network access',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'artforge-ref-denied-'));let calls=0;
  const provider=new CloudflareImageProvider({accountId:'a'.repeat(32),freePlanConfirmed:true,canvasModule:canvas,budgetDir:dir,
    credentials:async()=>{calls++;},fetch:async()=>{calls++;}});
  t.after(()=>{provider.close();fs.rmSync(dir,{recursive:true,force:true});});
  const spec={version:1,operationId:'bad',prompt:'test',width:256,height:256,seed:7};
  await assert.rejects(provider.generate(spec,{referenceImage:{mimeType:'image/png',width:512,height:512,bytes:png(512)}}),{code:'INVALID_GENERATION_REFERENCE'});
  assert.equal(calls,0);assert.equal(provider.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
});

test('real drawing -> PNG reference -> provider -> restart keeps the original document unchanged',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'artforge-render-reference-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {createEngine}=require('../../drawing-tool/src');
  const draw=createEngine({root});
  const made=await draw.run('document.create',{name:'Reference integration',width:1200,height:1000,background:'#f1d9b3'});
  const documentId=made.data.documentId;
  await draw.run('draw.rect',{documentId,x:200,y:200,w:800,h:600,fill:'#345678',radius:80});
  const saved=await draw.run('document.save',{documentId});
  const file=saved.data.path;const original=fs.readFileSync(file);
  const before=await documentReference({call:(op,p)=>draw.run(op,p)},documentId);
  let captured;
  const adapter=new GenerativeImageAdapter({enabled:true,validatePng,
    resolveReference:id=>documentReference({call:(op,p)=>draw.run(op,p)},id),
    provider:{id:'mock',supportsReferenceImage:true,generate:async input=>{captured=input.referenceImage;return{mimeType:'image/png',bytes:png(256)};}}});
  const result=await adapter.generate({...request,documentId});
  assert.equal(result.source.referenceSha256,hash(captured.bytes));assert.equal(captured.width,511);assert.equal(captured.height,426);
  assert.deepEqual(fs.readFileSync(file),original);
  const restarted=createEngine({root});
  const after=await documentReference({call:(op,p)=>restarted.run(op,p)},documentId);
  assert.equal(after.sha256,before.sha256);
  await restarted.run('document.delete',{documentId});
  await assert.rejects(documentReference({call:(op,p)=>restarted.run(op,p)},documentId),{code:'GENERATION_REFERENCE_UNAVAILABLE'});
});
