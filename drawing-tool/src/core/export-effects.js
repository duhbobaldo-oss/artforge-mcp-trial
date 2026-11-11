'use strict';
const {createCanvas}=require('@napi-rs/canvas');
const {render}=require('./renderer');
const {encodePng}=require('./png');
// Encode the finishing operation, not a screenshot replacement of the scene.
// Opaque pixels use the smallest source-over delta alpha; transparent pixels
// needing replacement are explicitly masked out underneath and listed separately.
function finishingOverlay(doc,images){const W=doc.canvas.width,H=doc.canvas.height;if(W*H>4000000)throw Object.assign(new Error('Effect export exceeds the4MP bounded finishing budget'),{code:'EFFECT_EXPORT_TOO_LARGE'});const base=createCanvas(W,H),final=createCanvas(W,H);render(base.getContext('2d'),doc,{images,applyAnimation:false,effects:false});render(final.getContext('2d'),doc,{images,applyAnimation:false});const a=base.getContext('2d').getImageData(0,0,W,H).data,b=final.getContext('2d').getImageData(0,0,W,H).data,overlay=createCanvas(W,H),ctx=overlay.getContext('2d'),data=ctx.createImageData(W,H),mask=createCanvas(W,H),mc=mask.getContext('2d'),md=mc.createImageData(W,H);let replaced=0,changed=0;
for(let i=0;i<a.length;i+=4){md.data[i]=md.data[i+1]=md.data[i+2]=255;md.data[i+3]=255;if(a[i]===b[i]&&a[i+1]===b[i+1]&&a[i+2]===b[i+2]&&a[i+3]===b[i+3])continue;changed++;if(a[i+3]!==255||b[i+3]!==255){for(let k=0;k<4;k++)data.data[i+k]=b[i+k];md.data[i]=md.data[i+1]=md.data[i+2]=0;replaced++;continue;}let alpha=0;for(let k=0;k<3;k++){const d=b[i+k]-a[i+k];alpha=Math.max(alpha,d>=0?d/(255-a[i+k]||1):-d/(a[i+k]||1));}alpha=Math.max(1/255,Math.ceil(alpha*255)/255);for(let k=0;k<3;k++)data.data[i+k]=Math.max(0,Math.min(255,Math.round((b[i+k]-(1-alpha)*a[i+k])/alpha)));data.data[i+3]=Math.round(alpha*255);}
ctx.putImageData(data,0,0);mc.putImageData(md,0,0);return {png:encodePng(overlay),mask:replaced?encodePng(mask):null,changedPixels:changed,replacedAlphaPixels:replaced};}
module.exports={finishingOverlay};
