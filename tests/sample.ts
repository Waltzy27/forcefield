import { solve } from "../assembly/src/fem";
import { box, mkPart, faceAt } from "./bench";
const wall=mkPart("Bracket",box([-0.04,-0.02,-0.05],[0,0.05,0.07]),"hex8i",0.01), arm=mkPart("Arm",box([0,0,0],[0.3,0.03,0.02]),"hex8i",0.01);
wall.autoRefine=arm.autoRefine=process.argv[2]!=="noref"; arm.material={...arm.material,E:68.9e9,nu:.33};
const {res,mesh}=solve({parts:[wall,arm],supports:[{id:"s",name:"W",kind:"fixed",region:{part:wall.id,point:[-0.04,0.015,0.01],normal:[-1,0,0],scope:"face",radius:0,tris:faceAt(wall,[-0.04,0,0],[1,0,0])},stiffness:0,disp:[0,0,0]}],
 mates:[{id:"m",name:"M",kind:"bonded",a:{part:wall.id,point:[0,0.015,0.01],normal:[1,0,0],scope:"face",radius:0,tris:faceAt(wall,[0,0,0],[1,0,0])},b:{part:arm.id,point:[0,0.015,0.01],normal:[-1,0,0],scope:"face",radius:0,tris:faceAt(arm,[0,0,0],[1,0,0])}}],
 forces:[{id:"f",name:"T",part:arm.id,point:[0.3,0.015,0.02],dir:[0,0,-1],magnitude:500,radius:0.012},{id:"g",name:"S",part:arm.id,point:[0.3,0.03,0.01],dir:[0,-1,0],magnitude:150,radius:0.012}],gravity:false,tol:1e-8,maxIter:40000});
const bins=new Map<number,number>();
mesh.elements.forEach((e,i)=>{ if(e.part!==arm.id)return; const x=mesh.nodes[e.nodes[0]].p[0]; const k=Math.round(x*100); bins.set(k,Math.max(bins.get(k)??0,res.elemStress[i]));});
console.log([...bins].sort((a,b)=>a[0]-b[0]).map(([k,v])=>k+":"+(v/1e6).toFixed(1)).join(" "));
const g=mesh.grids.find(g=>g.part===arm.id)!; console.log(g.gx.map(v=>+(v*1000).toFixed(1)).join(","), g.gy.length, g.gz.length);
