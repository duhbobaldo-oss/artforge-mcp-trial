'use strict';
// Repairs Chromium's compatibility-glyph Unicode maps, without changing any glyph,
// font, paint operator or placement. Limited to the classic-xref PDF we generate.
const zlib = require('node:zlib');
function fromHex(hex) {
  if (!hex.length || hex.length % 4) throw new Error('Invalid UTF-16 CMap destination');
  const b=Buffer.from(hex,'hex'); b.swap16(); return b.toString('utf16le');
}
function toHex(text) { const b=Buffer.from(text,'utf16le'); b.swap16(); return b.toString('hex').toUpperCase(); }
function normalizeCMap(source, diagnostics = {}) {
  const maps=new Map(); let changed=false;
  const add=(cid,hex)=>{const old=fromHex(hex);const compatible=/[\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(old);const normalized=compatible?old.normalize('NFKC'):old;const text=[...normalized].length===1?normalized:old;if(compatible&&text===old&&normalized!==old)diagnostics.atomicLigatures=(diagnostics.atomicLigatures||0)+1;changed ||= text!==old; maps.set(cid,toHex(text));if(maps.size>65536)throw new Error('CMap limit');};
  for(const section of source.matchAll(/\d+\s+beginbfchar([\s\S]*?)endbfchar/g)) {
    const lines=section[1].trim().split(/\r?\n/).filter(Boolean);
    for(const line of lines){const m=line.trim().match(/^<([\da-f]+)>\s*<([\da-f]+)>$/i);if(!m)throw new Error('Unsupported CMap bfchar');add(parseInt(m[1],16),m[2]);}
  }
  for(const section of source.matchAll(/\d+\s+beginbfrange([\s\S]*?)endbfrange/g)) {
    for(const line of section[1].trim().split(/\r?\n/).filter(Boolean)) {
      const m=line.trim().match(/^<([\da-f]+)>\s*<([\da-f]+)>\s*(<([\da-f]+)>|\[([^\]]*)\])$/i);if(!m)throw new Error('Unsupported CMap bfrange');
      const start=parseInt(m[1],16),end=parseInt(m[2],16);if(end<start||end-start>65535)throw new Error('CMap range limit');
      const values=m[5]?[...m[5].matchAll(/<([\da-f]+)>/gi)].map(x=>x[1]):null;
      if(values&&values.length!==end-start+1)throw new Error('Invalid CMap range array');
      for(let cid=start;cid<=end;cid++){const hex=values?values[cid-start]:(BigInt('0x'+m[4])+BigInt(cid-start)).toString(16).padStart(m[4].length,'0');add(cid,hex);}
    }
  }
  if(!changed)return null;
  const entries=[...maps].map(([cid,hex])=>`<${cid.toString(16).padStart(4,'0').toUpperCase()}> <${hex}>`);
  const blocks=[];for(let i=0;i<entries.length;i+=100){const chunk=entries.slice(i,i+100);blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);}
  let inserted=false;
  return source.replace(/\d+\s+beginbf(?:char|range)[\s\S]*?endbf(?:char|range)/g,()=>{if(inserted)return '';inserted=true;return blocks.join('\n');});
}
function flattenGlyphTags(source) {
  // These exact zero-paint wrappers are emitted by Skia. Keep structural MCIDs and
  // all other marked content. Only wrappers whose CMap equivalent is now canonical
  // are removed; the visible text operators remain byte-for-byte unchanged.
  const tokens=/\/Span\s*<<\s*\/ActualText\s*<[\da-f]+>\s*>>\s*BDC|\/ReversedChars\s+BMC|\b(?:BDC|BMC|EMC)\b/gi;
  const stack=[]; const cuts=[]; let match;
  while((match=tokens.exec(source))){
    const token=match[0];
    if(token==='EMC'){if(!stack.length)throw new Error('Unbalanced PDF marked content');const remove=stack.pop();if(remove)cuts.push([match.index,tokens.lastIndex]);}
    else {const actual=token.match(/ActualText\s*<([\da-f]+)>/i);const semantic=actual?fromHex(actual[1]).replace(/^\uFEFF/,''):'';const remove=(actual&&/^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+$/u.test(semantic))||token.startsWith('/ReversedChars');stack.push(remove);if(remove)cuts.push([match.index,tokens.lastIndex]);}
  }
  if(stack.length)throw new Error('Unbalanced PDF marked content');
  for(const [a,b] of cuts.reverse())source=source.slice(0,a)+source.slice(b);
  return source;
}
function repairPdfText(buffer) {
  if(!Buffer.isBuffer(buffer)||buffer.length>64*1024*1024)throw new Error('PDF text repair input limit');
  const source=buffer.toString('latin1');
  const end=source.match(/startxref\s+(\d+)\s+%%EOF\s*$/);if(!end)throw new Error('Missing PDF xref');
  const xref=Number(end[1]);const table=source.slice(xref).match(/^xref\s+0\s+(\d+)\s+([\s\S]*?)trailer\s*(<<[\s\S]*?>>)\s*startxref/);
  if(!table)throw new Error('Unsupported generated PDF xref');
  const count=Number(table[1]);if(count>100000)throw new Error('PDF object limit');
  const rows=table[2].trim().split(/\r?\n/);if(rows.length!==count)throw new Error('Invalid PDF xref rows');
  const objects=new Map();
  for(let id=1;id<count;id++){
    const row=rows[id].match(/^(\d{10})\s+(\d{5})\s+([nf])/);if(!row)throw new Error('Invalid PDF xref row');if(row[3]==='f')continue;
    const offset=Number(row[1]);const head=source.slice(offset).match(new RegExp(`^${id} ${Number(row[2])} obj\\s*`));if(!head)throw new Error('Invalid PDF object offset');
    const begin=offset+head[0].length;const next=source.indexOf('\nendobj',begin);if(next<0)throw new Error('Unterminated PDF object');
    objects.set(id,{id,generation:Number(row[2]),body:source.slice(begin,next)});
  }
  const streamOf=obj=>{
    const m=obj.body.match(/^(<<[\s\S]*?>>)\s*stream\r?\n/);if(!m)return null;
    const length=m[1].match(/\/Length\s+(\d+)\s*(?=[/>])/);if(!length)throw new Error('Unsupported stream length');
    const raw=Buffer.from(obj.body.slice(m[0].length,m[0].length+Number(length[1])),'latin1');
    const flate=/\/Filter\s*\/FlateDecode/.test(m[1]);if(/\/Filter/.test(m[1])&&!flate)return null;
    if(/\/DecodeParms\b/.test(m[1]))throw new Error('Unsupported generated PDF stream parameters');
    return {dict:m[1],data:(flate?zlib.inflateSync(raw,{maxOutputLength:8*1024*1024}):raw).toString('latin1')};
  };
  const updated=new Map();let maps=0,contents=0;const diagnostics={atomicLigatures:0};
  const replaceStream=(obj,text,dict)=>{
    const data=zlib.deflateSync(Buffer.from(text,'latin1'));
    // Form content carries Resources, BBox, Matrix and transparency Group entries.
    // Preserve that dictionary; replacing it with a bare stream dictionary would
    // change clipping/transforms or make nested fonts/XObjects disappear.
    dict=dict.replace(/\/Length\s+\d+\b/,`/Length ${data.length}`);
    if(!/\/Filter\b/.test(dict))dict=dict.replace(/>>\s*$/,'/Filter /FlateDecode >>');
    updated.set(obj.id,Buffer.concat([Buffer.from(`${dict} stream\n`,'latin1'),data,Buffer.from('\nendstream')]));
  };
  const cmapIds=new Set();for(const obj of objects.values()){const dict=obj.body.split(/\bstream\b/,1)[0];for(const m of dict.matchAll(/\/ToUnicode\s+(\d+)\s+0\s+R/g))cmapIds.add(Number(m[1]));}
  for(const id of cmapIds){const obj=objects.get(id);if(!obj)throw new Error('Missing CMap');const stream=streamOf(obj);if(!stream)throw new Error('Unsupported CMap stream');const repaired=normalizeCMap(stream.data,diagnostics);if(repaired){replaceStream(obj,repaired,stream.dict);maps++;}}
  // A layer opacity/filter/finishing pass can put real text in nested Form
  // XObjects rather than the page's Contents stream. Follow only Form resources,
  // never image/font/program streams. This is a bounded generated-PDF graph walk.
  const dictionary=obj=>obj.body.split(/\bstream\b/,1)[0];
  const forms=new Set([...objects.values()].filter(obj=>/\/Subtype\s*\/Form\b/.test(dictionary(obj))).map(obj=>obj.id));
  const resourceForms=(obj,seen=new Set(),depth=0)=>{
    if(depth>8)throw new Error('PDF resource nesting limit');
    if(seen.has(obj.id))return new Set();seen.add(obj.id);
    const dict=dictionary(obj), found=new Set();
    for(const m of dict.matchAll(/(\d+)\s+0\s+R/g)){const id=Number(m[1]);if(forms.has(id))found.add(id);}
    for(const m of dict.matchAll(/\/(?:Resources|XObject)\s+(\d+)\s+0\s+R/g)){
      const child=objects.get(Number(m[1]));if(!child)throw new Error('Missing PDF resources');
      for(const id of resourceForms(child,seen,depth+1))found.add(id);
    }
    return found;
  };
  const contentIds=new Set(),visiting=new Set(),visited=new Set();
  const visitForm=(id,depth)=>{
    if(depth>32||visited.size>10000)throw new Error('PDF Form nesting limit');
    if(visiting.has(id))throw new Error('Cyclic PDF Form resources');
    if(visited.has(id))return;
    visiting.add(id);contentIds.add(id);
    for(const child of resourceForms(objects.get(id)))visitForm(child,depth+1);
    visiting.delete(id);visited.add(id);
  };
  for(const obj of objects.values()){
    const dict=dictionary(obj);if(!/\/Type\s*\/Page\b/.test(dict))continue;
    const refs=dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/);
    if(refs)for(const m of refs[1].matchAll(/(\d+)\s+0\s+R/g))contentIds.add(Number(m[1]));
    for(const id of resourceForms(obj))visitForm(id,1);
  }
  for(const id of contentIds){const obj=objects.get(id);if(!obj)throw new Error('Missing content stream');const stream=streamOf(obj);if(!stream)throw new Error('Unsupported content stream');const repaired=flattenGlyphTags(stream.data);if(repaired!==stream.data){replaceStream(obj,repaired,stream.dict);contents++;}}
  if(!updated.size)return {buffer,normalizedMaps:0,flattenedStreams:0,atomicLigatures:diagnostics.atomicLigatures};
  const chunks=[buffer,Buffer.from('\n')];let offset=buffer.length+1;const offsets=[];
  for(const [id,body] of [...updated].sort((a,b)=>a[0]-b[0])){const chunk=Buffer.concat([Buffer.from(`${id} ${objects.get(id).generation} obj\n`),body,Buffer.from('\nendobj\n')]);offsets.push([id,offset]);chunks.push(chunk);offset+=chunk.length;}
  let tail='xref\n';for(const [id,pos]of offsets)tail+=`${id} 1\n${String(pos).padStart(10,'0')} ${String(objects.get(id).generation).padStart(5,'0')} n \n`;
  const trailer=table[3].replace(/>>\s*$/,`/Prev ${xref} >>`);tail+=`trailer\n${trailer}\nstartxref\n${offset}\n%%EOF\n`;chunks.push(Buffer.from(tail));
  return {buffer:Buffer.concat(chunks),normalizedMaps:maps,flattenedStreams:contents,atomicLigatures:diagnostics.atomicLigatures};
}
module.exports={repairPdfText,normalizeCMap,flattenGlyphTags};

