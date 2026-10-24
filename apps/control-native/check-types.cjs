const path=require('node:path');
const {createRequire}=require('node:module');
const base=__dirname;
const platform=process.argv.includes('--macos')?'macos':'windows';
const dependencyRoot=platform==='macos'?path.join(base,'macos'):base;
const requirePlatform=createRequire(path.join(dependencyRoot,'package.json'));
const ts=requirePlatform('typescript');
const config=require('./metro.shared.cjs')(platform,dependencyRoot);
const runtime=platform==='macos'?'react-native-macos':'react-native-windows';
const modules=path.join(dependencyRoot,'node_modules');
const options={target:ts.ScriptTarget.ES2023,lib:['lib.es2024.d.ts','lib.dom.d.ts'],module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,strict:true,skipLibCheck:true,noEmit:true,esModuleInterop:true,resolveJsonModule:true,allowSyntheticDefaultImports:true,types:['react','node'],typeRoots:[path.join(modules,'@types'),path.join(base,'../../node_modules/@types')],baseUrl:base,ignoreDeprecations:'6.0',paths:{react:[path.join(modules,'@types/react')],'react/*':[path.join(modules,'@types/react/*')],'react-native':[path.join(modules,runtime)],'react-native/*':[path.join(modules,runtime,'*')],'react-native-macos/*':[path.join(modules,'react-native-macos','*')],'react-native-svg':[path.join(modules,'react-native-svg')],'lucide-react-native':[path.join(modules,'lucide-react-native')],'classic-level':[path.join(modules,'classic-level')]}};
const host=ts.createCompilerHost(options);
host.resolveModuleNames=(names,origin)=>names.map(name=>{
  let adapter;
  try {adapter=config.resolver.resolveRequest({originModulePath:origin,resolveRequest:()=>null},name,platform);}catch{}
  if(adapter?.filePath)return {resolvedFileName:adapter.filePath,extension:adapter.filePath.endsWith('.tsx')?ts.Extension.Tsx:ts.Extension.Ts};
  return ts.resolveModuleName(name,origin,options,host).resolvedModule;
});
const program=ts.createProgram([path.join(base,'src/App.tsx'),path.join(base,'src/sidecar.ts'),path.join(base,'src/modules.d.ts')],options,host);
const errors=ts.getPreEmitDiagnostics(program);
if(errors.length)console.error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>base,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));
else console.log(`${platform} shared native UI and Agent typecheck passed.`);
process.exitCode=errors.length?1:0;
