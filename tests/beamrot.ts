import { solve } from "../assembly/src/fem";
import { box, mkPart } from "./bench";
import { toWorld, Vec } from "../assembly/src/model";
const I=0.1*0.05**3/12, ex=1000/(3*200e9*I);
for (const [rot,dirL] of [[[0,0,0],[0,0,-1]],[[90,0,0],[0,0,-1]],[[0,0,90],[0,0,-1]],[[0,0,90],[0,-1,0]]] as [Vec,Vec][]) {
  const p=mkPart("b",box([0,0,0],[1,0.1,0.05]),"beam",0.05); p.rotation=rot; p.material={...p.material,nu:.3};
  // dirL is in part-local; convert to world
  const R=toWorld({...p,offset:[0,0,0]} as any,dirL);
  const {res}=solve({parts:[p],forces:[{id:"f",name:"F",part:"b",point:toWorld(p,[1,0.05,0.025]),dir:R,magnitude:1000,radius:0}],supports:[{id:"s",name:"S",kind:"fixed",region:{part:"b",point:[0,0.05,0.025],normal:[-1,0,0],scope:"patch",radius:0},stiffness:0,disp:[0,0,0]}],mates:[],gravity:false,tol:1e-10,maxIter:5000});
  const expected = dirL[2]?ex: 1000/(3*200e9*(0.05*0.1**3/12));
  console.log(rot, dirL, (res.maxDisp/expected).toFixed(4), (res.maxStress/1e6).toFixed(2), dirL[2]?"exp σ "+(1000*1*0.025/I/1e6).toFixed(2):"exp σ "+(1000*0.05/(0.05*0.1**3/12)/1e6).toFixed(2));
}
