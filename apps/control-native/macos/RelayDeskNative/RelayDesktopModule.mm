#import "RelayDesktopModule.h"
#import "DesktopHost.h"

@implementation RelayDesktopModule
RCT_EXPORT_MODULE(RelayDesktop)
+ (BOOL)requiresMainQueueSetup {return YES;}
- (NSString *)boot {return [DesktopHost.shared boot];}
- (NSString *)randomId {return NSUUID.UUID.UUIDString.lowercaseString;}
- (void)request:(NSString *)method payload:(NSString *)payload resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(),^{
    __weak RelayDesktopModule *weak=self;
    DesktopHost.shared.eventSink=^(NSString *event,id value){
      NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"event":event,@"value":value?:NSNull.null} options:0 error:nil];
      [weak emitOnEvent:[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding]];
    };
    [DesktopHost.shared request:method payload:payload reply:^(id value,NSString *error){
      if(error){reject(@"native-operation-failed",error,nil);return;}
      NSData *data=[NSJSONSerialization dataWithJSONObject:value?:NSNull.null options:NSJSONWritingFragmentsAllowed error:nil];
      resolve([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding]?:@"null");
    }];
  });
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeRelayDesktopSpecJSI>(params);
}
@end
