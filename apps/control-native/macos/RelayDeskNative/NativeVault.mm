#import "NativeVault.h"
#import <Security/Security.h>
#import <CommonCrypto/CommonCrypto.h>

static NSData *Fail(NSError **error, NSString *code) {
  if(error) *error=[NSError errorWithDomain:@"CodexerVault" code:1 userInfo:@{NSLocalizedDescriptionKey:code}];
  return nil;
}
static NSData *Crypt(NSData *input, const void *key, size_t keyLength, const void *iv, CCOperation operation, NSError **error) {
  NSMutableData *output=[NSMutableData dataWithLength:input.length+kCCBlockSizeAES128];
  size_t written=0;
  if(CCCrypt(operation,kCCAlgorithmAES,kCCOptionPKCS7Padding,key,keyLength,iv,input.bytes,input.length,output.mutableBytes,output.length,&written)!=kCCSuccess) return Fail(error,@"credential-decrypt-failed");
  output.length=written;return output;
}
static void VaultKeys(NSData *master, uint8_t encryption[32], uint8_t authentication[32]) {
  static const char encryptionLabel[]="Codexer native vault encryption v1";
  static const char authenticationLabel[]="Codexer native vault authentication v1";
  CCHmac(kCCHmacAlgSHA256,master.bytes,master.length,encryptionLabel,sizeof(encryptionLabel)-1,encryption);
  CCHmac(kCCHmacAlgSHA256,master.bytes,master.length,authenticationLabel,sizeof(authenticationLabel)-1,authentication);
}
NSData *CXSeal(NSData *plaintext, NSData *key, NSError **error) {
  if(key.length!=64 || plaintext.length>65536) return Fail(error,@"invalid-vault-input");
  uint8_t iv[16];
  if(SecRandomCopyBytes(kSecRandomDefault,sizeof(iv),iv)!=errSecSuccess) return Fail(error,@"secure-random-unavailable");
  uint8_t encryption[32],authentication[32];VaultKeys(key,encryption,authentication);
  NSData *cipher=Crypt(plaintext,encryption,sizeof(encryption),iv,kCCEncrypt,error);if(!cipher)return nil;
  NSMutableData *sealed=[NSMutableData dataWithBytes:"CXN1" length:4];
  [sealed appendBytes:iv length:sizeof(iv)];[sealed appendData:cipher];
  uint8_t tag[CC_SHA256_DIGEST_LENGTH];
  CCHmac(kCCHmacAlgSHA256,authentication,sizeof(authentication),sealed.bytes,sealed.length,tag);
  [sealed appendBytes:tag length:sizeof(tag)];return sealed;
}
NSData *CXOpen(NSData *envelope, NSData *key, NSError **error) {
  if(key.length!=64 || envelope.length<68 || envelope.length>65636 || memcmp(envelope.bytes,"CXN1",4)!=0 || (envelope.length-52)%16!=0) return Fail(error,@"invalid-vault-envelope");
  uint8_t expected[CC_SHA256_DIGEST_LENGTH],encryption[32],authentication[32];VaultKeys(key,encryption,authentication);
  CCHmac(kCCHmacAlgSHA256,authentication,sizeof(authentication),envelope.bytes,envelope.length-sizeof(expected),expected);
  const uint8_t *received=((const uint8_t *)envelope.bytes)+envelope.length-sizeof(expected);
  uint8_t difference=0;for(size_t n=0;n<sizeof(expected);n++)difference|=expected[n]^received[n];
  if(difference)return Fail(error,@"credential-authentication-failed");
  return Crypt([envelope subdataWithRange:NSMakeRange(20,envelope.length-52)],encryption,sizeof(encryption),((const uint8_t *)envelope.bytes)+4,kCCDecrypt,error);
}
NSData *CXOpenElectron(NSData *envelope, NSData *password, NSError **error) {
  if(envelope.length<19 || envelope.length>65636 || memcmp(envelope.bytes,"v10",3)!=0 || (envelope.length-3)%16!=0 || !password.length)return Fail(error,@"unsupported-legacy-credential");
  uint8_t key[16],iv[16];memset(iv,' ',sizeof(iv));
  if(CCKeyDerivationPBKDF(kCCPBKDF2,(const char *)password.bytes,password.length,(const uint8_t *)"saltysalt",sizeof("saltysalt")-1,kCCPRFHmacAlgSHA1,1003,key,sizeof(key))!=kCCSuccess)return Fail(error,@"legacy-key-derivation-failed");
  NSData *result=Crypt([envelope subdataWithRange:NSMakeRange(3,envelope.length-3)],key,sizeof(key),iv,kCCDecrypt,error);
  memset(key,0,sizeof(key));return result;
}
NSData *CXKeychainPassword(NSString *service, NSString *account, NSError **error) {
  NSDictionary *query=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,(__bridge id)kSecAttrService:service,(__bridge id)kSecAttrAccount:account,(__bridge id)kSecReturnData:@YES,(__bridge id)kSecMatchLimit:(__bridge id)kSecMatchLimitOne};
  CFTypeRef value=nullptr;OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)query,&value);
  if(status!=errSecSuccess){if(error)*error=[NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:@{NSLocalizedDescriptionKey:@"keychain-access-failed"}];return nil;}
  return CFBridgingRelease(value);
}
NSData *CXVaultKey(NSString *service, BOOL create, NSError **error) {
  NSError *lookup=nil;NSData *key=CXKeychainPassword(service,@"credential-key",&lookup);
  if(key)return key.length==64?key:Fail(error,@"invalid-keychain-key");
  if(!create || lookup.code!=errSecItemNotFound){if(error)*error=lookup;return nil;}
  NSMutableData *generated=[NSMutableData dataWithLength:64];
  if(SecRandomCopyBytes(kSecRandomDefault,generated.length,generated.mutableBytes)!=errSecSuccess)return Fail(error,@"secure-random-unavailable");
  NSDictionary *attributes=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,(__bridge id)kSecAttrService:service,(__bridge id)kSecAttrAccount:@"credential-key",(__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,(__bridge id)kSecValueData:generated};
  OSStatus status=SecItemAdd((__bridge CFDictionaryRef)attributes,nullptr);
  if(status==errSecDuplicateItem)return CXVaultKey(service,NO,error);
  if(status!=errSecSuccess){if(error)*error=[NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:@{NSLocalizedDescriptionKey:@"keychain-save-failed"}];return nil;}
  return generated;
}
