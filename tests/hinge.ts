import { solve } from "../assembly/src/fem";
import { adjacency, floodSelect, fitCylinder } from "../assembly/src/geometry";
import { mkPart } from "./bench";
import { Vec, Region } from "../assembly/src/model";
function cyl(r0:number,r1:number,z0:number,z1:number,n=32){ // tube if r0>0 else solid
  const out:number[]=[]; const P=(r:number,a:number,z:number)=>[r*Math.cos(a),r*Math.sin(a),z];
  const tri=(a:number[],b:number[],c:number[])=>out.push(...a,...b,...c);
  for(let i=0;i<n;i++){const a=2*Math.PI*i/n,b=2*Math.PI*(i+1)/n;
    tri(P(r1,a,z0),P(r1,b,z0),P(r1,b,z1)); tri(P(r1,a,z0),P(r1,b,z1),P(r1,a,z1));
    if(r0>0){ tri(P(r0,a,z0),P(r0,b,z1),P(r0,b,z0)); tri(P(r0,a,z0),P(r0,a,z1),P(r0,b,z1));
      tri(P(r0,a,z0),P(r1,b,z0),P(r1,a,z0)); tri(P(r0,a,z0),P(r0,b,z0),P(r1,b,z0));
      tri(P(r0,a,z1),P(r1,a,z1),P(r1,b,z1)); tri(P(r0,a,z1),P(r1,b,z1),P(r0,b,z1));
    } else { tri([0,0,z0],P(r1,b,z0),P(r1,a,z0)); tri([0,0,z1],P(r1,a,z1),P(r1,b,z1)); }
  }
  return new Float32Array(out);
}
function cylRegion(part:any, wantR:number):Region{
  const {nb}=adjacency(part.tris); let seed=-1;
  for(let i=0;i<part.tris.length/9;i++){const o=i*9;const r=Math.hypot(part.tris[o],part.tris[o+1]);const r2=Math.hypot(part.tris[o+3],part.tris[o+4]);const r3=Math.hypot(part.tris[o+6],part.tris[o+7]);if(Math.abs(r-wantR)<1e-6&&Math.abs(r2-wantR)<1e-6&&Math.abs(r3-wantR)<1e-6){seed=i;break;}}
  const tris=floodSelect(part.tris,nb,seed,"smooth"); const c=fitCylinder(part.tris,tris);
  return {part:part.id,point:[wantR,0,0],normal:[1,0,0],scope:"cylinder",radius:0,tris,axis:c.axis,center:c.center,cylR:c.radius};
}
const A=mkPart("A",cyl(0.01,0.03,0.02,0.04),"hex8i",0.0025), B=mkPart("B",cyl(0,0.01,0,0.06),"hex8i",0.0025);
const rA=cylRegion(A,0.03), hA=cylRegion(A,0.01), pB=cylRegion(B,0.01);
console.log("fit", hA.axis, hA.center, hA.cylR, pB.cylR);
for (const [kind,dir] of [["hinge",[1,0,0]],["bonded",[0,0,1]]] as [any,Vec][]) {
  // torque case: force tangential at radius on pin end -> rotation mechanism
  const pt:Vec = dir[1]===1?[0.01,0,0]:[0,0,0];
  try{ const {res}=solve({parts:[A,B],forces:[{id:"f",name:"F",part:"B",point:[pt[0],pt[1],0],dir,magnitude:100,radius:0.004}],supports:[{id:"s",name:"S",kind:"fixed",region:rA,stiffness:0,disp:[0,0,0]}],mates:[{id:"m",name:"M",kind,a:hA,b:pB}],gravity:false,tol:1e-8,maxIter:20000});
   console.log(kind,dir,"maxU",res.maxDisp.toExponential(3),"maxS",(res.maxStress/1e6).toFixed(2),"MPa it",res.iterations,"reac",res.reaction.map(v=>v.toFixed(1)),res.warnings);
  }catch(e){console.log(kind,dir,"ERR",(e as Error).message.slice(0,80))}
}
