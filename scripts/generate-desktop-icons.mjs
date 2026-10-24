import {writeFileSync} from 'node:fs';
import {PNG} from 'pngjs';
function segment(x,y,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-ax-t*dx,y-ay-t*dy);}
function pixel(x,y){
  const dx=Math.abs(x-256)-140,dy=Math.abs(y-256)-140;
  if(Math.hypot(Math.max(dx,0),Math.max(dy,0))+Math.min(Math.max(dx,dy),0)>104)return [0,0,0,0];
  let color=[39,102-Math.round(y/24),220-Math.round(y/32),255];
  if(segment(x,y,140,158,226,228)<15||segment(x,y,226,228,140,298)<15||segment(x,y,266,296,366,296)<15)color=[255,255,255,255];
  if(segment(x,y,204,378,306,378)<8||Math.hypot(x-192,y-378)<18||Math.hypot(x-320,y-378)<18)color=[109,237,194,255];
  return color;
}
function png(size){const image=new PNG({width:size,height:size});for(let y=0;y<size;y++)for(let x=0;x<size;x++){const sum=[0,0,0,0];for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++){const c=pixel((x+(sx+.5)/2)*512/size,(y+(sy+.5)/2)*512/size);for(let k=0;k<3;k++)sum[k]+=c[k]*c[3]/255;sum[3]+=c[3];}const i=(y*size+x)*4;for(let k=0;k<3;k++)image.data[i+k]=sum[3]?Math.round(sum[k]*255/sum[3]):0;image.data[i+3]=Math.round(sum[3]/4);}return PNG.sync.write(image);}
const directory='apps/desktop/assets';
writeFileSync(directory+'/icon.png',png(512));
const sizes=[16,24,32,48,64,128,256],images=sizes.map(png),header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
for(let n=0;n<images.length;n++){const entry=6+n*16;header[entry]=header[entry+1]=sizes[n]===256?0:sizes[n];header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(images[n].length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=images[n].length;}
writeFileSync(directory+'/icon.ico',Buffer.concat([header,...images]));
const chunks=[['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]].map(([type,size])=>{const data=png(size),chunk=Buffer.alloc(8);chunk.write(type);chunk.writeUInt32BE(data.length+8,4);return Buffer.concat([chunk,data]);});const icns=Buffer.alloc(8);icns.write('icns');icns.writeUInt32BE(8+chunks.reduce((sum,item)=>sum+item.length,0),4);writeFileSync(directory+'/icon.icns',Buffer.concat([icns,...chunks]));
