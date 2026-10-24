const path = require('node:path');

// Both desktop hosts resolve the same UI and mobile adapters. Only the runtime
// dependency directory and genuinely platform-specific adapters differ.
module.exports = function desktopConfig(platform, dependencyRoot) {
  const app = __dirname;
  const root = path.resolve(app, '../..');
  const runtime = platform === 'macos' ? 'react-native-macos' : 'react-native-windows';
  const adapters = new Set(['runtime','attachment-picker','file-download','preview-storage','selection-storage','theme-storage','theme-platform','image-viewer','effort-slider','preview-range','preview-surface','audio-player','build-info','conversation-viewport','control-settings','composer-popover','client-updates','client-platform-settings']);
  const components = new Set(['image-viewer','effort-slider','preview-range','preview-surface','audio-player','conversation-viewport','control-settings','composer-popover','client-platform-settings']);
  const modules = {'react-native-safe-area-context':'safe-area.tsx','expo-status-bar':'status-bar.tsx','expo-image-picker':'image-picker.ts','expo-image-manipulator':'image-manipulator.ts','react-native-gesture-handler':'gesture-root.tsx'};
  const modal = path.join(app, 'src/adapters', platform === 'macos' ? 'modal.macos.tsx' : 'modal.tsx');
  const runtimeRoot = path.dirname(require.resolve(runtime + '/package.json', {paths:[dependencyRoot]}));
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    projectRoot: app,
    watchFolders: [path.join(root,'apps/mobile'),path.join(root,'packages'),dependencyRoot],
    resolver: {
      disableHierarchicalLookup:true,
      nodeModulesPaths:[path.join(dependencyRoot,'node_modules')],
      resolveRequest(context,name,target) {
        if(modules[name]) return {type:'sourceFile',filePath:path.join(app,'src/adapters',modules[name])};
        const origin=context.originModulePath.replaceAll('\\','/');
        const key=path.basename(name).replace(/\.(tsx?|jsx?)$/,'');
        if(origin.includes('/apps/mobile/') && name.startsWith('.') && adapters.has(key)) return {type:'sourceFile',filePath:path.join(app,'src/adapters',key+(components.has(key)?'.tsx':'.ts'))};
        if(name==='react-native'||name.startsWith('react-native/')) return context.resolveRequest(context,name.replace(/^react-native/,runtime),target);
        if(name.startsWith('.') && name.endsWith('.js') && origin.includes('/packages/')) return context.resolveRequest(context,name.slice(0,-3),target);
        const resolved=context.resolveRequest(context,name,target);
        if(resolved?.type==='sourceFile' && /\/Libraries\/Modal\/Modal(?:\.windows)?\.js$/.test(resolved.filePath.replaceAll('\\','/')) && !origin.endsWith('/src/adapters/modal.tsx') && !origin.endsWith('/src/adapters/modal.macos.tsx')) return {type:'sourceFile',filePath:modal};
        return resolved;
      },
      blockList:[new RegExp(escaped(path.join(app,'windows').replaceAll('\\','/'))+'.*'),new RegExp(escaped(runtimeRoot.replaceAll('\\','/'))+'/(build|target)/.*'),/.*\.ProjectImports\.zip/],
    },
    transformer:{getTransformOptions:async()=>({transform:{experimentalImportSupport:false,inlineRequires:true}})},
  };
};
