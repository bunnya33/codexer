import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';

it.each(['mobile', 'windows'])('propagates %s clipboard rejection/false rather than reporting success', async platform => {
  const result = await build({ entryPoints: [platform === 'mobile' ? 'apps/mobile/src/runtime.ts' : 'apps/control-native/src/adapters/runtime.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{
    name: 'clipboard-adapter', setup(builder) {
      builder.onResolve({ filter: /^(expo-clipboard|expo-crypto|expo-secure-store|react-native|\.\.\/bridge)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'expo-clipboard' ? 'export const setStringAsync=fixtureCopy;' : args.path === '../bridge' ? 'export const boot={};export const desktop={};export const request=fixtureCopy;' : 'export const Alert={};export const randomUUID=()=>"id";export const getItemAsync=()=>null;export const setItemAsync=()=>{};export const deleteItemAsync=()=>{};' }));
    },
  }] });
  const copy = vi.fn().mockResolvedValue(true);
  const module = { exports: {} as { copyText: (value: string) => Promise<void> } };
  new Function('module', 'exports', 'fixtureCopy', result.outputFiles[0]!.text)(module, module.exports, copy);
  await expect(module.exports.copyText('link')).resolves.toBeUndefined();
  expect(copy).toHaveBeenCalledWith(...(platform === 'mobile' ? ['link'] : ['clipboard.write', { value: 'link' }]));
  copy.mockResolvedValueOnce(false); await expect(module.exports.copyText('link')).rejects.toThrow('clipboard-unavailable');
  copy.mockRejectedValueOnce(new Error('native-write-failed')); await expect(module.exports.copyText('link')).rejects.toThrow('native-write-failed');
});

it('observes native upward gestures and reversals without taking the list responder', async () => {
  const result = await build({ entryPoints: ['apps/mobile/src/conversation-viewport.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{
    name: 'native-gesture', setup(builder) {
      builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-native)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'react' ? 'export const useRef=value=>({current:value});' : args.path === 'react-native' ? 'export const View="View";' : 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;' }));
    },
  }] });
  const module = { exports: {} as { ConversationViewport: (props: unknown) => { props: { onStartShouldSetResponderCapture: (event: unknown) => boolean; onMoveShouldSetResponderCapture: (event: unknown) => boolean } } } };
  new Function('module', 'exports', result.outputFiles[0]!.text)(module, module.exports);
  const intent = vi.fn(), view = module.exports.ConversationViewport({ onScrollIntent: intent });
  const event = (x: number, y: number, count = 1) => ({ nativeEvent: { pageX: x, pageY: y, touches: Array(count).fill({}) } });
  expect(view.props.onStartShouldSetResponderCapture(event(50, 100))).toBe(false);
  expect(view.props.onMoveShouldSetResponderCapture(event(50, 130))).toBe(false); expect(intent).toHaveBeenLastCalledWith('up');
  expect(view.props.onMoveShouldSetResponderCapture(event(50, 110))).toBe(false); expect(intent).toHaveBeenLastCalledWith('down');
  intent.mockClear(); view.props.onMoveShouldSetResponderCapture(event(100, 111)); view.props.onMoveShouldSetResponderCapture(event(50, 160, 2)); expect(intent).not.toHaveBeenCalled();
});
