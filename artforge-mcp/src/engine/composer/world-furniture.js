'use strict';
const {camera}=require('./perspective');
const {heldBookBox}=require('./pose-layout');
// Physical dimensions are explicit engineering scene defaults in metres. They
// are shared across motifs; each object is not independently stretched to fit.
const DIMENSIONS={bed:[1.8,1.25,2.25],armchair:[.78,1.15,.78],diningTable:[1.8,.78,1.05],desk:[1.4,.78,.75],coffeeTable:[1.1,.45,.65],building:[1.8,3.3,1.6],tower:[1.3,4.8,1.3],house:[2.0,2.2,1.8]};
function cameraForArt(art,canvas){const p=art.perspective||{},type=p.type||'two-point';return camera({width:canvas.width,height:canvas.height,cameraHeight:p.cameraHeight,cameraYaw:p.cameraYaw,yaw:p.cameraYaw??(type==='one-point'?0:Math.PI/4),pitch:p.cameraPitch??(type==='three-point'?.22:0),focal:p.cameraFocal});}
function localPoint(origin,p,rotation=0){const c=Math.cos(rotation),s=Math.sin(rotation);return {x:origin.x+p.x*c-p.z*s,y:origin.y+p.y,z:origin.z+p.x*s+p.z*c};}
function cuboid(origin,size,rotation,part,material){return {origin,size,rotation,part,material};}
function components(motif,world){
 const [w,h,d]=world.size,o=world.origin,r=world.rotation||0,out=[];
 const add=(x,y,z,a,b,c,part,material)=>out.push(cuboid(localPoint(o,{x,y,z},r),[a,b,c],r,part,material));
 const leg=(x,z,height)=>add(x,0,z,.07,height,.07,'leg','wood');
 if(['diningTable','desk','coffeeTable'].includes(motif)){
  add(-w/2,h-.09,-d/2,w,.09,d,'tabletop','wood');for(const x of [-w/2+.04,w/2-.11])for(const z of [-d/2+.04,d/2-.11])leg(x,z,h-.09);
  if(motif==='desk')add(-w/2+.08,h*.55,-d/2+.07,w*.32,h*.25,d*.85,'drawer','wood');
 }else if(motif==='armchair'){
  const seat=.48;for(const x of [-w/2+.04,w/2-.11])for(const z of [-d/2+.04,d/2-.11])leg(x,z,seat);
  add(-w/2,seat,-d/2,w,.14,d,'seat','fabric');add(-w/2,seat+.14,d/2-.12,w,h-seat-.14,.12,'backrest','fabric');
  for(const x of [-w/2,w/2-.1])add(x,seat+.17,-d/2+.03,.10,.17,d*.9,'armrest','fabric');
 }else if(motif==='bed'){
  for(const x of [-w/2+.06,w/2-.13])for(const z of [-d/2+.06,d/2-.13])leg(x,z,.24);
  add(-w/2,.24,-d/2,w,.16,d,'bed frame','wood');add(-w/2+.03,.4,-d/2+.02,w-.06,.23,d-.04,'mattress','fabric');
  add(-w/2,0,d/2-.1,w,h,.1,'headboard','wood');
  for(const x of [-w*.43,w*.07])add(x,.63,d*.24,w*.36,.12,d*.19,'pillow','fabric');
  add(-w/2+.04,.635,-d/2+.03,w-.08,.045,d*.68,'blanket','fabric');
 }else{
  add(-w/2,0,-d/2,w,h,d,'facade',motif==='tower'?'glass':'stone');
  if(motif==='house')add(-w*.52,h,-d*.52,w*1.04,.15,d*1.04,'roof','stone');
 }
 return out;
}
function geometryFor(motif,world,cam){const faces=[];for(const box of components(motif,world)){
 const [w,h,d]=box.size,vertices=[[0,0,0],[w,0,0],[w,h,0],[0,h,0],[0,0,d],[w,0,d],[w,h,d],[0,h,d]].map(([x,y,z])=>localPoint(box.origin,{x,y,z},box.rotation));
 const defs=[[[0,1,2,3],{x:0,y:0,z:-1}],[[1,5,6,2],{x:1,y:0,z:0}],[[5,4,7,6],{x:0,y:0,z:1}],[[4,0,3,7],{x:-1,y:0,z:0}],[[3,2,6,7],{x:0,y:1,z:0}],[[4,5,1,0],{x:0,y:-1,z:0}]];
 for(const [ids,normal]of defs){const center=ids.reduce((p,i)=>({x:p.x+vertices[i].x/4,y:p.y+vertices[i].y/4,z:p.z+vertices[i].z/4}),{x:0,y:0,z:0}),n=localPoint({x:0,y:0,z:0},normal,box.rotation);
  if(n.x*(-center.x)+n.y*(cam.eye-center.y)+n.z*(-center.z)<=1e-8)continue;
  const points=ids.map(i=>cam.project(vertices[i]));if(points.some(p=>!p))continue;
  const edge=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  faces.push({part:box.part,material:box.material,points,uv:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],edgeX:edge(vertices[ids[0]],vertices[ids[1]]),edgeY:edge(vertices[ids[1]],vertices[ids[2]]),normal:n,depth:points.reduce((sum,p)=>sum+p.depth/4,0)});
 }
 }return faces.sort((a,b)=>b.depth-a.depth);}
function footprint(world){const [w,,d]=world.size,c=Math.abs(Math.cos(world.rotation||0)),s=Math.abs(Math.sin(world.rotation||0));return {x:world.origin.x-(w*c+d*s)/2,z:world.origin.z-(w*s+d*c)/2,w:w*c+d*s,d:w*s+d*c};}
function intersects(a,b){return a.x<b.x+b.w-.01&&a.x+a.w>b.x+.01&&a.z<b.z+b.d-.01&&a.z+a.d>b.z+.01;}
function projectFurnitureScene(graph,art){
 const cam=cameraForArt(art,graph.canvas),nodes=graph.nodes.filter(n=>DIMENSIONS[n.motif]),placed=[],collisions=[];
 for(const node of nodes){const box=node.box,screenY=Math.min(graph.canvas.height*.95,Math.max(cam.horizonY+graph.canvas.height*.14,box.y+box.h));let origin=cam.unprojectGround(box.x+box.w/2,screenY);
  if(!origin)throw Object.assign(new Error('Furniture base cannot be projected onto the floor'),{code:'INVALID_CAMERA_PLACEMENT'});
  const world={origin,size:DIMENSIONS[node.motif].slice(),rotation:0};let tries=0;
  while(placed.some(p=>intersects(footprint(world),footprint(p.world)))&&tries++<24){const direction=tries%2?1:-1,step=(Math.floor((tries+1)/2))*.42;world.origin={x:origin.x+Math.cos(cam.yaw)*step*direction,y:0,z:origin.z-Math.sin(cam.yaw)*step*direction};}
  if(placed.some(p=>intersects(footprint(world),footprint(p.world))))collisions.push(node.id);
  const faces=geometryFor(node.motif,world,cam),pts=faces.flatMap(f=>f.points);if(!pts.length)throw Object.assign(new Error('Furniture is behind the camera'),{code:'CAMERA_NEAR_PLANE'});
  node.world=world;node.worldFaces=faces;node.plane='midground';node.box={x:Math.min(...pts.map(p=>p.x)),y:Math.min(...pts.map(p=>p.y)),w:Math.max(...pts.map(p=>p.x))-Math.min(...pts.map(p=>p.x)),h:Math.max(...pts.map(p=>p.y))-Math.min(...pts.map(p=>p.y))};node.z=5000-cam.project(world.origin).depth*100;
  if(node.motif==='armchair'){const seat=cam.project(localPoint(world.origin,{x:0,y:.62,z:-.04},world.rotation)),head=cam.project(localPoint(world.origin,{x:0,y:.86,z:-.04},world.rotation));node.worldSeat={x:seat.x,y:seat.y,unit:Math.hypot(head.x-seat.x,head.y-seat.y)};}
  placed.push(node);
 }
 for(const person of graph.nodes.filter(n=>n.attributes.rigPose&&n.parent)){
  const chair=nodes.find(n=>n.id===person.parent&&n.worldSeat);if(!chair)continue;const frame=chair.worldSeat;person.attributes.rigFrame=frame;person.plane=chair.plane;person.z=chair.z+2;person.box={x:frame.x-frame.unit*1.15,y:frame.y-frame.unit*3.5,w:frame.unit*3.7,h:frame.unit*5.7};
  for(const book of graph.nodes.filter(n=>n.parent===person.id&&n.motif==='book')){book.box=heldBookBox(frame);book.plane=person.plane;book.z=person.z+1;}
 }
 graph.world={camera:{height:cam.eye,yaw:cam.yaw,pitch:cam.pitch,focal:cam.focal,horizonY:cam.horizonY},collisions,objects:nodes.map(n=>({id:n.id,origin:n.world.origin,size:n.world.size,footprint:footprint(n.world)}))};
 return {camera:cam,nodes,collisions};
}
module.exports={DIMENSIONS,cameraForArt,localPoint,components,geometryFor,footprint,intersects,projectFurnitureScene};
