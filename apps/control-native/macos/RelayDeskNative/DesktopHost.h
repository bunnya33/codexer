#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN
typedef void (^CXReply)(id _Nullable value, NSString *_Nullable error);
@interface DesktopHost : NSObject <NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,copy) NSString *mode;
@property(nonatomic,copy) NSString *version;
@property(nonatomic,copy) NSString *profile;
@property(nonatomic,copy,nullable) void (^eventSink)(NSString *, id);
@property(nonatomic,readonly) BOOL stopping;
+ (instancetype)shared;
- (BOOL)start:(NSError **)error;
- (NSString *)boot;
- (void)request:(NSString *)method payload:(NSString *)payload reply:(CXReply)reply;
- (void)show;
- (void)showSettings;
- (void)quit;
- (void)shutdown:(dispatch_block_t)completion;
@end
NS_ASSUME_NONNULL_END
