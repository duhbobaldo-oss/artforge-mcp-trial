// Public Workers AI adapter. No origin credentials, model downloads, paid fallback or inference retries.
export const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const WIDGET = 'ui://widget/artforge-preview-v1.html';
export const GENERATION_TOOL = {
  name: 'artforge_generate_image', title: 'Generate an image with ArtForge',
  description: 'Integrated neural image generator: FLUX.2 Klein 4B on Cloudflare Workers AI. Submit once with a stable operationId, then poll action=get with jobId until succeeded. Does not wait for Render. Free shared daily quota and 3 submissions per connection per UTC day. Raster output, 256–512px. No automatic retries, no image uploads or editable document import in this public path. Results expire after 24 hours.',
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['submit','get','cancel','delete','status'] },
    operationId: { type: 'string' }, prompt: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, seed: { type: 'integer' }, jobId: { type: 'string' } }, required: ['action'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: { ui: { resourceUri: WIDGET }, 'openai/outputTemplate': WIDGET, 'openai/toolInvocation/invoking': 'Generating with FLUX.2 Klein…', 'openai/toolInvocation/invoked': 'ArtForge image task updated' },
};
export const generationCapabilities = () => ({ enabled: true, model: MODEL, provider: 'Cloudflare Workers AI', kind: 'integrated-hosted-generator',
  maxWidth: 512, maxHeight: 512, userDailySubmissions: 3, sharedDailyEstimatedNeurons: 900, resultsTtlHours: 24, editableVector: false });
const fail = code => Object.assign(new Error(code), { code });
function input(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_GENERATION_REQUEST');
  const fields = args.action === 'submit' ? ['action','operationId','prompt','width','height','seed'] : args.action === 'status' ? ['action'] : ['action','jobId'];
  if (Object.keys(args).some(k => !fields.includes(k))) throw fail('INVALID_GENERATION_REQUEST');
  if (args.action !== 'submit') return args;
  const s = { operationId: args.operationId, prompt: args.prompt, width: args.width ?? 512, height: args.height ?? 512, seed: args.seed ?? 7 };
  if (typeof s.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(s.operationId) || typeof s.prompt !== 'string' || !s.prompt.trim() || s.prompt.length > 3000
    || ![s.width,s.height].every(n => Number.isInteger(n) && n>=256 && n<=512 && n%16===0)
    || !Number.isInteger(s.seed) || s.seed<0 || s.seed>0xffffffff) throw fail('INVALID_GENERATION_REQUEST');
  return s;
}
async function fingerprint(spec) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(spec)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
}
function view(row) { return { jobId: row.id, state: row.state, model: MODEL, provider: 'Cloudflare Workers AI', width: JSON.parse(row.spec).width,
  height: JSON.parse(row.spec).height, seed: JSON.parse(row.spec).seed, createdAt: row.created_at, error: row.error || null, pollAfterMs: row.state==='running' ? 2000 : null }; }
function result(row) {
  const data = view(row), images = row.state==='succeeded' && row.image ? [{ type:'image', mimeType:row.mime, data:row.image }] : [];
  return { content:[{type:'text',text:JSON.stringify(data)},...images], structuredContent:data,
    ...(images.length ? {_meta:{artforge:{previewDataUrl:`data:${row.mime};base64,${row.image}`}}} : {}), isError:row.state==='failed' };
}
function imageInfo(base64, spec) {
  if (typeof base64!=='string' || base64.length>1_300_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fail('INVALID_GENERATION_IMAGE');
  let bytes; try { bytes=atob(base64); } catch { throw fail('INVALID_GENERATION_IMAGE'); }
  const u=i=>bytes.charCodeAt(i), be16=i=>u(i)*256+u(i+1), be32=i=>(u(i)*0x1000000+u(i+1)*65536+u(i+2)*256+u(i+3));
  if (bytes.slice(0,8)==='\x89PNG\r\n\x1a\n' && bytes.slice(12,16)==='IHDR' && be32(16)===spec.width && be32(20)===spec.height) return 'image/png';
  if (u(0)!==255 || u(1)!==216) throw fail('INVALID_GENERATION_IMAGE');
  let i=2;
  while(i+4<=bytes.length){if(u(i++)!==255)break;while(u(i)===255)i++;const marker=u(i++);if(marker===218||marker===217)break;
    if(marker===1||marker>=208&&marker<=215)continue;const length=be16(i);if(length<2||i+length>bytes.length)break;
    if([192,193,194].includes(marker)){if(length>=8&&be16(i+3)===spec.height&&be16(i+5)===spec.width)return 'image/jpeg';break;}i+=length;}
  throw fail('INVALID_GENERATION_IMAGE');
}
async function generate(env, id, spec) {
  try {
    const form=new FormData();for(const key of ['prompt','width','height','seed'])form.append(key,String(spec[key]));
    const response=new Response(form);
    const output=await env.AI.run(MODEL,{multipart:{body:response.body,contentType:response.headers.get('content-type')}});
    const mime=imageInfo(output?.image,spec);
    // A cancelled request can never reappear as succeeded. Reservations are retained even on errors.
    await env.DB.prepare("UPDATE image_generation_jobs SET state='succeeded',image=?,mime=?,updated_at=? WHERE id=? AND state='running'").bind(output.image,mime,Date.now(),id).run();
  } catch {
    await env.DB.prepare("UPDATE image_generation_jobs SET state='failed',error='GENERATION_PROVIDER_ERROR',updated_at=? WHERE id=? AND state='running'").bind(Date.now(),id).run();
  }
}
export async function handleGeneration(env, ctx, owner, raw) {
  try {
    if(!owner)throw fail('GENERATION_AUTH_REQUIRED');
    if(env.IMAGE_GENERATION_ENABLED!=='1'||!env.AI)throw fail('GENERATION_DISABLED');
    const args=input(raw), now=Date.now();
    await env.DB.prepare("UPDATE image_generation_jobs SET image=NULL,state='expired',error='GENERATION_EXPIRED',updated_at=? WHERE image IS NOT NULL AND created_at<?").bind(now,now-86400000).run();
    if(raw.action==='status')return {content:[{type:'text',text:JSON.stringify(generationCapabilities())}],structuredContent:generationCapabilities()};
    let row;
    if(raw.action==='submit'){
      const hash=await fingerprint({...args,model:MODEL});
      row=await env.DB.prepare('SELECT * FROM image_generation_jobs WHERE user_id=? AND operation_id=?').bind(owner,args.operationId).first();
      if(row&&row.fingerprint!==hash)throw fail('GENERATION_OPERATION_CONFLICT');
      if(!row){
        const id='ig_'+crypto.randomUUID().replaceAll('-',''),day=new Date(now).toISOString().slice(0,10);
        try {await env.DB.prepare("INSERT INTO image_generation_jobs(id,user_id,operation_id,fingerprint,day,neuron_units,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,2605,'running',?,?,?)").bind(id,owner,args.operationId,hash,day,JSON.stringify(args),now,now).run();}
        catch(e){row=await env.DB.prepare('SELECT * FROM image_generation_jobs WHERE user_id=? AND operation_id=?').bind(owner,args.operationId).first();
          if(!row){const message=String(e.message||'');throw fail(message.includes('GENERATION_USER_QUOTA')?'GENERATION_USER_QUOTA':message.includes('GENERATION_DAILY_QUOTA')?'GENERATION_DAILY_QUOTA':'GENERATION_STORE_ERROR');}
          if(row.fingerprint!==hash)throw fail('GENERATION_OPERATION_CONFLICT');}
        if(!row){row=await env.DB.prepare('SELECT * FROM image_generation_jobs WHERE id=?').bind(id).first();ctx.waitUntil(generate(env,id,args));}
      }
    }else{
      if(typeof args.jobId!=='string'||!/^ig_[a-f0-9]{32}$/.test(args.jobId))throw fail('INVALID_GENERATION_REQUEST');
      row=await env.DB.prepare('SELECT * FROM image_generation_jobs WHERE id=? AND user_id=?').bind(args.jobId,owner).first();
      if(!row)throw fail('GENERATION_NOT_FOUND');
      if(raw.action==='cancel'||raw.action==='delete'){
        const state=raw.action==='delete'?'deleted':'cancelled';
        if(raw.action==='delete'||row.state==='running')await env.DB.prepare('UPDATE image_generation_jobs SET state=?,image=NULL,error=?,updated_at=? WHERE id=? AND user_id=?').bind(state,'GENERATION_'+state.toUpperCase(),now,row.id,owner).run();
        row=await env.DB.prepare('SELECT * FROM image_generation_jobs WHERE id=? AND user_id=?').bind(row.id,owner).first();
      }else if(raw.action!=='get')throw fail('INVALID_GENERATION_REQUEST');
    }
    if(row.state==='running'&&now-row.updated_at>120000){await env.DB.prepare("UPDATE image_generation_jobs SET state='failed',error='GENERATION_INTERRUPTED',updated_at=? WHERE id=? AND state='running'").bind(now,row.id).run();row={...row,state:'failed',error:'GENERATION_INTERRUPTED'};}
    return result(row);
  }catch(e){const code=/^(INVALID_GENERATION_REQUEST|GENERATION_[A-Z_]+)$/.test(e.code||'')?e.code:'GENERATION_UNAVAILABLE';
    return {content:[{type:'text',text:code}],structuredContent:{error:{code}},isError:true};}
}
