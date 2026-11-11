'use strict';
const {solvePose}=require('./pose-solver');
function fitPoseFrame(box,pose){
 const points=Object.values(solvePose(pose).joints),lo={x:Math.min(...points.map(p=>p.x))-.6,y:Math.min(...points.map(p=>p.y))-.6},hi={x:Math.max(...points.map(p=>p.x))+.6,y:Math.max(...points.map(p=>p.y))+.6};
 const unit=Math.min(box.w/(hi.x-lo.x),box.h/(hi.y-lo.y));
 return {x:box.x+(box.w-(hi.x-lo.x)*unit)/2-lo.x*unit,y:box.y+box.h-(hi.y-.42)*unit,unit};
}
// The support edge is at wrist height in the same pelvis/head-unit frame.
// These targets lie inside both constrained arm reaches for reading/carrying.
function heldBookBox(frame){const u=frame.unit,w=u*.9/.7,h=u*.6;return {x:frame.x-w/2,y:frame.y-u*1.25-h*.65,w,h};}
module.exports={fitPoseFrame,heldBookBox};
