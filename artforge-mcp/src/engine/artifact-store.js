'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MIME={svg:'image/svg+xml',pdf:'application/pdf',bundle:'application/zip',psd:'image/vnd.adobe.photoshop',png:'image/png',jpeg:'image/jpeg',webp:'image/webp'};
function fail(code,message){throw Object.assign(new Error(message),{code});}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
class ArtifactStore {
 constructor(options){this.dir=path.resolve(options.dir);this.roots=options.allowedRoots.map(r=>path.resolve(r));this.maxBytes=options.maxBytes||8*1024*1024;this.maxCount=options.maxCount||64;this.ttlMs=options.ttlMs||7*86400000;fs.mkdirSync(this.dir,{recursive:true});}
 parse(id){const v=String(id||'').replace(/^artforge:\/\/artifact\//,'');if(!/^af_[a-f0-9]{32}$/.test(v))fail('INVALID_ARTIFACT_ID','Invalid artifact identifier');return v;}
 locked(fn){
  const lock=path.join(this.dir,'.lock'),token=process.pid+'_'+crypto.randomBytes(8).toString('hex'),owner=path.join(lock,token),deadline=Date.now()+3000;
  while(true){try{fs.mkdirSync(lock);fs.writeFileSync(owner,'',{flag:'wx'});break;}catch(e){
   if(e.code!=='EEXIST')throw e;
   try{for(const name of fs.readdirSync(lock)){if(!/^\d+_[a-f0-9]{16}$/.test(name))continue;const pid=Number(name.split('_')[0]);let dead=false;try{process.kill(pid,0);}catch(err){dead=err.code==='ESRCH';}if(dead)try{fs.unlinkSync(path.join(lock,name));}catch(err){if(err.code!=='ENOENT')throw err;}}
    // Only remove an empty aged acquisition gap. A new owner's unique token can
    // never be removed by a contender that observed an earlier dead process.
    if(fs.readdirSync(lock).length===0&&Date.now()-fs.statSync(lock).mtimeMs>30000)fs.rmdirSync(lock);
   }catch(err){if(!['ENOENT','ENOTEMPTY'].includes(err.code))throw err;}
   if(Date.now()>=deadline)fail('ARTIFACT_BUSY','Artifact store busy; retry operation');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }}try{return fn();}finally{fs.unlinkSync(owner);fs.rmdirSync(lock);}
 }

 rows(){const out=[];for(const name of fs.readdirSync(this.dir)){if(!/^af_[a-f0-9]{32}\.json$/.test(name))continue;let a;try{a=JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'));}catch(e){if(e.code==='ENOENT')continue;fail('ARTIFACT_CORRUPT','Artifact metadata invalid');}if(a.id+'.json'!==name||!MIME[a.format]||a.mimeType!==MIME[a.format]||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>this.maxBytes||!Number.isFinite(a.expiresAt)||!Number.isFinite(a.createdAt)||!/^[a-f0-9]{64}$/.test(a.sha256))fail('ARTIFACT_CORRUPT','Artifact metadata invalid');out.push(a);}return out;}
 erase(id){for(const ext of ['.json','.bin'])try{fs.unlinkSync(path.join(this.dir,id+ext));}catch(e){if(e.code!=='ENOENT')throw e;}}
 register(file,format,documentId){if(!MIME[format])fail('INVALID_ARTIFACT_FORMAT','Unsupported artifact type');const resolved=fs.realpathSync(file);if(!this.roots.some(root=>{const r=path.relative(root,resolved);return r&&!r.startsWith('..')&&!path.isAbsolute(r);}))fail('ARTIFACT_PATH_DENIED','Export is outside configured export roots');const stat=fs.statSync(resolved);if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)fail('ARTIFACT_TOO_LARGE','Artifact exceeds bounded resource size');const bytes=fs.readFileSync(resolved);if(format==='pdf'&&bytes.subarray(0,5).toString()!=='%PDF-'||format==='svg'&&!/<svg(?:\s|\/?>)/.test(bytes.toString('utf8'))||format==='bundle'&&(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)||format==='psd'&&bytes.subarray(0,4).toString('latin1')!=='8BPS')fail('INVALID_ARTIFACT','Invalid exported bytes');return this.locked(()=>{const rows=this.rows();for(const a of rows)if(a.expiresAt<=Date.now())this.erase(a.id);const live=rows.filter(a=>a.expiresAt>Date.now());if(live.length>=this.maxCount)fail('ARTIFACT_QUOTA','Artifact count limit reached; delete unused receipts before exporting');const id='af_'+crypto.randomBytes(16).toString('hex'),a={id,uri:'artforge://artifact/'+id,format,mimeType:MIME[format],bytes:bytes.length,sha256:sha(bytes),documentId:String(documentId),createdAt:Date.now(),expiresAt:Date.now()+this.ttlMs};const blob=path.join(this.dir,id+'.bin'),meta=path.join(this.dir,id+'.json');try{fs.writeFileSync(blob,bytes,{flag:'wx'});fs.writeFileSync(meta+'.tmp',JSON.stringify(a),{flag:'wx'});fs.renameSync(meta+'.tmp',meta);}catch(e){this.erase(id);try{fs.unlinkSync(meta+'.tmp');}catch{}throw e;}return {...a};});}
 list(){return this.locked(()=>{const rows=this.rows();for(const a of rows)if(a.expiresAt<=Date.now())this.erase(a.id);return rows.filter(a=>a.expiresAt>Date.now()).map(a=>({...a}));});}
 get(id){id=this.parse(id);return this.locked(()=>{const a=this.rows().find(r=>r.id===id);if(!a||a.expiresAt<=Date.now()){if(a)this.erase(id);fail('ARTIFACT_NOT_FOUND','Artifact removed, expired or unknown');}let bytes;try{bytes=fs.readFileSync(path.join(this.dir,id+'.bin'));}catch{fail('ARTIFACT_CORRUPT','Artifact bytes unavailable');}if(bytes.length!==a.bytes||sha(bytes)!==a.sha256)fail('ARTIFACT_CORRUPT','Artifact integrity check failed');return {record:{...a},bytes};});}
 remove(id){id=this.parse(id);return this.locked(()=>{if(!this.rows().some(a=>a.id===id))fail('ARTIFACT_NOT_FOUND','Artifact unknown');this.erase(id);return {removed:id};});}
}
module.exports={ArtifactStore};
