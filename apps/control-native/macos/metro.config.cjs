process.env.CODEXER_NATIVE_PLATFORM='macos';
const {getDefaultConfig,mergeConfig}=require('@react-native/metro-config');
module.exports=mergeConfig(getDefaultConfig(__dirname),require('../metro.shared.cjs')('macos',__dirname));
