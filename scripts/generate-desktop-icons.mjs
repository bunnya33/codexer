import { writeFileSync } from 'node:fs';
import pngjs from 'pngjs';
const {PNG}=pngjs;
function png(size) {
  const image=new PNG({width:size,height:size});
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const px=x/size,py=y/size,i=(y*size+x)*4;
    const prompt=px>.26&&px<.48&&(Math.abs(py-(.34+(px-.26)*.75))<.025||Math.abs(py-(.66-(px-.26)*.75))<.025);
    const cursor=px>.51&&px<.74&&py>.64&&py<.69;
    image.data.set(prompt||cursor?[255,255,255,255]:[50,106,235,255],i);
  }return PNG.sync.write(image);
}
writeFileSync('apps/desktop/assets/icon.png',png(512));
const icoPng=png(256),header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(icoPng.length,14);header.writeUInt32LE(22,18);
writeFileSync('apps/desktop/assets/icon.ico',Buffer.concat([header,icoPng]));
const chunks=[['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]].map(([type,size])=>{const data=png(size),chunk=Buffer.alloc(8);chunk.write(type);chunk.writeUInt32BE(data.length+8,4);return Buffer.concat([chunk,data]);});
const icns=Buffer.alloc(8);icns.write('icns');icns.writeUInt32BE(8+chunks.reduce((sum,item)=>sum+item.length,0),4);writeFileSync('apps/desktop/assets/icon.icns',Buffer.concat([icns,...chunks]));
