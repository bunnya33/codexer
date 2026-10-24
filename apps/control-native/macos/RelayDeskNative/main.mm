#import <AppKit/AppKit.h>
#import <React/RCTBundleURLProvider.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import "DesktopHost.h"
#import "RelayDesktopModule.h"
#import <signal.h>
#import <objc/runtime.h>

static BOOL CXSVGUsesDrawRect(id view,SEL selector){return NO;}
static void CXConfigureSVGDrawing(void){
  // RN macOS Fabric prefers layer updates; SVG renders through drawRect.
  // Add an override only while SVG has no implementation of its own.
  Class svg=NSClassFromString(@"RNSVGSvgView");
  Method inherited=class_getInstanceMethod(NSView.class,@selector(wantsUpdateLayer));
  if(svg&&inherited)class_addMethod(svg,@selector(wantsUpdateLayer),(IMP)CXSVGUsesDrawRect,method_getTypeEncoding(inherited));
}

@interface NativeAppDelegate : RCTDefaultReactNativeFactoryDelegate <NSApplicationDelegate>
@property(nonatomic,strong) RCTReactNativeFactory *factory;
@property(nonatomic,strong) dispatch_source_t terminationSignal;
@end
@implementation NativeAppDelegate
- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {return [self bundleURL];}
- (NSURL *)bundleURL {return [NSBundle.mainBundle URLForResource:@"main" withExtension:@"jsbundle"];}
- (Class)getModuleClassFromName:(const char *)name {
  if(strcmp(name,"RelayDesktop")==0)return RelayDesktopModule.class;
  return [super getModuleClassFromName:name];
}
- (id<RCTTurboModule>)getModuleInstanceFromClass:(Class)moduleClass {
  if(moduleClass==RelayDesktopModule.class)return [RelayDesktopModule new];
  return [super getModuleInstanceFromClass:moduleClass];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSError *error=nil;DesktopHost *host=DesktopHost.shared;
  if(![host start:&error]){
    if(error.code==2)exit(0);
    NSAlert *alert=[NSAlert new];alert.messageText=@"无法启动本机原生客户端";alert.informativeText=@"请确认安装包完整且数据目录可读写。原有设置和登录数据会保留。";[alert runModal];exit(1);
  }
  CXConfigureSVGDrawing();
  self.dependencyProvider=[RCTAppDependencyProvider new];self.factory=[[RCTReactNativeFactory alloc]initWithDelegate:self];
  NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,1280,860) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed=NO;window.title=[host.mode isEqual:@"agent"]?@"Codexer Agent":@"Codexer Control";window.minSize=NSMakeSize(940,680);window.delegate=host;host.window=window;
  window.contentView=[self.factory.rootViewFactory viewWithModuleName:@"RelayDesk"];[window center];
  if(![NSProcessInfo.processInfo.arguments containsObject:@"--background"])[host show];
  signal(SIGTERM,SIG_IGN);self.terminationSignal=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.terminationSignal,^{[DesktopHost.shared shutdown:^{[NSApp terminate:nil];}];});dispatch_resume(self.terminationSignal);
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {[DesktopHost.shared show];return YES;}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {return NO;}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  if(DesktopHost.shared.stopping)return NSTerminateNow;
  [DesktopHost.shared quit];return NSTerminateCancel;
}
@end
int main(int argc,const char *argv[]) {
  @autoreleasepool {NSApplication *app=NSApplication.sharedApplication;__attribute__((objc_precise_lifetime)) NativeAppDelegate *delegate=[NativeAppDelegate new];app.delegate=delegate;[app setActivationPolicy:NSApplicationActivationPolicyRegular];[app run];}
  return 0;
}
