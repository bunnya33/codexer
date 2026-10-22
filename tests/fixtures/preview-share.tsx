import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {PreviewShareDialog} from '../../apps/mobile/src/preview-share-dialog';
function Fixture(){const [open,setOpen]=useState(true);return open?<PreviewShareDialog reference={location.search.includes('audio')?{kind:'audio',source:'/fixture/song.wav',title:'测试音频.wav'}:{kind:'server',source:'http://localhost:5173/demo',title:'测试页面'}} deviceId="pc" threadId="thread" onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>重新打开分享</button>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
