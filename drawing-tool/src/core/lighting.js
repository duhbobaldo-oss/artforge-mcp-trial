'use strict';
const {assert}=require('./errors');
const {parseRgba}=require('./effects');
function number(v,fallback,min,max,label){const n=v===undefined?fallback:Number(v);assert(Number.isFinite(n)&&n>=min&&n<=max,'INVALID_LIGHT',label+' is out of range');return n;}
function ids(input,label,max){if(input===undefined)return undefined;assert(Array.isArray(input)&&input.length<=max&&input.every(v=>typeof v==='string'&&v.length>0&&v.length<=128),'INVALID_LIGHT',label+' must contain bounded identifiers');return [...new Set(input)];}
function normalizeLights(input,label='lights'){
 if(input===undefined||input===null)return [];
 assert(Array.isArray(input)&&input.length<=16,'INVALID_LIGHT',label+' must have at most16 lights');
 return input.map((l,i)=>{
  assert(l&&['ambient','directional','radial'].includes(l.type),'INVALID_LIGHT',label+'['+i+'].type invalid');
  const color=l.color===undefined?'#fff0d8':String(l.color);assert(parseRgba(color),'INVALID_LIGHT','Light color must be RGB/hex');
  const blend=l.blend||'screen';assert(['screen','multiply'].includes(blend),'INVALID_LIGHT','Light blend must be screen or multiply');
  const out={type:l.type,color,blend,strength:number(l.strength,.35,0,1,'strength'),x:number(l.x,0,-100000,100000,'x'),y:number(l.y,0,-100000,100000,'y'),radius:number(l.radius,300,1,16384,'radius'),angle:number(l.angle,225,-3600,3600,'angle'),softness:number(l.softness,.6,0,1,'softness')};
  const scope=l.scope||{};out.scope={excludeText:scope.excludeText!==false};const objectIds=ids(scope.objectIds,'scope.objectIds',80),layerIds=ids(scope.layerIds,'scope.layerIds',20);if(objectIds)out.scope.objectIds=objectIds;if(layerIds)out.scope.layerIds=layerIds;
  if(l.mask){const m=l.mask;assert(['rect','ellipse'].includes(m.type),'INVALID_LIGHT','Light mask must be rect or ellipse');out.mask={type:m.type,x:number(m.x,0,-100000,100000,'mask.x'),y:number(m.y,0,-100000,100000,'mask.y'),w:number(m.w,undefined,.01,100000,'mask.w'),h:number(m.h,undefined,.01,100000,'mask.h'),feather:number(m.feather,0,0,4096,'mask.feather')};}
  return out;
 });
}
function matchingLights(input,context={}){const object=context.object||{};return normalizeLights(input).filter(l=>!(l.scope.excludeText&&object.type==='text')&&(!l.scope.objectIds||l.scope.objectIds.includes(object.id))&&(!l.scope.layerIds||l.scope.layerIds.includes(context.layerId)));}
function maskWeight(mask,x,y){if(!mask)return 1;let distance;if(mask.type==='ellipse'){const nx=(x-mask.x-mask.w/2)/(mask.w/2),ny=(y-mask.y-mask.h/2)/(mask.h/2);distance=(1-Math.hypot(nx,ny))*Math.min(mask.w,mask.h)/2;}else distance=Math.min(x-mask.x,mask.x+mask.w-x,y-mask.y,mask.y+mask.h-y);return mask.feather?Math.max(0,Math.min(1,distance/mask.feather)):(distance>=0?1:0);}
function lightWeight(light,x,y,W,H){
 let weight=1;
 if(light.type==='radial'){const q=Math.max(0,1-Math.hypot(x-light.x,y-light.y)/light.radius);weight=q*q*(3-2*q);if(light.softness<.1)weight=q>0?1:0;}
 if(light.type==='directional'){const a=light.angle*Math.PI/180,dx=Math.cos(a),dy=Math.sin(a),span=Math.abs(dx)*W+Math.abs(dy)*H;weight=Math.max(0,Math.min(1,.5+((x-W/2)*dx+(y-H/2)*dy)/Math.max(1,span)));}
 return weight*maskWeight(light.mask,x,y)*light.strength;
}
function applyLighting(ctx,input,W,H,options={}){
 const lights=normalizeLights(input);if(!lights.length)return;
 const w=ctx.canvas.width,h=ctx.canvas.height,pixels=ctx.getImageData(0,0,w,h),d=pixels.data,origin=options.origin||{x:0,y:0},t=options.transform||{a:1,b:0,c:0,d:1,e:0,f:0};
 const parsed=lights.map(l=>({light:l,color:parseRgba(l.color)}));
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const k=(y*w+x)*4;if(!d[k+3])continue;const lx=x+origin.x,ly=y+origin.y,gx=t.a*lx+t.c*ly+t.e,gy=t.b*lx+t.d*ly+t.f;for(const {light,color}of parsed){const amount=lightWeight(light,gx,gy,W,H)*color.a;if(!amount)continue;for(const[ch,key]of ['r','g','b'].entries()){const v=d[k+ch]/255,c=color[key]/255,mixed=light.blend==='multiply'?v*c:1-(1-v)*(1-c);d[k+ch]=Math.round(255*(v+(mixed-v)*amount));}}}
 ctx.putImageData(pixels,0,0);
}
function effectManifest(input){return normalizeLights(input).map((light,index)=>({index,type:light.type,scope:light.scope,mask:light.mask||null,strength:light.strength,blend:light.blend,representation:'per-object-raster-lighting',reason:'masked pixel compositing preserves alpha and excludes text by default'}));}
module.exports={normalizeLights,matchingLights,applyLighting,effectManifest,lightWeight,maskWeight};
