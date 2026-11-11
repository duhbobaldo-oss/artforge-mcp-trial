'use strict';
// Pinhole camera; world Y points up, screen Y down. Finite near clipping is
// deliberate: never publish infinities when geometry crosses the camera plane.
function camera(options={}) {
  const width=options.width===undefined?1200:Number(options.width),height=options.height===undefined?900:Number(options.height);
  const eye=options.cameraHeight===undefined?1.6:Number(options.cameraHeight);
  const yaw=options.yaw===undefined?Math.PI/4:Number(options.yaw),pitch=options.pitch===undefined?0.22:Number(options.pitch);
  const focal=options.focal===undefined?width*0.9:Number(options.focal);
  if(![width,height,eye,yaw,pitch,focal].every(Number.isFinite)||width<=0||height<=0||focal<=0||eye<=0||eye>100||Math.abs(pitch)>1.3)throw new Error('Invalid camera');
  const rotate=p=>{const x=Math.cos(yaw)*p.x-Math.sin(yaw)*p.z,z=Math.sin(yaw)*p.x+Math.cos(yaw)*p.z;return {x,y:Math.cos(pitch)*p.y-Math.sin(pitch)*z,z:Math.sin(pitch)*p.y+Math.cos(pitch)*z};};
  const project=p=>{const q=rotate({x:p.x,y:p.y-eye,z:p.z});if(q.z<=0.05)return null;return {x:width/2+focal*q.x/q.z,y:height/2-focal*q.y/q.z,depth:q.z};};
  const vanishing=[{x:1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:1,z:0}].map(axis=>{const q=rotate(axis);return Math.abs(q.z)<1e-8?null:{x:width/2+focal*q.x/q.z,y:height/2-focal*q.y/q.z};});
  const unprojectGround=(x,y)=>{
    const rx=(x-width/2)/focal,ry=-(y-height/2)/focal;
    const uy=Math.cos(pitch)*ry+Math.sin(pitch),uz=-Math.sin(pitch)*ry+Math.cos(pitch);
    if(uy>=-1e-6)return null;const t=-eye/uy;
    return {x:(Math.cos(yaw)*rx+Math.sin(yaw)*uz)*t,y:0,z:(-Math.sin(yaw)*rx+Math.cos(yaw)*uz)*t};
  };
  return {project,unprojectGround,vanishing,eye,width,height,yaw,pitch,focal,horizonY:height/2+focal*Math.tan(pitch)};
}
function boxFaces(cam,origin,size){const [w,h,d]=size;const points=[[0,0,0],[w,0,0],[w,h,0],[0,h,0],[0,0,d],[w,0,d],[w,h,d],[0,h,d]].map(([x,y,z])=>cam.project({x:x+origin.x,y:y+origin.y,z:z+origin.z}));if(points.some(p=>!p))return [];return [[0,1,2,3],[1,5,6,2],[3,2,6,7]].map(ids=>ids.map(i=>points[i]));}
// Clip projected floor lines to the viewport before publishing drawing params.
function clipLine([a,b],width,height){let lo=0,hi=1;const dx=b.x-a.x,dy=b.y-a.y;for(const [p,q]of [[-dx,a.x],[dx,width-a.x],[-dy,a.y],[dy,height-a.y]]){if(Math.abs(p)<1e-12){if(q<0)return null;}else{const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return null;}}return [{x:a.x+lo*dx,y:a.y+lo*dy},{x:a.x+hi*dx,y:a.y+hi*dy}];}
function floorGrid(cam,size=8){const lines=[];for(let i=-size;i<=size;i++){for(const pair of [[{x:i,y:0,z:2},{x:i,y:0,z:size+8}],[{x:-size,y:0,z:i+size+2},{x:size,y:0,z:i+size+2}]]){const p=pair.map(cam.project);if(p.every(Boolean)){const clipped=clipLine(p,cam.width,cam.height);if(clipped)lines.push(clipped);}}}return lines;}
module.exports={camera,boxFaces,floorGrid};
