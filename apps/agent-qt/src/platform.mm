#include <QByteArray>
#include <QString>
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#import "../../control-native/macos/RelayDeskNative/NativeVault.h"
QByteArray platformVault(const QByteArray &bytes, bool encrypt, QString &error) {
  @autoreleasepool {
    NSData *input = [NSData dataWithBytes:bytes.constData() length:bytes.size()]; NSError *failure = nil; NSData *output = nil;
    if (!encrypt && bytes.startsWith("v10")) {
      for (NSString *product in @[@"@codexer/desktop", @"Codexer", @"Codexer Agent"]) {
        NSData *password = CXKeychainPassword([product stringByAppendingString:@" Safe Storage"], product, &failure);
        if (password) {output = CXOpenElectron(input, password, &failure); break;}
        if (failure.code != errSecItemNotFound) break;
      }
    } else {
      NSData *key = CXVaultKey(@"com.codexer.connector.NativeVault", encrypt, &failure);
      if (key) output = encrypt ? CXSeal(input, key, &failure) : CXOpen(input, key, &failure);
    }
    if (!output) {error = "secure-storage-unavailable"; return {};}
    return QByteArray(static_cast<const char *>(output.bytes), output.length);
  }
}
bool platformLoginItem(bool enabled, QString &error) {
  @autoreleasepool {
    NSError *failure = nil; SMAppService *service = SMAppService.mainAppService;
    if (enabled && service.status != SMAppServiceStatusEnabled && service.status != SMAppServiceStatusRequiresApproval) [service registerAndReturnError:&failure];
    if (!enabled && service.status != SMAppServiceStatusNotRegistered) [service unregisterAndReturnError:&failure];
    if (failure) {error = "login-item-save-failed"; return false;} return true;
  }
}
