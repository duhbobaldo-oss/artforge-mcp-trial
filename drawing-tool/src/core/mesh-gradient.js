'use strict';
const { makeCanvas: createCanvas } = require('./effects');
const { assert } = require('./errors');
const rasterCache=new Map(); // At most four 512x512 RGBA surfaces (4 MiB), shared across renders.
// A bounded deformable bilinear mesh. Node coordinates and colours are retained
// in the document; rasterisation is a paint implementation, not a flattened scene.
function normalizeMesh(input) {
  const rows = Number(input.rows), cols = Number(input.cols);
  assert(Number.isInteger(rows) && rows >= 2 && rows <= 16 && Number.isInteger(cols) && cols >= 2 && cols <= 16, 'INVALID_MESH', 'mesh rows/cols must be integers 2..16');
  assert(Array.isArray(input.nodes) && input.nodes.length === rows * cols, 'INVALID_MESH', 'one node is required per grid position');
  const nodes = input.nodes.map((v) => {
    assert(v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1 && /^#[a-f\d]{6}$/i.test(v.color), 'INVALID_MESH', 'mesh nodes require normalized x/y and #rrggbb');
    return { x: v.x, y: v.y, color: v.color };
  });
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(let y=0;y<rows-1;y++) for(let x=0;x<cols-1;x++) {
    const a=nodes[y*cols+x],b=nodes[y*cols+x+1],c=nodes[(y+1)*cols+x+1],d=nodes[(y+1)*cols+x];
    assert(cross(a,b,c)>1e-6 && cross(b,c,d)>1e-6 && cross(c,d,a)>1e-6 && cross(d,a,b)>1e-6, 'INVALID_MESH', 'mesh cells must not fold or collapse');
  }
  return { type:'mesh',rows,cols,nodes };
}
function meshCanvas(paint, width, height) {
  const m=normalizeMesh(paint);
  const w=Math.max(2,Math.min(512,Math.ceil(width))),h=Math.max(2,Math.min(512,Math.ceil(height)));
  const canvas=createCanvas(w,h),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(w,h);
  const rgb=n=>[1,3,5].map(i=>parseInt(n.color.slice(i,i+2),16));
  for(let row=0;row<m.rows-1;row++) for(let col=0;col<m.cols-1;col++) {
    const ids=[row*m.cols+col,row*m.cols+col+1,(row+1)*m.cols+col+1,(row+1)*m.cols+col];
    const [a,b,c,d]=ids.map(i=>m.nodes[i]),colors=[a,b,c,d].map(rgb);
    const minX=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x,d.x)*(w-1))),maxX=Math.min(w-1,Math.ceil(Math.max(a.x,b.x,c.x,d.x)*(w-1)));
    const minY=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y,d.y)*(h-1))),maxY=Math.min(h-1,Math.ceil(Math.max(a.y,b.y,c.y,d.y)*(h-1)));
    for(let y=minY;y<=maxY;y++) for(let x=minX;x<=maxX;x++) {
      const px=x/(w-1),py=y/(h-1);let u=0.5,v=0.5;
      // Invert the bilinear deformation with bounded Newton iterations.
      for(let it=0;it<10;it++){
        const fx=(1-u)*(1-v)*a.x+u*(1-v)*b.x+u*v*c.x+(1-u)*v*d.x-px;
        const fy=(1-u)*(1-v)*a.y+u*(1-v)*b.y+u*v*c.y+(1-u)*v*d.y-py;
        const xu=(1-v)*(b.x-a.x)+v*(c.x-d.x),xv=(1-u)*(d.x-a.x)+u*(c.x-b.x);
        const yu=(1-v)*(b.y-a.y)+v*(c.y-d.y),yv=(1-u)*(d.y-a.y)+u*(c.y-b.y),det=xu*yv-xv*yu;
        if(Math.abs(det)<1e-10)break;
        const du=(fx*yv-fy*xv)/det,dv=(fy*xu-fx*yu)/det;u-=du;v-=dv;if(Math.abs(du)+Math.abs(dv)<1e-8)break;
      }
      if(u< -1e-6||u>1+1e-6||v< -1e-6||v>1+1e-6)continue;
      const weights=[(1-u)*(1-v),u*(1-v),u*v,(1-u)*v],k=(y*w+x)*4;
      for(let ch=0;ch<3;ch++)pixels.data[k+ch]=Math.round(weights.reduce((sum,t,i)=>sum+t*colors[i][ch],0));
      pixels.data[k+3]=255;
    }
  }

  ctx.putImageData(pixels,0,0);return canvas;
}
function cachedMesh(mesh,box) {
  const w=Math.max(2,Math.min(512,Math.ceil(box.w))),h=Math.max(2,Math.min(512,Math.ceil(box.h))),key=JSON.stringify([w,h,mesh]);
  let canvas=rasterCache.get(key);if(canvas){rasterCache.delete(key);rasterCache.set(key,canvas);return canvas;}
  canvas=meshCanvas(mesh,w,h);rasterCache.set(key,canvas);if(rasterCache.size>4)rasterCache.delete(rasterCache.keys().next().value);return canvas;
}
function meshPaint(ctx,mesh,box) {
  // Text/stroke paints and subpixel shapes use the explicit linear fallback.
  const gradient=ctx.createLinearGradient(box.x,box.y,box.x+Math.max(1,box.w),box.y+Math.max(1,box.h));gradient.addColorStop(0,mesh.nodes[0].color);gradient.addColorStop(1,mesh.nodes.at(-1).color);return gradient;
}
function fillMesh(ctx,mesh,box) {
  if(box.w<=2||box.h<=2){ctx.fillStyle=meshPaint(ctx,mesh,box);ctx.fill();return;}
  ctx.save();ctx.clip();ctx.drawImage(cachedMesh(mesh,box),box.x,box.y,box.w,box.h);ctx.restore();
}
module.exports={normalizeMesh,meshCanvas,meshPaint,fillMesh};
