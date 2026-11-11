'use strict';
// Head-unit hand construction. Joint limits are engineering constraints, not a
// photographic anatomy claim or an attributed rule from a reference PDF.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const point=(p,length,angle)=>({x:p.x+length*Math.cos(angle),y:p.y+length*Math.sin(angle)});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function solveHand(options={}) {
  const wrist=options.wrist,unit=Number(options.unit),angle=Number(options.angle||0),side=options.side==='R'?1:-1;
  if(!wrist||![wrist.x,wrist.y,unit,angle].every(Number.isFinite)||unit<=0)throw new Error('Invalid hand geometry');
  const grip=clamp(Number(options.grip||0),0,1),joints={wrist},bones=[],clamped=[];
  const transform=(x,y)=>({x:wrist.x+unit*(x*Math.cos(angle)-y*Math.sin(angle)),y:wrist.y+unit*(x*Math.sin(angle)+y*Math.cos(angle))});
  const palm=[transform(0,-.12),transform(.25,-.17),transform(.34,-.10),transform(.34,.14),transform(.05,.14)];
  const digits=[];
  for(let finger=0;finger<5;finger++){
    const thumb=finger===4,spread=thumb?side*.95:(finger-1.5)*.09;
    const root=thumb?transform(.07,side*.11):transform(.27,-.13+finger*.085);
    const total=thumb?.32:[.31,.41,.38,.29][finger],ratios=thumb?[.45,.32,.23]:[.45,.32,.23];
    const names=['MCP','PIP','DIP','TIP'],points=[root];joints['finger'+finger+names[0]]=root;
    let heading=angle+spread;
    for(let k=0;k<3;k++){
      const supplied=options.flexions?.[finger]?.[k];
      if(supplied!==undefined&&!Number.isFinite(supplied))throw new Error('Invalid finger flexion');
      const requested=supplied===undefined?grip*[.45,.9,.6][k]:supplied,max=[Math.PI/2,Math.PI*.58,Math.PI/2][k],flex=clamp(requested,0,max);
      if(flex!==requested)clamped.push('finger'+finger+names[k]);
      heading+=side*flex;const next=point(points.at(-1),total*ratios[k]*unit,heading),a='finger'+finger+names[k],b='finger'+finger+names[k+1];
      joints[b]=next;bones.push({a,b,length:total*ratios[k]*unit});points.push(next);
    }
    digits.push({finger,thumb,points,grip});
  }
  const errors=bones.filter(b=>Math.abs(distance(joints[b.a],joints[b.b])-b.length)>Math.max(.01,b.length*1e-4)).map(b=>'FINGER_LENGTH:'+b.a);
  return {palm,digits,joints,bones,clamped,issues:errors,grip};
}
module.exports={solveHand};
