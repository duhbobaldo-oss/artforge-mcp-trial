'use strict';
const {templates}=require('./pose-templates');
const point=(a,length,angle)=>({x:a.x+length*Math.cos(angle),y:a.y+length*Math.sin(angle)});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
function limitAngle(value,center,limit,label,clamped){if(![value,center,limit].every(Number.isFinite))throw new Error('Invalid joint angle');const relative=wrap(value-center),bounded=Math.max(-limit,Math.min(limit,relative));if(Math.abs(relative-bounded)>1e-8)clamped.push(label);return center+bounded;}
function solveIK(root,target,a,b,bend=1) {
  if(![root.x,root.y,target.x,target.y,a,b].every(Number.isFinite)||a<=0||b<=0)throw new Error('Invalid IK geometry');
  const raw=distance(root,target),d=Math.max(Math.sqrt(a*a+b*b+2*a*b*Math.cos(150*Math.PI/180)),Math.min(a+b-1e-6,raw));
  const direction=Math.atan2(target.y-root.y,target.x-root.x);
  const cos=Math.max(-1,Math.min(1,(a*a+d*d-b*b)/(2*a*d)));
  const joint=point(root,a,direction+bend*Math.acos(cos)),end=point(root,d,direction);
  return {joint,end,reached:Math.abs(raw-d)<0.001,error:distance(end,target)};
}
function solvePose(name='standing',options={}) {
  const t=templates[name];if(!t)throw new Error('Unknown pose template');
  const u=options.unit===undefined?1:Number(options.unit);if(!Number.isFinite(u)||u<=0)throw new Error('Invalid pose unit');
  const pelvis=options.origin||{x:0,y:0};if(![pelvis.x,pelvis.y].every(Number.isFinite))throw new Error('Invalid pose origin');
  const neck=point(pelvis,2.1*u,t.torso),head=point(neck,0.75*u,t.torso),clamped=[],contacts={};
  const joints={pelvis,neck,head},bones=[];const add=(a,b,len)=>bones.push({a,b,length:len});add('pelvis','neck',2.1*u);add('neck','head',0.75*u);
  for(let i=0;i<2;i++){
    const side=i?'R':'L',sign=i?1:-1;
    joints['shoulder'+side]=point(neck,0.65*u,t.torso+sign*Math.PI/2);
    joints['hip'+side]=point(pelvis,0.35*u,t.torso+sign*Math.PI/2);
    add('neck','shoulder'+side,0.65*u);add('pelvis','hip'+side,0.35*u);
    const upper=limitAngle(options.angles?.['shoulder'+side]??t.arms[i],t.torso+Math.PI,155*Math.PI/180,'shoulder'+side,clamped);
    const lower=limitAngle(options.angles?.['elbow'+side]??t.forearms[i],upper,150*Math.PI/180,'elbow'+side,clamped);
    joints['elbow'+side]=point(joints['shoulder'+side],1.35*u,upper);
    joints['wrist'+side]=point(joints['elbow'+side],1.2*u,lower);
    const target=options.hands&&options.hands[side];
    if(target){const ik=solveIK(joints['shoulder'+side],target,1.35*u,1.2*u,i?-1:1);
      const direction=Math.atan2(ik.joint.y-joints['shoulder'+side].y,ik.joint.x-joints['shoulder'+side].x);
      const limited=limitAngle(direction,t.torso+Math.PI,155*Math.PI/180,'shoulder'+side,clamped);
      if(Math.abs(wrap(direction-limited))>1e-8){joints['elbow'+side]=point(joints['shoulder'+side],1.35*u,limited);const elbow=joints['elbow'+side],heading=Math.atan2(target.y-elbow.y,target.x-elbow.x);joints['wrist'+side]=point(elbow,1.2*u,limitAngle(heading,limited,150*Math.PI/180,'elbow'+side,clamped));}
      else {joints['elbow'+side]=ik.joint;joints['wrist'+side]=ik.end;}
      contacts[side]={error:distance(joints['wrist'+side],target),reached:distance(joints['wrist'+side],target)<=Math.max(.01,u*1e-4)};
    }
    const thigh=options.angles?.['hip'+side]??t.thighs[i],shin=limitAngle(options.angles?.['knee'+side]??t.shins[i],thigh,165*Math.PI/180,'knee'+side,clamped);
    if(![thigh,shin].every(Number.isFinite))throw new Error('Invalid joint angle');
    joints['knee'+side]=point(joints['hip'+side],1.8*u,thigh);joints['ankle'+side]=point(joints['knee'+side],1.75*u,shin);
    add('shoulder'+side,'elbow'+side,1.35*u);add('elbow'+side,'wrist'+side,1.2*u);add('hip'+side,'knee'+side,1.8*u);add('knee'+side,'ankle'+side,1.75*u);
  }
  return {name,unit:u,joints,bones,clamped,contacts,issues:validatePose({joints,bones},t.torso)};
}
function validatePose(rig,torso){
 const issues=rig.bones.filter(b=>Math.abs(distance(rig.joints[b.a],rig.joints[b.b])-b.length)>0.001).map(b=>'BONE_LENGTH:'+b.a+'/'+b.b);
 for(const side of ['L','R'])for(const [a,b,c,max] of [['shoulder','elbow','wrist',150],['hip','knee','ankle',165]]){
  const p=rig.joints[a+side],q=rig.joints[b+side],t=rig.joints[c+side];
  const dot=((q.x-p.x)*(t.x-q.x)+(q.y-p.y)*(t.y-q.y))/(distance(p,q)*distance(q,t));
  const flex=Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI;
  if(flex>max+0.01)issues.push('JOINT_LIMIT:'+b+side);
 }
 if(Number.isFinite(torso))for(const side of ['L','R']){const a=rig.joints['shoulder'+side],b=rig.joints['elbow'+side];if(Math.abs(wrap(Math.atan2(b.y-a.y,b.x-a.x)-(torso+Math.PI)))>155*Math.PI/180+1e-5)issues.push('JOINT_LIMIT:shoulder'+side);}
 return issues;
}
module.exports={solvePose,solveIK,validatePose,distance};
