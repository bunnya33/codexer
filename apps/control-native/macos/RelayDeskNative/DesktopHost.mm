#import "DesktopHost.h"
#import "NativeVault.h"
#import <ServiceManagement/ServiceManagement.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <sys/file.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>

static NSString *Encode(id value) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
  return data?[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding]:@"null";
}
static id Decode(NSString *value) {
  return [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingFragmentsAllowed error:nil];
}
@interface DesktopHost ()
@property(nonatomic,strong) NSTask *task;
@property(nonatomic,strong) NSFileHandle *input;
@property(nonatomic,strong) NSStatusItem *statusItem;
@property(nonatomic,strong) NSMutableDictionary<NSNumber *,CXReply> *pending;
@property(nonatomic,strong) NSMutableDictionary<NSString *,NSWindow *> *previews;
@property(nonatomic,strong) NSMutableDictionary<NSString *,WKWebView *> *webviews;
@property(nonatomic,strong) NSMutableDictionary<NSString *,id> *earlyEvents;
@property(nonatomic) NSInteger sequence;
@property(nonatomic) NSInteger activeTasks;
@property(nonatomic) BOOL closeExits;
@property(nonatomic,readwrite) BOOL stopping;
@property(nonatomic) BOOL showingQuit;
@property(nonatomic) int lockFile;
@property(nonatomic,strong) id scrollMonitor;
@end
@implementation DesktopHost
+ (instancetype)shared {static DesktopHost *host;static dispatch_once_t once;dispatch_once(&once,^{host=[DesktopHost new];});return host;}
- (instancetype)init {if((self=[super init])){_pending=[NSMutableDictionary new];_previews=[NSMutableDictionary new];_webviews=[NSMutableDictionary new];_earlyEvents=[NSMutableDictionary new];_lockFile=-1;}return self;}
- (void)setEventSink:(void (^)(NSString *,id))sink {
  _eventSink=[sink copy];
  if(sink){NSDictionary *queued=[self.earlyEvents copy];[self.earlyEvents removeAllObjects];for(NSString *event in queued)sink(event,queued[event]);}
}
- (void)emit:(NSString *)event value:(id)value {
  NSAssert(NSThread.isMainThread,@"Host events must use main queue");
  if(self.eventSink)self.eventSink(event,value?:NSNull.null);
  else if(self.earlyEvents.count<32)self.earlyEvents[event]=value?:NSNull.null;
}
- (NSString *)boot {return Encode(@{@"mode":self.mode,@"version":self.version,@"closeExits":@(self.closeExits),@"serverUrl":@""});}
- (BOOL)start:(NSError **)error {
  NSDictionary *environment=NSProcessInfo.processInfo.environment;
  NSString *override=environment[@"CODEXER_NATIVE_MODE"];
  self.mode=([override isEqual:@"agent"]||[override isEqual:@"control"])?override:(NSBundle.mainBundle.infoDictionary[@"CodexerNativeMode"]?:@"agent");
  self.version=NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"]?:@"development";
  self.profile=environment[@"CODEXER_NATIVE_DATA_DIR"]?:[NSHomeDirectory() stringByAppendingPathComponent:[@"Library/Application Support/@codexer" stringByAppendingPathComponent:[self.mode isEqual:@"agent"]?@"desktop":@"control-desktop"]];
  if(![NSFileManager.defaultManager createDirectoryAtPath:self.profile withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:error])return NO;
  self.lockFile=open([[self.profile stringByAppendingPathComponent:@"native-instance.lock"] fileSystemRepresentation],O_CREAT|O_RDWR,0600);
  if(self.lockFile<0||flock(self.lockFile,LOCK_EX|LOCK_NB)!=0){
    for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)if(app.processIdentifier!=NSProcessInfo.processInfo.processIdentifier && [app.bundleIdentifier isEqual:NSBundle.mainBundle.bundleIdentifier])[app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    if(error)*error=[NSError errorWithDomain:@"CodexerNative" code:2 userInfo:@{NSLocalizedDescriptionKey:@"already-running"}];return NO;
  }
  NSString *resources=NSBundle.mainBundle.resourcePath;
  self.task=[NSTask new];self.task.executableURL=[NSURL fileURLWithPath:[resources stringByAppendingPathComponent:@"runtime/node"]];
  self.task.arguments=@[[resources stringByAppendingPathComponent:@"service/sidecar.cjs"]];
  NSMutableDictionary *childEnvironment=[environment mutableCopy];childEnvironment[@"CODEXER_NATIVE_MODE"]=self.mode;
  // Both old and native Mac clients use the same profile. The test override is
  // only propagated when explicitly set, so normal login items are preserved.
  self.task.environment=childEnvironment;
  self.task.currentDirectoryURL=[NSURL fileURLWithPath:resources];
  NSPipe *input=[NSPipe pipe],*output=[NSPipe pipe];self.input=input.fileHandleForWriting;
  self.task.standardInput=input;self.task.standardOutput=output;self.task.standardError=NSFileHandle.fileHandleWithNullDevice;
  __weak DesktopHost *weak=self;NSMutableData *buffer=[NSMutableData new];
  output.fileHandleForReading.readabilityHandler=^(NSFileHandle *handle){
    NSData *data=handle.availableData;if(!data.length){handle.readabilityHandler=nil;return;}
    @synchronized(buffer){
      [buffer appendData:data];
      if(buffer.length>20*1024*1024){[buffer setLength:0];dispatch_async(dispatch_get_main_queue(),^{[weak backendFailed];});return;}
      for(;;){const void *newline=memchr(buffer.bytes,'\n',buffer.length);if(!newline)break;NSUInteger length=(const uint8_t *)newline-(const uint8_t *)buffer.bytes;
        NSData *line=[buffer subdataWithRange:NSMakeRange(0,length)];[buffer replaceBytesInRange:NSMakeRange(0,length+1) withBytes:nullptr length:0];
        NSDictionary *message=[NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if([message isKindOfClass:NSDictionary.class])dispatch_async(dispatch_get_main_queue(),^{[weak receive:message];});
      }
    }
  };
  self.task.terminationHandler=^(NSTask *task){dispatch_async(dispatch_get_main_queue(),^{if(!weak.stopping)[weak backendFailed];});};
  if(![self.task launchAndReturnError:error])return NO;
  [self configureMenus];
  self.scrollMonitor=[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event){
    DesktopHost *host=weak;
    if(event.window==host.window && fabs(event.scrollingDeltaY)>.1)[host emit:@"scrollIntent" value:@{@"direction":event.scrollingDeltaY>0?@"up":@"down"}];
    return event;
  }];
  return YES;
}
- (void)backendFailed {
  for(CXReply reply in self.pending.allValues)reply(nil,@"native-service-unavailable");[self.pending removeAllObjects];
  [self emit:@"backendError" value:@"native-service-failed"];
}
- (void)send:(NSDictionary *)value {
  NSData *bytes=[[Encode(value) stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  @try {[self.input writeData:bytes];} @catch(NSException *exception){[self backendFailed];}
}
- (void)request:(NSString *)method payload:(NSString *)payload reply:(CXReply)reply {
  if(!NSThread.isMainThread){dispatch_async(dispatch_get_main_queue(),^{[self request:method payload:payload reply:reply];});return;}
  id value=Decode(payload);
  if(![value isKindOfClass:NSDictionary.class]||payload.length>16*1024*1024){reply(nil,@"invalid-native-request");return;}
  if(!self.task.running){reply(nil,@"native-service-unavailable");return;}
  NSNumber *identifier=@(++self.sequence);self.pending[identifier]=[reply copy];
  [self send:@{@"id":identifier,@"method":method,@"value":value}];
}
- (void)receive:(NSDictionary *)message {
  NSNumber *nativeId=message[@"nativeId"];
  if(nativeId){
    [self platform:message[@"method"] value:message[@"value"]?:@{} reply:^(id value,NSString *error){NSMutableDictionary *reply=[@{@"nativeId":nativeId} mutableCopy];if(error)reply[@"error"]=error;else reply[@"value"]=value?:NSNull.null;[self send:reply];}];return;
  }
  NSNumber *identifier=message[@"id"];
  if(identifier){CXReply pending=self.pending[identifier];[self.pending removeObjectForKey:identifier];if(pending)pending(message[@"value"],message[@"error"]);return;}
  NSString *event=message[@"event"];id value=message[@"value"];
  if(![event isKindOfClass:NSString.class])return;
  if([event isEqual:@"activeTasks"] && [value respondsToSelector:@selector(integerValue)])self.activeTasks=[value integerValue];
  if([event isEqual:@"preferences"] && [value isKindOfClass:NSDictionary.class])self.closeExits=[value[@"closeExits"] boolValue];
  [self emit:event value:value];
}
- (void)configureMenus {
  NSMenu *bar=[NSMenu new],*application=[NSMenu new],*edit=[[NSMenu alloc]initWithTitle:@"编辑"];
  NSMenuItem *appItem=[NSMenuItem new];[bar addItem:appItem];appItem.submenu=application;
  for(NSArray *entry in @[@[@"显示窗口",NSStringFromSelector(@selector(show)),@"0"],@[@"设置…",NSStringFromSelector(@selector(showSettings)),@","],@[@"退出",NSStringFromSelector(@selector(quit)),@"q"]]){
    NSMenuItem *item=[[NSMenuItem alloc]initWithTitle:entry[0] action:NSSelectorFromString(entry[1]) keyEquivalent:entry[2]];item.target=self;[application addItem:item];
  }
  NSMenuItem *editItem=[[NSMenuItem alloc]initWithTitle:@"编辑" action:nil keyEquivalent:@""];editItem.submenu=edit;[bar addItem:editItem];
  for(NSArray *entry in @[@[@"撤销",@"undo:",@"z"],@[@"重做",@"redo:",@"Z"],@[@"剪切",@"cut:",@"x"],@[@"复制",@"copy:",@"c"],@[@"粘贴",@"paste:",@"v"],@[@"全选",@"selectAll:",@"a"]]) [edit addItem:[[NSMenuItem alloc]initWithTitle:entry[0] action:NSSelectorFromString(entry[1]) keyEquivalent:entry[2]]];
  NSApp.mainMenu=bar;
  self.statusItem=[NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
  self.statusItem.button.image=[NSImage imageWithSystemSymbolName:[self.mode isEqual:@"agent"]?@"desktopcomputer":@"bubble.left.and.bubble.right" accessibilityDescription:[self.mode isEqual:@"agent"]?@"Codexer PC Agent":@"RelayDesk"];
  NSMenu *tray=[application copy];self.statusItem.menu=tray;
}
- (void)show {[self.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];}
- (void)showSettings {[self show];[self emit:@"openSettings" value:NSNull.null];}
- (BOOL)windowShouldClose:(NSWindow *)window {
  if(window!=self.window)return YES;
  if(self.stopping)return YES;
  if(self.closeExits)[self quit];else [window orderOut:nil];return NO;
}
- (void)quit {
  if(self.showingQuit||self.stopping)return;self.showingQuit=YES;
  NSAlert *alert=[NSAlert new];alert.messageText=@"退出客户端？";
  alert.informativeText=self.activeTasks>0?@"本机仍有任务运行。退出会停止由连接器启动的本机运行服务。":@"退出后将停止本机连接。关闭窗口可以继续在菜单栏后台运行。";
  [alert addButtonWithTitle:@"取消"];[alert addButtonWithTitle:@"退出"];
  NSModalResponse response=[alert runModal];self.showingQuit=NO;
  if(response==NSAlertSecondButtonReturn)[self shutdown:^{[NSApp terminate:nil];}];
}
- (void)shutdown:(dispatch_block_t)completion {
  if(self.stopping){completion();return;}self.stopping=YES;
  __block BOOL finished=NO;dispatch_block_t finish=^{if(finished)return;finished=YES;if(self.task.running)[self.task terminate];[self.input closeFile];if(self.scrollMonitor)[NSEvent removeMonitor:self.scrollMonitor];if(self.lockFile>=0){flock(self.lockFile,LOCK_UN);close(self.lockFile);self.lockFile=-1;}completion();};
  if(!self.task.running){finish();return;}
  [self request:@"shutdown" payload:@"{}" reply:^(id value,NSString *error){finish();}];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC),dispatch_get_main_queue(),finish);
}
- (void)windowWillClose:(NSNotification *)notification {
  NSWindow *window=notification.object;NSString *found=nil;
  for(NSString *identifier in self.previews)if(self.previews[identifier]==window){found=identifier;break;}
  if(found){WKWebView *web=self.webviews[found];[web stopLoading];[web.configuration.userContentController removeScriptMessageHandlerForName:@"codexer"];web.navigationDelegate=nil;web.UIDelegate=nil;[self.previews removeObjectForKey:found];[self.webviews removeObjectForKey:found];[self emit:@"previewClosed" value:@{@"id":found}];}
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if(!message.frameInfo.mainFrame||![message.body isKindOfClass:NSString.class]||[(NSString *)message.body length]>2*1024*1024)return;
  for(NSString *identifier in self.webviews)if(self.webviews[identifier]==message.webView){[self emit:@"previewMessage" value:@{@"id":identifier,@"data":message.body}];break;}
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
  NSURL *url=action.request.URL;BOOL local=[url.scheme isEqual:@"about"]||[url.scheme isEqual:@"data"];
  BOOL subframe=action.targetFrame && !action.targetFrame.mainFrame && ([url.scheme isEqual:@"http"]||[url.scheme isEqual:@"https"]);
  decision(local||subframe?WKNavigationActionPolicyAllow:WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decision {decision(WKPermissionDecisionDeny);}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {return nil;}
- (void)platform:(NSString *)method value:(NSDictionary *)value reply:(CXReply)reply {
  @try {
    if([method isEqual:@"protect"]||[method isEqual:@"unprotect"]){
      NSData *input=[[NSData alloc]initWithBase64EncodedString:value[@"value"] options:0];NSError *error=nil;NSData *output=nil;
      if(!input || input.length>65636){reply(nil,@"invalid-vault-input");return;}
      if([method isEqual:@"unprotect"] && input.length>=3 && memcmp(input.bytes,"v10",3)==0){
        NSString *product=[self.mode isEqual:@"agent"]?@"Codexer":@"RelayDesk";
        NSData *password=CXKeychainPassword([product stringByAppendingString:@" Safe Storage"],product,&error);
        if(password)output=CXOpenElectron(input,password,&error);
      }else{NSData *key=CXVaultKey([NSBundle.mainBundle.bundleIdentifier stringByAppendingString:@".NativeVault"],[method isEqual:@"protect"],&error);if(key)output=[method isEqual:@"protect"]?CXSeal(input,key,&error):CXOpen(input,key,&error);}
      reply(output?[output base64EncodedStringWithOptions:0]:nil,output?nil:(error.localizedDescription?:@"secure-storage-unavailable"));return;
    }
    if([method isEqual:@"loginItem"]){
      if(NSProcessInfo.processInfo.environment[@"CODEXER_NATIVE_DATA_DIR"]){reply(@YES,nil);return;}
      BOOL enabled=[value[@"enabled"] boolValue];SMAppService *service=SMAppService.mainAppService;NSError *error=nil;
      if(enabled && service.status!=SMAppServiceStatusEnabled && service.status!=SMAppServiceStatusRequiresApproval)[service registerAndReturnError:&error];
      if(!enabled && service.status!=SMAppServiceStatusNotRegistered)[service unregisterAndReturnError:&error];
      reply(error?nil:@YES,error?@"login-item-update-failed":nil);return;
    }
    if([method isEqual:@"clipboard.write"]){[NSPasteboard.generalPasteboard clearContents];reply(@([NSPasteboard.generalPasteboard setString:value[@"value"]?:@"" forType:NSPasteboardTypeString]),nil);return;}
    if([method isEqual:@"confirm"]){NSAlert *alert=[NSAlert new];alert.messageText=value[@"title"]?:@"确认";alert.informativeText=value[@"message"]?:@"";[alert addButtonWithTitle:@"取消"];[alert addButtonWithTitle:@"确认"];reply(@([alert runModal]==NSAlertSecondButtonReturn),nil);return;}
    if([method isEqual:@"openUrl"]){NSURL *url=[NSURL URLWithString:value[@"url"]?:@""];BOOL allowed=[@[@"https",@"http",@"mailto"] containsObject:url.scheme.lowercaseString];reply(allowed?@([NSWorkspace.sharedWorkspace openURL:url]):nil,allowed?nil:@"invalid-url");return;}
    if([method isEqual:@"pick"]||[method isEqual:@"saveDialog"]){
      BOOL save=[method isEqual:@"saveDialog"];NSString *kind=value[@"kind"]?:@"files";
      NSSavePanel *panel=save?[NSSavePanel savePanel]:[NSOpenPanel openPanel];panel.canCreateDirectories=YES;
      if(save)panel.nameFieldStringValue=[value[@"name"]?:@"download" lastPathComponent];
      else{NSOpenPanel *open=(NSOpenPanel *)panel;BOOL folder=[@[@"folder",@"home",@"project"] containsObject:kind];open.canChooseDirectories=folder;open.canChooseFiles=!folder;open.allowsMultipleSelection=[value[@"multiple"] boolValue];if([kind isEqual:@"images"])open.allowedContentTypes=@[UTTypeImage];}
      [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response){if(response!=NSModalResponseOK){reply(save?@"":@[],nil);return;}if(save)reply(panel.URL.path,nil);else{NSMutableArray *paths=[NSMutableArray new];for(NSURL *url in ((NSOpenPanel *)panel).URLs)[paths addObject:url.path];reply(paths,nil);}}];return;
    }
    if([method isEqual:@"image.convert"]){
      NSString *path=value[@"path"];NSImage *image=[[NSImage alloc]initWithContentsOfFile:path];
      if(!image){reply(nil,@"invalid-image");return;}
      CGImageRef cg=[image CGImageForProposedRect:nullptr context:nil hints:nil];if(!cg){reply(nil,@"invalid-image");return;}
      double width=CGImageGetWidth(cg),height=CGImageGetHeight(cg),edge=MIN(4096,MAX(1,[value[@"edge"] doubleValue]));
      if(width*height>100000000){reply(nil,@"image-too-large");return;}
      double scale=MIN(1,edge/MAX(width,height));NSInteger w=MAX(1,lround(width*scale)),h=MAX(1,lround(height*scale));
      NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc]initWithBitmapDataPlanes:nullptr pixelsWide:w pixelsHigh:h bitsPerSample:8 samplesPerPixel:3 hasAlpha:NO isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
      [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];[NSColor.whiteColor setFill];NSRectFill(NSMakeRect(0,0,w,h));[image drawInRect:NSMakeRect(0,0,w,h) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];[NSGraphicsContext restoreGraphicsState];
      NSData *jpeg=[bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@(MIN(1,MAX(.1,[value[@"quality"] doubleValue])))}];
      reply(jpeg?@{@"base64":[jpeg base64EncodedStringWithOptions:0],@"width":@(w),@"height":@(h)}:nil,jpeg?nil:@"image-conversion-failed");return;
    }
    if([method isEqual:@"window.theme"]){BOOL dark=[value[@"dark"] boolValue];self.window.appearance=[NSAppearance appearanceNamed:dark?NSAppearanceNameDarkAqua:NSAppearanceNameAqua];NSUInteger rgb=[value[@"background"] unsignedIntegerValue];self.window.backgroundColor=[NSColor colorWithSRGBRed:((rgb>>16)&255)/255.0 green:((rgb>>8)&255)/255.0 blue:(rgb&255)/255.0 alpha:1];reply(@YES,nil);return;}
    if([method isEqual:@"preview.open"]){
      NSString *identifier=value[@"id"];NSString *html=value[@"html"];
      if(![identifier isKindOfClass:NSString.class]||!identifier.length||identifier.length>100||![html isKindOfClass:NSString.class]||html.length>3*1024*1024){reply(nil,@"invalid-preview");return;}
      if(self.previews[identifier]){[self.previews[identifier] makeKeyAndOrderFront:nil];reply(@YES,nil);return;}
      WKWebViewConfiguration *configuration=[WKWebViewConfiguration new];configuration.websiteDataStore=WKWebsiteDataStore.nonPersistentDataStore;configuration.mediaTypesRequiringUserActionForPlayback=WKAudiovisualMediaTypeNone;
      [configuration.userContentController addScriptMessageHandler:self name:@"codexer"];
      [configuration.userContentController addUserScript:[[WKUserScript alloc]initWithSource:@"window.ReactNativeWebView={postMessage:m=>window.webkit.messageHandlers.codexer.postMessage(String(m))};" injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
      WKWebView *web=[[WKWebView alloc]initWithFrame:NSMakeRect(0,0,1050,780) configuration:configuration];web.navigationDelegate=self;web.UIDelegate=self;
      NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,1050,780) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;window.title=value[@"title"]?:@"内容预览";window.delegate=self;window.contentView=web;
      self.previews[identifier]=window;self.webviews[identifier]=web;[web loadHTMLString:html baseURL:nil];[window center];[window makeKeyAndOrderFront:nil];reply(@YES,nil);return;
    }
    if([method isEqual:@"preview.close"]){[self.previews[value[@"id"]] close];reply(@YES,nil);return;}
    if([method isEqual:@"preview.send"]){WKWebView *web=self.webviews[value[@"id"]];if(web){NSString *encoded=Encode(value[@"message"]?:NSNull.null);encoded=[encoded stringByReplacingOccurrencesOfString:@"\u2028" withString:@"\\u2028"];encoded=[encoded stringByReplacingOccurrencesOfString:@"\u2029" withString:@"\\u2029"];[web evaluateJavaScript:[@"window.codexerPreviewSend?.(" stringByAppendingFormat:@"%@)",encoded] completionHandler:nil];}reply(@YES,nil);return;}
    reply(nil,@"unknown-macos-operation");
  } @catch(NSException *exception){reply(nil,@"macos-operation-failed");}
}
@end
