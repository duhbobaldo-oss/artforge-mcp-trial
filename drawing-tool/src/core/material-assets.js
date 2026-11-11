'use strict';
// Rights/classification adapter over the EXISTING AssetStore. Image bytes have
// one authoritative owner; this registry never invents a source or a licence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {assert}=require('./errors');
const {KINDS}=require('./material');
const ID=/^mat-img-[a-f0-9]{64}$/;
const PERMISSIONS=['owned','user-provided','licensed','public-domain'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
class MaterialAssets {
 constructor(ctx){this.ctx=ctx;this.file=path.join(ctx.assetsDir,'material-index.json');this.records=this._load();}
 _load(){if(!fs.existsSync(this.file))return {};const parsed=JSON.parse(fs.readFileSync(this.file,'utf8'));assert(parsed&&parsed.schema==='artforge.material-assets.v1'&&parsed.records&&typeof parsed.records==='object','INVALID_MATERIAL_INDEX','Material index schema invalid');return parsed.records;}
 _write(records){const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({schema:'artforge.material-assets.v1',records},null,2));fs.renameSync(temp,this.file);this.records=records;}
 _record(id){assert(ID.test(String(id)),'INVALID_MATERIAL_ID','Unknown or unsafe material ID');this.records=this._load();const r=this.records[id];assert(r,'MATERIAL_NOT_FOUND','Material is not registered');return r;}
 _assetBytes(record){const asset=this.ctx.assets.get(record.assetId);assert(/^[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/.test(asset.file),'INVALID_MATERIAL_ASSET','Unsafe image asset filename');const file=path.join(this.ctx.assetsDir,asset.file);assert(fs.existsSync(file),'MATERIAL_ASSET_MISSING','Material source asset is missing');const buffer=fs.readFileSync(file);assert(buffer.length>0&&buffer.length<=8*1024*1024,'INVALID_MATERIAL_ASSET','Material image must be1byte..8MiB');assert(digest(buffer)===record.sha256&&asset.sha256===record.sha256,'MATERIAL_HASH_MISMATCH','Material source content changed');return {asset,buffer};}
 async register(input){
  assert(input&&typeof input.assetId==='string'&&KINDS.includes(input.kind),'INVALID_MATERIAL','Existing image asset and material class required');
  assert(PERMISSIONS.includes(input.permission)&&typeof input.sourceUri==='string'&&input.sourceUri.trim().length>0&&input.sourceUri.length<=1000,'MATERIAL_PERMISSION_REQUIRED','Explicit sourceUri and use permission required');
  const asset=this.ctx.assets.get(input.assetId),sha256=asset.sha256;assert(/^[a-f0-9]{64}$/.test(sha256),'INVALID_MATERIAL_ASSET','Asset SHA256 missing');const id='mat-img-'+sha256;
  const record={id,assetId:asset.id,kind:input.kind,name:String(input.name||asset.name||id).slice(0,160),sha256,active:true,source:{kind:'image',sourceUri:input.sourceUri.trim(),permission:input.permission,declaredBy:'caller'},createdAt:new Date().toISOString()};
  const {buffer}=this._assetBytes(record);const inspect=await this.ctx.assets.inspect(asset.id);assert(inspect.width<=4096&&inspect.height<=4096&&inspect.width*inspect.height<=16000000,'MATERIAL_RESOURCE_LIMIT','Material image exceeds4096px/16MP');
  if(this.records[id]){assert(this.records[id].active,'MATERIAL_REVOKED','Revoked material requires explicit restore');return this.metadata(id);}
  record.bytes=buffer.length;record.width=inspect.width;record.height=inspect.height;record.mime=/\.png$/i.test(asset.file)?'image/png':/\.webp$/i.test(asset.file)?'image/webp':'image/jpeg';const next={...this._load(),[id]:record};this._write(next);return this.metadata(id);
 }
 metadata(id){const r=this._record(id);this._assetBytes(r);return JSON.parse(JSON.stringify(r));}
 read(id){const r=this._record(id);assert(r.active,'MATERIAL_REVOKED','Material use permission was revoked');return {...r,...this._assetBytes(r)};}
 search(query=''){this.records=this._load();const q=String(query).toLowerCase();return Object.values(this.records).filter(r=>r.active&&[r.id,r.name,r.kind,r.source.sourceUri].some(v=>v.toLowerCase().includes(q))).map(r=>this.metadata(r.id));}
 bindings(id){this._record(id);const found=[];for(const doc of this.ctx.store.documents.values())for(const layer of doc.layers)for(const object of layer.objects)if(object.fill&&object.fill.imageId===id)found.push({documentId:doc.id,layerId:layer.id,objectId:object.id});return found;}
 revoke(id){const r=this._record(id);this._write({...this.records,[id]:{...r,active:false,revokedAt:new Date().toISOString()}});return {id,active:false};}
 restore(id,input){const r=this._record(id);assert(input&&PERMISSIONS.includes(input.permission)&&typeof input.sourceUri==='string'&&input.sourceUri.trim(),'MATERIAL_PERMISSION_REQUIRED','Restore requires new explicit permission/source');this._assetBytes(r);const next={...r,active:true,source:{kind:'image',sourceUri:input.sourceUri.trim(),permission:input.permission,declaredBy:'caller'}};delete next.revokedAt;this._write({...this.records,[id]:next});return this.metadata(id);}
 remove(id){this._record(id);assert(this.bindings(id).length===0,'MATERIAL_IN_USE','Remove material bindings from documents before deleting the registration');const next={...this.records};delete next[id];this._write(next);return {id,removed:true,sourceAssetPreserved:true};}
 assertAssetRemovable(assetId){for(const r of Object.values(this._load()))if(r.assetId===assetId)assert(this.bindings(r.id).length===0,'MATERIAL_IN_USE','Image asset is bound through a material');}
 onAssetRemoved(assetId){const next={...this._load()};for(const r of Object.values(next))if(r.assetId===assetId)delete next[r.id];this._write(next);}
 async resolveImages(doc){const out={};for(const layer of doc.layers)for(const object of layer.objects){const id=object.fill&&object.fill.imageId;if(!id||out[id])continue;const record=this.read(id);out[id]=await this.ctx.assets.load(record.assetId);}return out;}
 exportRecords(doc){const ids=new Set(doc.layers.flatMap(l=>l.objects.map(o=>o.fill&&o.fill.imageId).filter(Boolean)));return [...ids].map(id=>this.metadata(id));}
 importRecords(records,assetMap={}){assert(Array.isArray(records)&&records.length<=100,'INVALID_MATERIAL_INDEX','Bundle material metadata invalid');const next={...this._load()};for(const r of records){assert(r&&ID.test(r.id)&&KINDS.includes(r.kind)&&r.active&&r.source&&PERMISSIONS.includes(r.source.permission)&&r.id==='mat-img-'+r.sha256,'INVALID_MATERIAL_INDEX','Bundle material record is invalid');const mapped={...r,assetId:assetMap[r.assetId]||r.assetId};this._assetBytes(mapped);next[r.id]=mapped;}this._write(next);return records.length;}
}
function getMaterialAssets(ctx){if(!ctx.materialAssets)ctx.materialAssets=new MaterialAssets(ctx);return ctx.materialAssets;}
module.exports={MaterialAssets,getMaterialAssets,PERMISSIONS};
