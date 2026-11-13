'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMcpEngine}=require('../src');const {McpServer}=require('../src/mcp');const {GenerativeImageAdapter}=require('../src/engine/generative-image-adapter');
const {createCanvas}=require('../../drawing-tool/node_modules/@napi-rs/canvas');
function setup(t,options){const root=fs.mkdtempSync(path.join(os.tmpdir(),'artforge-generation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const engine=createMcpEngine({dataDir:root,logDir:root+'/logs',autoStart:false,generativeImages:options});return {engine,server:new McpServer(engine)}}
const request={prompt:'local mock only',width:1,height:1,operationId:'test_1'};
const call=(server,params)=>server.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'artforge_tool_op',arguments:{op:'generation.generate',params}}});
test('MCP generation is disabled by default and cannot be enabled by caller arguments',async t=>{
 let calls=0;const {server,engine}=setup(t,{provider:{id:'local-mock',generate:async()=>{calls++}}});
 const r=await call(server,{...request,enabled:true});assert.equal(r.result.isError,true);assert.equal(r.result.structuredContent.error.code,'GENERATION_DISABLED');assert.equal(calls,0);assert.equal(engine.generativeImages.status().enabled,false);
});
test('local mock integrates through MCP, decodes PNG and coalesces duplicate operations',async t=>{
 let calls=0;const png=createCanvas(1,1).toBuffer('image/png');const {server}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {mimeType:'image/png',bytes:png}}}});
 const results=await Promise.all([call(server,request),call(server,request)]);assert.equal(calls,1);for(const r of results){assert.equal(r.result.isError,false);assert.equal(r.result.structuredContent.source.provider,'local-mock');assert.equal(r.result.content.find(c=>c.type==='image').data,png.toString('base64'));}
 const conflict=await call(server,{...request,prompt:'different'});assert.equal(conflict.result.structuredContent.error.code,'GENERATION_OPERATION_CONFLICT');assert.equal(calls,1);
});
test('provider failures are redacted and never automatically retried',async t=>{
 let calls=0;const {server}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>{calls++;throw Error('secret-provider-debug')}}});const r=await call(server,request);assert.equal(r.result.structuredContent.error.code,'GENERATION_PROVIDER_ERROR');assert.ok(!JSON.stringify(r).includes('secret-provider-debug'));await call(server,request);assert.equal(calls,1);
});
test('invalid input and malformed or mismatched PNGs are rejected before delivery',async t=>{
 for(const bytes of [Buffer.from('not an image'),createCanvas(2,2).toBuffer('image/png'),Buffer.concat([createCanvas(1,1).toBuffer('image/png').subarray(0,33),Buffer.alloc(1)])]){
 const {server}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>({mimeType:'image/png',bytes})}});const r=await call(server,request);assert.equal(r.result.structuredContent.error.code,'INVALID_GENERATION_IMAGE');assert.ok(!r.result.content.some(c=>c.type==='image'));}
 const {engine}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>{throw Error('must not run')}}});await assert.rejects(engine.generativeImages.generate({...request,width:Infinity}),{code:'INVALID_GENERATION_REQUEST'});
});
test('timeout and cancellation reach provider without retries',async()=>{
 let signal;const adapter=new GenerativeImageAdapter({enabled:true,timeoutMs:10,validatePng:async()=>{},provider:{id:'local-mock',generate:async(input,ctx)=>{signal=ctx.signal;return new Promise(()=>{})}}});await assert.rejects(adapter.generate(request),{code:'GENERATION_TIMEOUT'});assert.equal(signal.aborted,true);
 const controller=new AbortController();const pending=adapter.generate({...request,operationId:'cancel'},{signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'GENERATION_CANCELLED'});
});
test('large locally generated PNG gets a bounded preview through the MCP boundary',async t=>{
 const canvas=createCanvas(512,512),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(512,512);let seed=7;for(let i=0;i<pixels.data.length;i++){seed=(1664525*seed+1013904223)>>>0;pixels.data[i]=i%4===3?255:seed>>>24;}ctx.putImageData(pixels,0,0);const png=canvas.toBuffer('image/png');assert.ok(png.length>225000);
 const {server}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>({mimeType:'image/png',bytes:png})}});const r=await call(server,{...request,width:512,height:512});assert.equal(r.result.isError,false);const image=r.result.content.find(c=>c.type==='image');assert.ok(image.data.length<=300000);assert.ok(r.result.structuredContent.preview.width<=512);assert.ok(['image/jpeg','image/png'].includes(r.result.structuredContent.preview.mimeType));assert.ok(r.result.structuredContent.exported&&r.result.structuredContent.exported.width===512);assert.equal(r.result.structuredContent.sha256,require('node:crypto').createHash('sha256').update(png).digest('hex'));
});
test('engine instances isolate provider receipts and unconfigured adapters reject generation',async t=>{
 let calls=0;const provider={id:'local-mock',generate:async()=>{calls++;return {mimeType:'image/png',bytes:createCanvas(1,1).toBuffer('image/png')}}};const a=setup(t,{enabled:true,provider}),b=setup(t,{enabled:true,provider});await call(a.server,request);await call(b.server,request);assert.equal(calls,2);const disabled=setup(t,{enabled:true});await assert.rejects(disabled.engine.generativeImages.generate(request),{code:'GENERATION_UNCONFIGURED'});
});
test('a consumer cannot mutate the cached receipt or its image identity',async t=>{
 const {engine}=setup(t,{enabled:true,provider:{id:'local-mock',generate:async()=>({mimeType:'image/png',bytes:createCanvas(1,1).toBuffer('image/png')})}});const first=await engine.generativeImages.generate(request);first.bytes.fill(0);first.source.provider='changed';const again=await engine.generativeImages.generate(request);assert.equal(again.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(again.source.provider,'local-mock');
});
