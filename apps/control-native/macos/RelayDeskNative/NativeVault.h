#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// Versioned encrypt-then-MAC envelope. The key is generated once and held in Keychain.
FOUNDATION_EXPORT NSData *_Nullable CXSeal(NSData *plaintext, NSData *key, NSError **error);
FOUNDATION_EXPORT NSData *_Nullable CXOpen(NSData *envelope, NSData *key, NSError **error);
FOUNDATION_EXPORT NSData *_Nullable CXOpenElectron(NSData *envelope, NSData *password, NSError **error);
FOUNDATION_EXPORT NSData *_Nullable CXVaultKey(NSString *service, BOOL create, NSError **error);
FOUNDATION_EXPORT NSData *_Nullable CXKeychainPassword(NSString *service, NSString *account, NSError **error);
NS_ASSUME_NONNULL_END
