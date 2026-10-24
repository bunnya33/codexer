import {beforeAll, expect, it, vi} from 'vitest';
import {build} from 'esbuild';

let javascript = '';
beforeAll(async () => {
  const result = await build({entryPoints:['apps/control-native/src/bridge.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{
    name:'native-promise-fixture', setup(builder) {
      builder.onResolve({filter:/^react-native$/},()=>({path:'native',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const TurboModuleRegistry = {getEnforcing:()=>fixtureNative}; export const DeviceEventEmitter = {}; export const Platform = {OS:"windows"};'}));
    },
  }]});
  javascript = result.outputFiles[0]!.text;
});
function fixture() {
  const native = {boot: () => '{"mode":"agent","version":"test"}', request: vi.fn()};
  const module = {exports:{} as {request:(method:string)=>Promise<unknown>}};
  new Function('module','exports','fixtureNative',javascript)(module,module.exports,native);
  return {native,request:module.exports.request};
}

it.each([
  {message:'账号或密码错误。', code:'EUNSPECIFIED'},
  {message:'本机服务启动失败，请查看诊断。'},
  'native-service-stopped',
  new Error('无法确认登录状态，请检查网络后重试。'),
])('preserves native promise rejection messages as Error instances', async value => {
  const {native,request} = fixture();
  native.request.mockRejectedValueOnce(value);
  const error = await request('agent.login').catch(error => error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected native rejection to be normalized');
  expect(error.message).toBe(typeof value === 'string' ? value : value.message);
});

it('parses successful native replies and uses a useful fallback for unknown rejections', async () => {
  const {native,request} = fixture();
  native.request.mockResolvedValueOnce('{"loggedIn":true}');
  await expect(request('agent.state')).resolves.toEqual({loggedIn:true});
  native.request.mockRejectedValueOnce(null);
  await expect(request('agent.connect')).rejects.toThrow('请查看诊断日志');
});
