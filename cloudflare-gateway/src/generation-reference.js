// Reuse the deployed renderer's existing authenticated MCP read/export operations.
// No new renderer endpoint or client-selected URL/file is needed.
const fail = (code,phase,status) => Object.assign(new Error(code), { code,phase,status });
const dataOf = reply => {
  if(reply?.result?.structuredContent)return reply.result.structuredContent;
  try{return JSON.parse(reply.result.content.find(c=>c.type==='text').text);}catch{return null;}
};
export async function resolveGenerationReference(env, owner, documentId, transport = (...args)=>fetch(...args)) {
  if (typeof documentId !== 'string' || !/^doc_[A-Za-z0-9]{1,96}$/.test(documentId)) throw fail('INVALID_GENERATION_REQUEST');
  const mine = await env.DB.prepare("SELECT user_id FROM ownership WHERE kind='doc' AND id=?").bind(documentId).first('user_id');
  if (!owner || mine !== owner) throw fail('GENERATION_REFERENCE_NOT_FOUND');
  const deadline=Date.now()+Math.min(110000,Math.max(1000,Number(env.ENGINE_TIMEOUT_MS)||110000));
  async function call(name,args){
    const stage=name==='artforge_export'?'export':args.op==='document.info'?'info':'preview';let phase=stage+'-transport';
    try{
      const response=await transport(`${env.ORIGIN_URL}/mcp`,{method:'POST',
        // Workers does not implement redirect:"error". Manual + !ok rejects every
        // redirect without forwarding the origin credential to another host.
        headers:{Authorization:`Bearer ${env.ORIGIN_TOKEN}`,'Content-Type':'application/json'},redirect:'manual',
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),
        signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      if(!response.ok||!response.body)throw fail('GENERATION_REFERENCE_UNAVAILABLE',stage+'-http',response.status);
      const chunks=[];let length=0;
      const reader=response.body.getReader();
      try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;
        if(length>1_600_000){await reader.cancel();throw fail('GENERATION_REFERENCE_INVALID');}chunks.push(value);}}
      finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      phase=stage+'-decode';return JSON.parse(new TextDecoder().decode(bytes));
    }catch(e){if(e.phase)throw e;throw fail('GENERATION_REFERENCE_UNAVAILABLE',phase);}
  }
  const info=await call('artforge_tool_op',{op:'document.info',params:{documentId}});
  const canvas=dataOf(info)?.result?.document?.canvas;
  if(info.error||info.result?.isError||!canvas||![canvas.width,canvas.height].every(n=>Number.isInteger(n)&&n>0&&n<=1600))throw fail('GENERATION_REFERENCE_UNAVAILABLE','info-model');
  const maxWidth=Math.max(1,Math.min(canvas.width,511,Math.floor(511*canvas.width/canvas.height)));
  let preview=await call('artforge_tool_op',{op:'document.preview',params:{documentId,maxWidth,static:true}});
  let base64=dataOf(preview)?.result?.base64;
  // Large inline text previews can exceed MCP's text limit. Its normal export tool
  // carries the same renderer output as a bounded image block instead.
  if(typeof base64!=='string'){
    if(maxWidth<120)throw fail('GENERATION_REFERENCE_UNAVAILABLE');
    preview=await call('artforge_export',{documentId,format:'png',preview:true,previewWidth:maxWidth,static:true,scale:1});
    base64=preview.result?.content?.find(c=>c.type==='image'&&c.mimeType==='image/png')?.data;
  }
  if(preview.error||preview.result?.isError||typeof base64!=='string'||base64.length>1_500_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw fail('GENERATION_REFERENCE_INVALID');
  const raw=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  if(raw.length<33||[137,80,78,71,13,10,26,10].some((n,i)=>raw[i]!==n)
    || new TextDecoder().decode(raw.slice(12,16))!=='IHDR')throw fail('GENERATION_REFERENCE_INVALID');
  const view=new DataView(raw.buffer),width=view.getUint32(16),height=view.getUint32(20);
  if(![width,height].every(n=>n>0&&n<512))throw fail('GENERATION_REFERENCE_INVALID');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
  return {documentId,width,height,sha256:hash,bytes:raw};
}
