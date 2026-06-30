import sharp from "sharp";
import { RubikFaceDetector } from "./src/lib/rubik-detector/core/RubikFaceDetector";
import { ShapeDetector } from "./src/lib/rubik-detector/core/ShapeDetector";
const OUT="/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
type P={x:number;y:number};
const dist=(a:P,b:P)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a:P,b:P,t:number):P=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
function subdivide(shapes:{corners:P[]}[]):P[]{const sides:number[]=[];for(const s of shapes){const[tl,tr,br,bl]=s.corners;sides.push((dist(tl,tr)+dist(bl,br))/2,(dist(tl,bl)+dist(tr,br))/2);}if(!sides.length)return[];const sr=sides.slice().sort((a,b)=>a-b);const unit=sr[Math.floor(sr.length*0.15)]||1;const cells:P[]=[];for(const s of shapes){const[tl,tr,br,bl]=s.corners;const w=(dist(tl,tr)+dist(bl,br))/2,h=(dist(tl,bl)+dist(tr,br))/2;const nc=Math.max(1,Math.round(w/unit)),nr=Math.max(1,Math.round(h/unit));for(let a=0;a<nc;a++)for(let b=0;b<nr;b++){const top=lerp(tl,tr,(a+0.5)/nc),bot=lerp(bl,br,(a+0.5)/nc);cells.push(lerp(top,bot,(b+0.5)/nr));}}return cells;}
function axes3(cells:P[]){const n=cells.length;if(n<5)return null;const nn:number[]=[];for(let i=0;i<n;i++){let m=Infinity;for(let j=0;j<n;j++)if(i!==j)m=Math.min(m,dist(cells[i],cells[j]));nn.push(m);}const cell=nn.slice().sort((a,b)=>a-b)[nn.length>>1];const steps:{ang:number;len:number}[]=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const dx=cells[j].x-cells[i].x,dy=cells[j].y-cells[i].y;const len=Math.hypot(dx,dy);if(len<0.7*cell||len>1.25*cell)continue;let ang=Math.atan2(dy,dx)*180/Math.PI;if(ang<0)ang+=180;steps.push({ang,len});}const fams:{ang:number;n:number;lens:number[];angs:number[]}[]=[];for(const s of steps){let pl=false;for(const f of fams){let dd=Math.abs(f.ang-s.ang);dd=Math.min(dd,180-dd);if(dd<14){f.lens.push(s.len);f.angs.push(s.ang);f.n++;f.ang=(f.ang*(f.n-1)+s.ang)/f.n;pl=true;break;}}if(!pl)fams.push({ang:s.ang,n:1,lens:[s.len],angs:[s.ang]});}fams.sort((a,b)=>b.n-a.n);const med=(a:number[])=>a.slice().sort((x,y)=>x-y)[a.length>>1];const top=fams.slice(0,3).filter(f=>f.n>=Math.max(2,fams[0].n*0.25));return {axes:top.map(f=>{const L=med(f.lens),A=med(f.angs)*Math.PI/180;return {x:L*Math.cos(A),y:L*Math.sin(A)};}),cell};}
const E:[number,number][]=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
async function main(){
  for(const [name,path] of [["s4","/Users/jeremyguyet/Downloads/cube-seq-24x360x203 (4).png"],["s3","/Users/jeremyguyet/Downloads/cube-seq-24x360x203 (3).png"]] as const){
    const {data}=await sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const fw=360,fh=203;const det=new RubikFaceDetector(),sd=new ShapeDetector();
    for(const f of [10,16]){
      const fd=Buffer.alloc(fw*fh*4);for(let y=0;y<fh;y++)data.copy(fd,y*fw*4,(f*fh+y)*fw*4,(f*fh+y+1)*fw*4);
      const img={width:fw,height:fh,data:new Uint8ClampedArray(fd)} as unknown as ImageData;
      const r=det.process(img);if(!r.hull){console.log(name,f,"no hull");continue;}
      const cells=subdivide(sd.detect(img,160,r.hull));const ax=axes3(cells);
      if(!ax||ax.axes.length<3){console.log(`${name} f${f}: cells ${cells.length}, axes ${ax?ax.axes.length:0} (<3)`);continue;}
      // near corner = stickers centroid; edges = 3*axis. Orient each axis away from centroid-ish (sign by max spread)
      let cx=0,cy=0;for(const c of cells){cx+=c.x;cy+=c.y;}cx/=cells.length;cy/=cells.length;
      const EA=ax.axes.map(a=>({x:3*a.x,y:3*a.y}));
      // origin so cube centre = centroid: origin=centroid-0.5(EA+EB+EC)
      const sum={x:EA.reduce((s,a)=>s+a.x,0),y:EA.reduce((s,a)=>s+a.y,0)};
      const o={x:cx-0.5*sum.x,y:cy-0.5*sum.y};
      let C:P[]=[];for(let i=0;i<2;i++)for(let j=0;j<2;j++)for(let k=0;k<2;k++)C.push({x:o.x+i*EA[0].x+j*EA[1].x+k*EA[2].x,y:o.y+i*EA[0].y+j*EA[1].y+k*EA[2].y});
      let ccx=0,ccy=0;for(const p of C){ccx+=p.x;ccy+=p.y;}ccx/=8;ccy/=8;
      let cubeR=0;for(const p of C)cubeR=Math.max(cubeR,Math.hypot(p.x-ccx,p.y-ccy));
      let hcx=0,hcy=0;for(const p of r.hull){hcx+=p.x;hcy+=p.y;}hcx/=r.hull.length;hcy/=r.hull.length;
      let hullR=0;for(const p of r.hull)hullR=Math.max(hullR,Math.hypot(p.x-hcx,p.y-hcy));
      const sc=hullR/(cubeR||1);
      C=C.map(p=>({x:hcx+(p.x-ccx)*sc,y:hcy+(p.y-ccy)*sc}));
      console.log(`${name} f${f}: cells ${cells.length}, 3 axes OK, scale ${sc.toFixed(2)}`);
      let svg=`<polygon points="${r.hull.map((p:any)=>`${p.x|0},${p.y|0}`).join(" ")}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>`;
      for(const [i,j] of E)svg+=`<line x1="${C[i].x|0}" y1="${C[i].y|0}" x2="${C[j].x|0}" y2="${C[j].y|0}" stroke="#ff30e0" stroke-width="2.5"/>`;
      await sharp(fd,{raw:{width:fw,height:fh,channels:4}}).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${svg}</svg>`),top:0,left:0}]).png().toFile(`${OUT}/cube3-${name}-${f}.png`);
    }
  }
}
main();
