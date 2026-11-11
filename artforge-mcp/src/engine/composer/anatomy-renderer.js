'use strict';
const {solvePose}=require('./pose-solver');
const {templates}=require('./pose-templates');
const {solveHand}=require('./hand-rig');
const {fitPoseFrame}=require('./pose-layout');
const {lighten,darken}=require('../color');
const localShade=color=>({type:'mesh',rows:2,cols:2,nodes:[{x:0,y:0,color:lighten(color,0.18)},{x:1,y:0,color},{x:0,y:1,color},{x:1,y:1,color:darken(color,0.25)}]});
function anatomyOperations(box,options={}) {
  const name=templates[options.pose]?options.pose:'standing';
  let rig=solvePose(name);const frame=options.frame||fitPoseFrame(box,name),scale=frame.unit,ox=frame.x,oy=frame.y;
  const map=p=>({x:ox+p.x*scale,y:oy+p.y*scale});
  if(options.hands){const hands=Object.fromEntries(Object.entries(options.hands).map(([k,p])=>[k,{x:(p.x-ox)/scale,y:(p.y-oy)/scale}]));rig=solvePose(name,{hands});}
  const j=Object.fromEntries(Object.entries(rig.joints).map(([k,p])=>[k,map(p)])),ops=[];
  const look=options.appearance||{},skin=options.skin||look.skin||'#d7a27d',shirt=look.shirt||options.shirt||'#406b9c',pants=look.pants||options.pants||'#303d54';
  const handsRig={};
  const stroke=(points,size,color,note)=>ops.push({op:'draw.stroke',params:{points,size:scale*size,color,thinning:0.1,smoothing:0.3,taperStart:0,taperEnd:0},note});
  stroke([j.neck,j.head],0.26,skin,'neck connection');
  for(const side of ['L','R']){stroke([j['hip'+side],j['knee'+side],j['ankle'+side]],0.46,pants,'anatomical hip-knee-ankle');}
  ops.push({op:'draw.polygon',params:{points:[j.shoulderL,j.shoulderR,j.hipR,j.hipL],fill:localShade(shirt)},note:'clothed torso contour'});
  for(const side of ['L','R']){
    stroke([j['shoulder'+side],j['elbow'+side]],0.38,shirt,'sleeve shoulder-elbow');
    stroke([j['elbow'+side],j['wrist'+side]],0.27,skin,'forearm elbow-wrist');
    const wrist=j['wrist'+side],elbow=j['elbow'+side],forearm=Math.atan2(wrist.y-elbow.y,wrist.x-elbow.x);
    const grip=options.hands?0.8:(['reading','carrying','desk'].includes(name)?0.55:0.05);
    const hand=solveHand({wrist,unit:scale,angle:forearm,side,grip,flexions:options.fingerFlexions?.[side]});handsRig[side]=hand;
    ops.push({op:'draw.polygon',params:{points:hand.palm,fill:skin},note:'palm contour',stage:'contact-front'});
    for(const digit of hand.digits){stroke(digit.points,digit.thumb?.085:.055,skin,digit.thumb?'opposed thumb':'finger '+digit.finger+' MCP-PIP-DIP');ops.at(-1).stage='contact-front';}

  }
  for(const side of ['L','R']){const ankle=j['ankle'+side];ops.push({op:'draw.ellipse',params:{x:ankle.x-scale*0.25,y:ankle.y-scale*0.1,w:scale*0.75,h:scale*0.28,fill:'#1e2633'},note:'foot contact contour'});}
  const head=j.head,headAngle=Math.atan2(head.y-j.neck.y,head.x-j.neck.x)+Math.PI/2,headRotation=headAngle*180/Math.PI;ops.push({op:'draw.ellipse',params:{x:head.x-scale*.38,y:head.y-scale*.48,w:scale*.76,h:scale*.96,fill:localShade(skin),rotation:headRotation},note:'head cranial contour'});
  ops.push({op:'draw.path',params:{segments:[{op:'M',x:head.x-scale*.36,y:head.y},{op:'Q',cx:head.x-scale*.5,cy:head.y-scale*.66,x:head.x+scale*.25,y:head.y-scale*.48},{op:'L',x:head.x+scale*.37,y:head.y-scale*.12}],stroke:'#34261f',strokeWidth:scale*.12},note:'hair silhouette'});
  const face=(x,y)=>({x:head.x+scale*(x*Math.cos(headAngle)-y*Math.sin(headAngle)),y:head.y+scale*(x*Math.sin(headAngle)+y*Math.cos(headAngle))});
  const target=options.hands?{x:(options.hands.L.x+options.hands.R.x)/2,y:(options.hands.L.y+options.hands.R.y)/2}:head;
  const pupilX=Math.max(-.035,Math.min(.035,(target.x-head.x)/scale*.015)),pupilY=Math.max(-.025,Math.min(.035,(target.y-head.y)/scale*.015));
  const featureEllipse=(center,w,h,fill,note)=>ops.push({op:'draw.ellipse',params:{x:center.x-w*scale/2,y:center.y-h*scale/2,w:w*scale,h:h*scale,fill,rotation:headRotation},note});
  for(const side of [-1,1]){
    featureEllipse(face(side*.365,.015),.105,.20,skin,'ear landmark');
    featureEllipse(face(side*.15,-.075),.17,.075,'#f5eee4','eye white');featureEllipse(face(side*.15+pupilX,-.075+pupilY),.055,.060,'#25252a','iris directed toward held object');
    stroke([face(side*.24,-.18),face(side*.10,-.195)],.035,look.hair||'#34261f','eyebrow');
  }
  ops.push({op:'draw.path',params:{segments:[{op:'M',...face(.01,-.04)},{op:'L',...face(.055,.11)},{op:'Q',cx:face(.03,.145).x,cy:face(.03,.145).y,...face(-.035,.12)}],stroke:darken(skin,.35),strokeWidth:scale*.018,fill:null},note:'nose bridge and nostril'});
  ops.push({op:'draw.path',params:{segments:[{op:'M',...face(-.12,.25)},{op:'Q',cx:face(0,look.smile?.34:.27).x,cy:face(0,look.smile?.34:.27).y,...face(.12,.25)}],stroke:'#70483b',strokeWidth:scale*.025,fill:null},note:look.smile?'smiling mouth':'relaxed mouth'});
  const contacts=options.hands?Object.fromEntries(Object.entries(options.hands).map(([side,p])=>[side,Math.hypot(j['wrist'+side].x-p.x,j['wrist'+side].y-p.y)])):{};
  return {ops,rig:{...rig,joints:j,bones:rig.bones.map(b=>({...b,length:b.length*scale}))},contacts,hands:handsRig,issues:[...rig.issues,...Object.values(handsRig).flatMap(h=>h.issues)],clamped:[...rig.clamped,...Object.values(handsRig).flatMap(h=>h.clamped)]};
}
module.exports={anatomyOperations};
