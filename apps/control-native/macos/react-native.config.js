module.exports={
  reactNativePath:require('node:path').dirname(require.resolve('react-native-macos/package.json')),
  project:{macos:{sourceDir:'.',xcodeProject:{name:'RelayDeskNative.xcodeproj',isWorkspace:false}}},
};
