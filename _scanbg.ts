import sharp from "sharp";
import { RubikFaceDetector } from "./src/lib/rubik-detector/core/RubikFaceDetector";
const OUT="/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
async function main(){
  const seq="/Users/jeremyguyet/Downloads/cube-seq-24x360x203.png";
  const {data}=await sharp(seq).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const fw=360,fh=203,NF=24;
  const det=new RubikFaceDetector();
  let last:any=null, mid:Buffer|null=null;
  for(let f=0;f<NF;f++){
    const fd=Buffer.alloc(fw*fh*4);
    for(let y=0;y<fh;y++)data.copy(fd,y*fw*4,(f*fh+y)*fw*4,(f*fh+y+1)*fw*4);
    const img={width:fw,height:fh,data:new Uint8ClampedArray(fd)} as unknown as ImageData;
    last=det.process(img);
    if(f===20)mid=fd;
  }
  console.log("frame20 hull:", last.hull?`${last.hull.length}pts frac ${last.fillFrac.toFixed(2)}`:"NONE");
  if(mid&&last.hull){
    const svg=`<polygon points="${last.hull.map((p:any)=>`${p.x|0},${p.y|0}`).join(" ")}" fill="rgba(0,255,200,0.18)" stroke="#00ffd0" stroke-width="2"/>`;
    await sharp(mid,{raw:{width:fw,height:fh,channels:4}}).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${svg}</svg>`),top:0,left:0}]).png().toFile(`${OUT}/scanbg.png`);
  }
}
main();
