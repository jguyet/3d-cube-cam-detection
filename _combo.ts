import sharp from "sharp";
import { RubikFaceDetector } from "./src/lib/rubik-detector/core/RubikFaceDetector";
import { ShapeDetector } from "./src/lib/rubik-detector/core/ShapeDetector";
import { ShapeTracker } from "./src/lib/rubik-detector/core/ShapeTracker";
const OUT="/private/tmp/claude-501/-Users-jeremyguyet-project-rubix-learn/c827224c-1d4f-4039-99d0-bde3b1caa87e/scratchpad";
async function main(){
  const {data}=await sharp("/Users/jeremyguyet/Downloads/cube-seq-24x360x203.png").ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const fw=360,fh=203,NF=24;
  const det=new RubikFaceDetector(), sd=new ShapeDetector(), st=new ShapeTracker();
  let mid:Buffer|null=null, hull:any=null, tracked:any=[];
  for(let f=0;f<NF;f++){
    const fd=Buffer.alloc(fw*fh*4);
    for(let y=0;y<fh;y++)data.copy(fd,y*fw*4,(f*fh+y)*fw*4,(f*fh+y+1)*fw*4);
    const img={width:fw,height:fh,data:new Uint8ClampedArray(fd)} as unknown as ImageData;
    const r=det.process(img);
    if(r.hull){ const shapes=sd.detect(img,160,r.hull); tracked=st.update(shapes); } else st.reset();
    if(f===20){mid=fd;hull=r.hull;}
  }
  console.log(`frame20: hull ${hull?hull.length+"pts":"none"}, ${tracked.length} stickers in zone`);
  if(mid){
    let svg=hull?`<polygon points="${hull.map((p:any)=>`${p.x|0},${p.y|0}`).join(" ")}" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>`:"";
    for(const t of tracked){svg+=`<polygon points="${t.corners.map((p:any)=>`${p.x|0},${p.y|0}`).join(" ")}" fill="none" stroke="#00ffd0" stroke-width="2"/><text x="${t.center.x|0}" y="${t.center.y|0}" fill="#ff0" font-size="9">${t.id}</text>`;}
    await sharp(mid,{raw:{width:fw,height:fh,channels:4}}).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${svg}</svg>`),top:0,left:0}]).png().toFile(`${OUT}/combo.png`);
  }
}
main();
