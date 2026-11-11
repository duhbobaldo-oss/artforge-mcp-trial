'use strict';
// Original deterministic procedural treatments. No photographic texture or book
// illustration is fabricated or attributed to these engineering algorithms.
const {assert}=require('./errors');
const {makeCanvas,parseRgba,rng}=require('./effects');
const KINDS=['wood','fabric','stone','paper','wall','metal','glass','leather'];
const DEFAULTS={wood:'#8e613e',fabric:'#5f7490',stone:'#8e9294',paper:'#e8dfc5',wall:'#d5cbb8',metal:'#9da9b0',glass:'#b7d8e1',leather:'#79513c'};
const cache=new Map();
function finite(v,fallback,min,max,label){const n=v===undefined?fallback:Number(v);assert(Number.isFinite(n)&&n>=min&&n<=max,'INVALID_MATERIAL',label+' is out of range');return n;}
function normalizeMaterial(input){
 assert(input&&KINDS.includes(input.kind),'INVALID_MATERIAL','Unknown material class');
 const color=input.color===undefined?DEFAULTS[input.kind]:String(input.color);assert(parseRgba(color),'INVALID_MATERIAL','Material needs a supported RGB/hex color');
 const m={type:'material',kind:input.kind,color,seed:finite(input.seed,7,0,0xffffffff,'seed'),scale:finite(input.scale,32,2,1024,'scale'),angle:finite(input.angle,0,-3600,3600,'angle'),opacity:finite(input.opacity,1,0,1,'opacity'),roughness:finite(input.roughness,0.5,0,1,'roughness'),repeat:input.repeat!==false};
 if(input.repeatX!==undefined)m.repeatX=finite(input.repeatX,1,.01,256,'repeatX');if(input.repeatY!==undefined)m.repeatY=finite(input.repeatY,1,.01,256,'repeatY');
 m.source={kind:'procedural',algorithm:'artforge-material-v1',seed:m.seed,permission:'original-engine-algorithm'};
 if(input.imageId!==undefined){assert(/^mat-img-[a-f0-9]{64}$/.test(input.imageId),'INVALID_MATERIAL','imageId must be a registered content token');m.imageId=input.imageId;m.source={kind:'registered-image',materialId:input.imageId};}
 if(input.mapping){assert(input.mapping.type==='quad'&&Array.isArray(input.mapping.points)&&input.mapping.points.length===4,'INVALID_MATERIAL','mapping needs four normalized quad points');const points=input.mapping.points.map(p=>({x:finite(p.x,undefined,0,1,'mapping.x'),y:finite(p.y,undefined,0,1,'mapping.y')}));const cross=(a,b,c)=>(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);assert(points.every((p,i)=>cross(p,points[(i+1)%4],points[(i+2)%4])>1e-6),'INVALID_MATERIAL','Material quad must be convex and ordered clockwise in screen coordinates');const uv=input.mapping.uv||[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];assert(Array.isArray(uv)&&uv.length===4&&new Set(uv.map(p=>p.x+','+p.y)).size===4&&uv.every((p,i)=>[0,1].includes(p.x)&&[0,1].includes(p.y)&&Math.abs(p.x-uv[(i+1)%4].x)+Math.abs(p.y-uv[(i+1)%4].y)===1),'INVALID_MATERIAL','mapping.uv must trace the four unit-square corners');m.mapping={type:'quad',points,uv:uv.map(p=>({x:p.x,y:p.y}))};}
 return m;
}
function materialPaint(kind,color,seed=7,extra={}){return normalizeMaterial({...extra,type:'material',kind,color:color||DEFAULTS[kind],seed});}
function identifier(m){let h=2166136261;for(const ch of JSON.stringify(normalizeMaterial(m))){h=Math.imul(h^ch.charCodeAt(0),16777619);}return 'mat-'+(h>>>0).toString(16).padStart(8,'0');}
function inverseHomography(points){
 const[a,b,c,d]=points,dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x,dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y;
 const den=dx1*dy2-dx2*dy1;assert(Math.abs(den)>1e-10,'INVALID_MATERIAL','Degenerate texture homography');
 const g=(dx3*dy2-dx2*dy3)/den,h=(dx1*dy3-dx3*dy1)/den;
 const m=[b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h,1];
 const A=m[4]*m[8]-m[5]*m[7],B=m[2]*m[7]-m[1]*m[8],C=m[1]*m[5]-m[2]*m[4],D=m[5]*m[6]-m[3]*m[8],E=m[0]*m[8]-m[2]*m[6],F=m[2]*m[3]-m[0]*m[5],G=m[3]*m[7]-m[4]*m[6],H=m[1]*m[6]-m[0]*m[7],I=m[0]*m[4]-m[1]*m[3],det=m[0]*A+m[1]*D+m[2]*G;
 assert(Math.abs(det)>1e-10,'INVALID_MATERIAL','Singular texture homography');return [A,B,C,D,E,F,G,H,I].map(v=>v/det);
}
function mapInverse(inv,x,y){const den=inv[6]*x+inv[7]*y+inv[8];if(Math.abs(den)<1e-10)return null;const u=(inv[0]*x+inv[1]*y+inv[2])/den,v=(inv[3]*x+inv[4]*y+inv[5])/den;return u>=-1e-7&&u<=1+1e-7&&v>=-1e-7&&v<=1+1e-7?{u:Math.max(0,Math.min(1,u)),v:Math.max(0,Math.min(1,v))}:null;}
function inverseQuad(points,x,y){return mapInverse(inverseHomography(points),x,y);}

function materialRaster(input,width,height,image){
 const m=normalizeMaterial(input);if(m.imageId)assert(image,'MATERIAL_IMAGE_UNAVAILABLE','Registered material image must be resolved before rendering');
 const w=Math.max(1,Math.min(512,Math.ceil(width))),h=Math.max(1,Math.min(512,Math.ceil(height))),key=JSON.stringify([m,w,h]);
 if(cache.has(key)){const entry=cache.get(key);cache.delete(key);cache.set(key,entry);return entry;}
 const canvas=makeCanvas(w,h),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(w,h),base=parseRgba(m.color),random=rng(m.seed);const noise=Float32Array.from({length:128*128},()=>random()*2-1),sample=(x,y)=>noise[((Math.floor(y)%128+128)%128)*128+(Math.floor(x)%128+128)%128];
 let texture;if(m.imageId){const tile=makeCanvas(Math.min(512,image.width),Math.min(512,image.height)),tc=tile.getContext('2d');tc.drawImage(image,0,0,tile.width,tile.height);texture={data:tc.getImageData(0,0,tile.width,tile.height).data,w:tile.width,h:tile.height};}
 const inv=m.mapping?inverseHomography(m.mapping.points):null;
 const angle=m.angle*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const nx=x/Math.max(1,w-1),ny=y/Math.max(1,h-1),uv=m.mapping?mapInverse(inv,nx,ny):{u:nx,v:ny};if(!uv)continue;
  if(m.mapping&&m.mapping.uv){const a=m.mapping.uv,u=uv.u,v=uv.v;uv.u=(1-u)*(1-v)*a[0].x+u*(1-v)*a[1].x+u*v*a[2].x+(1-u)*v*a[3].x;uv.v=(1-u)*(1-v)*a[0].y+u*(1-v)*a[1].y+u*v*a[2].y+(1-u)*v*a[3].y;}
  const tx=uv.u*(m.repeatX===undefined?width/m.scale:m.repeatX)*cos-uv.v*(m.repeatY===undefined?height/m.scale:m.repeatY)*sin,ty=uv.u*(m.repeatX===undefined?width/m.scale:m.repeatX)*sin+uv.v*(m.repeatY===undefined?height/m.scale:m.repeatY)*cos;
  if(!m.repeat&&(tx<0||tx>1||ty<0||ty>1))continue;
  const fine=sample(tx*64,ty*64),coarse=sample(tx*5,ty*5);let shade=0,alpha=base.a;
  switch(m.kind){
   case 'wood':shade=Math.sin(tx*31+Math.sin(ty*2.4)*1.7+coarse*.9)*.10+Math.sin(tx*105+ty*.3)*.025+fine*.025;break;
   case 'fabric':shade=(Math.sin(tx*44)*Math.sin(ty*44))*.09+fine*.025;break;
   case 'stone':shade=coarse*.13+fine*.055+Math.sin(tx*4+Math.sin(ty*3))*.025;break;
   case 'paper':shade=fine*.035+Math.sin(tx*220+ty*130)*.012;break;
   case 'wall':shade=coarse*.025+fine*.018;break;
   case 'metal':shade=Math.sin(uv.u*17)*.16+Math.pow(Math.max(0,Math.cos(uv.u*13-1)),18)*.48+fine*.008;break;
   case 'glass':shade=.15+Math.pow(Math.max(0,Math.cos((uv.u+uv.v*.28)*18)),24)*.5;alpha*=.46;break;
   case 'leather':shade=Math.abs(Math.sin(tx*81+coarse)*Math.sin(ty*91))*-.07+coarse*.08+fine*.025;break;
  }
  let color=base;if(texture){const ix=Math.floor(((tx%1+1)%1)*(texture.w-1)),iy=Math.floor(((ty%1+1)%1)*(texture.h-1)),q=(iy*texture.w+ix)*4;color={r:texture.data[q],g:texture.data[q+1],b:texture.data[q+2],a:texture.data[q+3]/255};alpha=color.a;}
  shade*=.35+m.roughness*.65;const k=(y*w+x)*4;for(const [i,ch]of ['r','g','b'].entries())pixels.data[k+i]=Math.round(Math.max(0,Math.min(255,color[ch]*(1+shade)+(shade>0?255*shade*.18:0))));pixels.data[k+3]=Math.round(alpha*255);
 }
 ctx.putImageData(pixels,0,0);cache.set(key,canvas);if(cache.size>8)cache.delete(cache.keys().next().value);return canvas;
}
function fillMaterial(ctx,material,box,images={}){const m=normalizeMaterial(material);ctx.save();ctx.clip();ctx.globalAlpha*=m.opacity;ctx.drawImage(materialRaster(m,box.w,box.h,m.imageId?images[m.imageId]:undefined),box.x,box.y,box.w,box.h);ctx.restore();}
function materialCatalog(){return KINDS.map(kind=>{const descriptor=materialPaint(kind);return {id:identifier(descriptor),kind,descriptor,provenance:descriptor.source};});}
module.exports={KINDS,DEFAULTS,normalizeMaterial,materialPaint,materialRaster,fillMaterial,materialCatalog,identifier,inverseQuad,inverseHomography,mapInverse};
