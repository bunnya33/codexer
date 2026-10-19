const ts=require('typescript');
const path=require('node:path');
const base=__dirname;
const config=require('./metro.config');
const options={target:ts.ScriptTarget.ES2023,lib:["lib.es2024.d.ts","lib.dom.d.ts"],module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,strict:true,skipLibCheck:true,noEmit:true,esModuleInterop:true,resolveJsonModule:true,allowSyntheticDefaultImports:true,types:['react','node'],typeRoots:[path.join(base,'node_modules/@types'),path.join(base,'../../node_modules/@types')],baseUrl:base,ignoreDeprecations:'6.0',paths:{react:['node_modules/@types/react'],'react/*':['node_modules/@types/react/*'],'react-native':['node_modules/react-native-windows'], 'react-native-svg':['node_modules/react-native-svg'], 'lucide-react-native':['node_modules/lucide-react-native']}};
const host=ts.createCompilerHost(options);
host.resolveModuleNames=(names,origin)=>names.map(name=>{
  let adapter;
  try {adapter=config.resolver.resolveRequest({originModulePath:origin,resolveRequest:()=>null},name,'windows');}catch{}
  if(adapter?.filePath)return {resolvedFileName:adapter.filePath,extension:adapter.filePath.endsWith('.tsx')?ts.Extension.Tsx:ts.Extension.Ts};
  return ts.resolveModuleName(name,origin,options,host).resolvedModule;
});
const program=ts.createProgram([path.join(base,'src/App.tsx'),path.join(base,'src/sidecar.ts'),path.join(base,'src/modules.d.ts')],options,host);
const errors=ts.getPreEmitDiagnostics(program);
if(errors.length)console.error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>base,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));
process.exitCode=errors.length?1:0;
