require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'CodexerMessages'
  s.version = package['version']
  s.summary = 'Native message selection, context menus and haptics'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Codexer'
  s.homepage = 'https://github.com/bunnya33/codexer'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
