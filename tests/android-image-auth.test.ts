import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let source = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {RelayImage} from './apps/mobile/src/relay-image';
    import {ImageViewerImage} from './apps/mobile/src/image-viewer';
    window.nativeImages=[];
    const root=createRoot(document.getElementById('root'));
    window.render=(platform,uri,viewer=false)=>{
      window.nativePlatform=platform;window.nativeImages=[];
      const source={uri,headers:{authorization:'Bearer test-only'}};
      flushSync(()=>root.render(viewer?<ImageViewerImage key={uri+platform} preview={{source,name:'fixture'}} onClose={()=>{}}/>:<RelayImage source={source} onLoad={()=>{}}/>));
    };
    window.stop=()=>flushSync(()=>root.unmount());
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'native-image-fixture', setup(builder) {
    const modules: Record<string,string> = {
      'react-native': `import {useLayoutEffect} from 'react';
        export const Platform={get OS(){return window.nativePlatform}};
        export const Image=props=>{window.nativeImages.push(props);return <img data-local="native-image"/>};
        export const View=({children,onLayout})=>{useLayoutEffect(()=>{onLayout?.({nativeEvent:{layout:{width:390,height:600}}})},[]);return <div>{children}</div>};
        export const Text=({children})=><span>{children}</span>;export const ActivityIndicator=()=>null;export const Modal=({children})=><div>{children}</div>;`,
      'react-native-svg': 'export const SvgXml=()=>null;',
      'react-native-safe-area-context': 'export const SafeAreaProvider=({children})=>children;export const SafeAreaView=({children})=>children;',
      'react-native-gesture-handler': 'export const GestureHandlerRootView=({children})=>children;',
      'react-native-zoom-toolkit': 'export const ResumableZoom=({children})=>children;',
      'expo-status-bar': 'export const StatusBar=()=>null;',
      './image-viewer-controls': 'export const ImageViewerHeader=()=>null;export const ImageViewerNavigation=()=>null;',
      './styles': 'export const useTheme=()=>({s:{}});',
    };
    builder.onResolve({filter:/^(react-native(?:-svg|-safe-area-context|-gesture-handler|-zoom-toolkit)?|expo-status-bar|\.\/(image-viewer-controls|styles))$/}, args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path]!,loader:'jsx',resolveDir:process.cwd()}));
  }}] });
  source = result.outputFiles[0]!.text;
});

it.each(['png','jpg','jpeg','gif','webp','bmp','ico','avif'])('keeps Android authentication for %s thumbnails and both viewer entry paths, preserving iOS', type => {
  const dom = new JSDOM('<div id="root"></div>', {runScripts:'dangerously'});
  const w = dom.window as any;
  try {
    w.eval(source);
    for(const uri of [`http://relay.test/v1/devices/pc/threads/thread/images/id?name=image.${type}`,`http://relay.test/v1/devices/pc/threads/thread/files/content?path=image.${type}`]) {
      for(const viewer of [false,true]) {
        w.render('android',uri,viewer);
        const image=w.nativeImages.at(-1);
        expect(image).toBeDefined();
        // RN Image.android.js reads nativeProps.headers only from source[0].
        expect(Array.isArray(image.source)).toBe(true);
        expect(image.source[0]).toEqual({uri,headers:{authorization:'Bearer test-only'}});
        expect(image.onLoad).toBeTypeOf('function');
        w.render('ios',uri,viewer);
        expect(w.nativeImages.at(-1).source).toEqual({uri,headers:{authorization:'Bearer test-only'}});
      }
    }
  } finally { w.stop(); dom.window.close(); }
});
