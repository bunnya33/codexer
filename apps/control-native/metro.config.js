const {getDefaultConfig,mergeConfig}=require('@react-native/metro-config');
module.exports=mergeConfig(getDefaultConfig(__dirname),require('./metro.shared.cjs')('windows',__dirname));
