import sharp from "sharp";
import { RubikFaceDetector } from "./src/lib/rubik-detector/core/RubikFaceDetector";
import { ShapeDetector } from "./src/lib/rubik-detector/core/ShapeDetector";
import { CubePoseFromShapes } from "./src/lib/rubik-detector/core/CubePoseFromShapes";
const OUT="/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
const SEQS=[["s4","/Users/jeremyguyet/Downloads/cube-seq-24x360x203 (4).png"],["s3","/Users/jeremyguyet/Downloads/cube-seq-24x360x203 (3).png"]];
async function main(){
  for(const [name,path] of SEQS){
    const {data}=await sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const fw=360,fh=203,NF=24;
    const det=new RubikFaceDetector(), sd=new ShapeDetector(), pf=new CubePoseFromShapes();
    let ok=0;
    for(let f=0;f<NF;f++){
      const fd=Buffer.alloc(fw*fh*4);for(let y=0;y<fh;y++)data.copy(fd,y*fw*4,(f*fh+y)*fw*4,(f*fh+y+1)*fw*4);
      const img={width:fw,height:fh,data:new Uint8ClampedArray(fd)} as unknown as ImageData;
      const r=det.process(img);let pose:any=null;
      if(r.hull){const shapes=sd.detect(img,160,r.hull);pose=pf.fit(shapes,r.hull);}
      if(pose)ok++;
      if(f===8||f===14||f===18){
        let svg=r.hull?`<polygon points="${r.hull.map((p:any)=>`${p.x|0},${p.y|0}`).join(" ")}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>`:"";
        if(pose)for(const [i,j] of pose.edges)svg+=`<line x1="${pose.corners[i].x|0}" y1="${pose.corners[i].y|0}" x2="${pose.corners[j].x|0}" y2="${pose.corners[j].y|0}" stroke="#ff30e0" stroke-width="2.5"/>`;
        await sharp(fd,{raw:{width:fw,height:fh,channels:4}}).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${svg}</svg>`),top:0,left:0}]).png().toFile(`${OUT}/sc-${name}-${f}.png`);
      }
    }
    console.log(`${name}: pose ${ok}/${NF}`);
  }
}
main();
