const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const fs = require('fs');
const path = require('node:path');

const rnwPath = fs.realpathSync(
  path.resolve(require.resolve('react-native-windows/package.json'), '..'),
);

//

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */

const root = path.resolve(__dirname, '../..');
const adapters = new Set(['runtime','attachment-picker','file-download','preview-storage','selection-storage','image-viewer','effort-slider','preview-range','preview-surface','audio-player','build-info','conversation-viewport','control-settings','composer-popover']);
const modules = {'react-native-safe-area-context':'safe-area.tsx','expo-status-bar':'status-bar.tsx','expo-image-picker':'image-picker.ts','expo-image-manipulator':'image-manipulator.ts','react-native-gesture-handler':'gesture-root.tsx'};
const config = {
  watchFolders:[path.join(root,'apps/mobile'),path.join(root,'packages')],
  //
  resolver: {
    disableHierarchicalLookup:true,
    nodeModulesPaths:[path.join(__dirname,'node_modules')],
    resolveRequest(context,name,platform){
      if(modules[name]) return {type:'sourceFile',filePath:path.join(__dirname,'src/adapters',modules[name])};
      const mobile=context.originModulePath.replaceAll('\\','/').includes('/apps/mobile/');
      const key=path.basename(name).replace(/\.(tsx?|jsx?)$/,'');
      if(mobile && name.startsWith('.') && adapters.has(key)) return {type:'sourceFile',filePath:path.join(__dirname,'src/adapters',key+(['image-viewer','effort-slider','preview-range','preview-surface','audio-player','conversation-viewport','control-settings','composer-popover'].includes(key)?'.tsx':'.ts'))};
      if(name==='react-native'||name.startsWith('react-native/')) return context.resolveRequest(context,name.replace(/^react-native/,'react-native-windows'),platform);
      if(name.startsWith('.') && name.endsWith('.js') && context.originModulePath.replaceAll('\\','/').includes('/packages/')) return context.resolveRequest(context,name.slice(0,-3),platform);
      const resolved=context.resolveRequest(context,name,platform);
      if(resolved.type==='sourceFile'&&/\/Libraries\/Modal\/Modal\.windows\.js$/.test(resolved.filePath.replaceAll('\\','/'))&&!context.originModulePath.replaceAll('\\','/').endsWith('/src/adapters/modal.tsx'))return {type:'sourceFile',filePath:path.join(__dirname,'src/adapters/modal.tsx')};
      return resolved;
    },
    blockList: [
      // This stops "npx @react-native-community/cli run-windows" from causing the metro server to crash if its already running
      new RegExp(
        `${path.resolve(__dirname, 'windows').replace(/[/\\]/g, '/')}.*`,
      ),
      // This prevents "npx @react-native-community/cli run-windows" from hitting: EBUSY: resource busy or locked, open msbuild.ProjectImports.zip or other files produced by msbuild
      new RegExp(`${rnwPath}/build/.*`),
      new RegExp(`${rnwPath}/target/.*`),
      /.*\.ProjectImports\.zip/,
    ],
    //
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
