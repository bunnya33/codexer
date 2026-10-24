const path=require('node:path');
const dependencies=process.env.CODEXER_NATIVE_PLATFORM==='macos'?path.join(__dirname,'macos'):__dirname;
module.exports={presets:[require.resolve('@react-native/babel-preset',{paths:[dependencies]})],plugins:[require.resolve('@babel/plugin-transform-export-namespace-from',{paths:[dependencies]})]};
