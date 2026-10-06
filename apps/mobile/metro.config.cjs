const { getDefaultConfig } = require("expo/metro-config");
const { existsSync } = require("node:fs");
const { resolve, dirname, sep } = require("node:path");

const config = getDefaultConfig(__dirname);
const packages = resolve(__dirname, "../../packages") + sep;

// 共享包使用 Node ESM 的 .js 导入；Metro 构建时读取对应 TypeScript 源码。
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    context.originModulePath.startsWith(packages) &&
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js")
  ) {
    const source = resolve(dirname(context.originModulePath), moduleName.slice(0, -3) + ".ts");
    if (source.startsWith(packages) && existsSync(source))
      return context.resolveRequest(context, source, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
