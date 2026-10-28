import { solve } from "../assembly/src/fem";
import { Part, MATERIALS, ElementKind, Support, Force, Mate, SolveInput, Vec } from "../assembly/src/model";
import { adjacency, floodSelect } from "../assembly/src/geometry";
export function box(lo: Vec, hi: Vec): Float32Array {
  const [a,b,c]=lo,[d,e,f]=hi;
  const v=[[a,b,c],[d,b,c],[d,e,c],[a,e,c],[a,b,f],[d,b,f],[d,e,f],[a,e,f]];
  const q=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[0,4,7,3]];
  const out:number[]=[]; for(const [i,j,k,l] of q) for(const t of [[i,j,k],[i,k,l]]) for(const n of t) out.push(...v[n]);
  return new Float32Array(out);
}
export const mkPart=(id:string,tris:Float32Array,el:ElementKind,size:number,offset:Vec=[0,0,0]):Part=>({id,name:id,file:id,units:"m",tris,raw:tris,material:MATERIALS[0],offset,rotation:[0,0,0],element:el,size,autoRefine:false,refinements:[],beamAxis:"auto",section:null,color:"#888",visible:true,notes:""});
export function faceAt(p:Part, pt:Vec, n:Vec){ // find tri whose normal matches and contains approx
  const {nb}=adjacency(p.tris); let seed=-1;
  for(let i=0;i<p.tris.length/9;i++){const o=i*9;const ax=n.findIndex(x=>x!==0);const v=p.tris[o+ax]; if(Math.abs(v-pt[ax])<1e-9&&Math.abs(p.tris[o+3+ax]-pt[ax])<1e-9&&Math.abs(p.tris[o+6+ax]-pt[ax])<1e-9){seed=i;break;}}
  return floodSelect(p.tris,nb,seed,"planar");
}
if (process.argv[1]?.includes('bench')) {
const L=1, w=0.1, E=200e9, I=w**4/12, F=1000;
const exact = F*L**3/(3*E*I) + F*L/(5/6*w*w*E/(2*1.26));
console.log("Timoshenko cantilever tip deflection", exact);
for (const [el,size] of [["beam",0.05],["hex8",0.025],["hex8i",0.025],["shell",0.025],["tet4",0.025],["tet10",0.05]] as [ElementKind,number][]) {
  const p=mkPart("bar",box([0,0,0],[L,w,w]),el,size);
  const sup:Support={id:"s",name:"Fixed",kind:"fixed",region:{part:"bar",point:[0,w/2,w/2],normal:[-1,0,0],scope:"face",radius:0,tris:faceAt(p,[0,0,0],[1,0,0])},stiffness:0,disp:[0,0,0]};
  const f:Force={id:"f",name:"F1",part:"bar",point:[L,w/2,w/2],dir:[0,0,-1],magnitude:F,radius:0.06};
  const t=Date.now();
  try{const {res}=solve({parts:[p],forces:[f],supports:[sup],mates:[],gravity:false,tol:1e-8,maxIter:20000});
  let tip=0; res.u.forEach((v,i)=>{if(i%3===2)tip=Math.min(tip,v)});
  console.log(el.padEnd(6),"tip",(-tip).toExponential(4),"ratio",(-tip/exact).toFixed(3),"maxVM",(res.maxStress/1e6).toFixed(2),"MPa (beam theory root 6.0)","it",res.iterations,"dofs",res.dofs,"reac",res.reaction.map(v=>v.toFixed(1)).join(","),(Date.now()-t)+"ms",res.warnings.length?res.warnings:"");}catch(e){console.log(el,"ERR",(e as Error).message)}
}
// bonded assembly: two bars end to end, fixed at x=0, load at end of second
for (const kind of ["bonded","planar"] as const){
  const a=mkPart("A",box([0,0,0],[0.5,w,w]),"hex8i",0.025), b=mkPart("B",box([0.5,0,0],[1,w,w]),"hex8i",0.025);
  const sup:Support={id:"s",name:"Fixed",kind:"fixed",region:{part:"A",point:[0,0.05,0.05],normal:[-1,0,0],scope:"face",radius:0,tris:faceAt(a,[0,0,0],[1,0,0])},stiffness:0,disp:[0,0,0]};
  const m:Mate={id:"m",name:"Mate1",kind,a:{part:"A",point:[0.5,0.05,0.05],normal:[1,0,0],scope:"face",radius:0,tris:faceAt(a,[0.5,0,0],[1,0,0])},b:{part:"B",point:[0.5,0.05,0.05],normal:[-1,0,0],scope:"face",radius:0,tris:faceAt(b,[0.5,0,0],[1,0,0])}};
  const f:Force={id:"f",name:"F1",part:"B",point:[1,w/2,w/2],dir:[0,0,-1],magnitude:F,radius:0.06};
  const t=Date.now();
  try{const {res}=solve({parts:[a,b],forces:[f],supports:[sup],mates:[m],gravity:false,tol:1e-8,maxIter:20000});
  let tip=0; res.u.forEach((v,i)=>{if(i%3===2)tip=Math.min(tip,v)});
  console.log(kind,"assembly tip",(-tip).toExponential(4),"ratio",(-tip/exact).toFixed(3),"it",res.iterations,"mate",res.mateForces[0].force.map(v=>v.toFixed(1)),(Date.now()-t)+"ms");}catch(e){console.log(kind,"ERR",(e as Error).message)}
}

}
