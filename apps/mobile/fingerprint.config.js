module.exports = {
  // Native sources are Expo plugins and local modules. The generated projects
  // also contain each machine's signing, caches and build output.
  ignorePaths: [
    "/ios",
    "/android",
    "**/expo-updates-gradle-plugin/.kotlin/**/*",
  ],
  sourceSkips: ["PackageJsonScriptsAll"],
};
