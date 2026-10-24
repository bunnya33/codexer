#import <Foundation/Foundation.h>
#import "../RelayDeskNative/NativeVault.h"
#import <CommonCrypto/CommonCrypto.h>
#import <assert.h>

int main() {
  @autoreleasepool {
    NSMutableData *key=[NSMutableData dataWithLength:64];for(NSUInteger n=0;n<key.length;n++)((uint8_t *)key.mutableBytes)[n]=(uint8_t)n;
    NSData *plain=[@"{\"session\":\"synthetic-migration-test\",\"installationId\":\"preserved\"}" dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error=nil;NSData *sealed=CXSeal(plain,key,&error);assert(sealed && !error);assert(![sealed isEqual:plain]);assert([CXOpen(sealed,key,&error)isEqual:plain]);
    assert(![CXSeal(plain,key,&error)isEqual:sealed]);
    for(NSUInteger index=0;index<sealed.length;index++) {NSMutableData *changed=[sealed mutableCopy];((uint8_t *)changed.mutableBytes)[index]^=1;assert(!CXOpen(changed,key,&error));}
    NSMutableData *wrong=[key mutableCopy];((uint8_t *)wrong.mutableBytes)[0]^=1;assert(!CXOpen(sealed,wrong,&error));
    assert(!CXOpen([NSData data],key,&error));assert(!CXSeal([NSMutableData dataWithLength:65537],key,&error));
    NSData *password=[@"synthetic-electron-password" dataUsingEncoding:NSUTF8StringEncoding];
    uint8_t legacyKey[16],iv[16];memset(iv,' ',sizeof(iv));assert(CCKeyDerivationPBKDF(kCCPBKDF2,(const char *)password.bytes,password.length,(const uint8_t *)"saltysalt",sizeof("saltysalt")-1,kCCPRFHmacAlgSHA1,1003,legacyKey,sizeof(legacyKey))==kCCSuccess);
    NSMutableData *cipher=[NSMutableData dataWithLength:plain.length+16];size_t count=0;assert(CCCrypt(kCCEncrypt,kCCAlgorithmAES,kCCOptionPKCS7Padding,legacyKey,sizeof(legacyKey),iv,plain.bytes,plain.length,cipher.mutableBytes,cipher.length,&count)==kCCSuccess);cipher.length=count;
    NSMutableData *legacy=[NSMutableData dataWithBytes:"v10" length:3];[legacy appendData:cipher];
    assert([CXOpenElectron(legacy,password,&error)isEqual:plain]);
    // Chromium v10 has no MAC; failed migration is decided by credential parsing.
    assert(![CXOpenElectron(legacy,[@"wrong-password" dataUsingEncoding:NSUTF8StringEncoding],&error)isEqual:plain]);
    if(NSProcessInfo.processInfo.arguments.count>1){
      NSData *data=[NSData dataWithContentsOfFile:NSProcessInfo.processInfo.arguments[1]];NSDictionary *fixture=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      NSData *encrypted=[[NSData alloc]initWithBase64EncodedString:fixture[@"ciphertext"] options:0];
      NSData *actual=CXOpenElectron(encrypted,[fixture[@"password"] dataUsingEncoding:NSUTF8StringEncoding],&error);
      assert(actual && [actual isEqual:[fixture[@"plaintext"] dataUsingEncoding:NSUTF8StringEncoding]]);
    }
    puts("{\"authenticatedVaultRoundtrip\":true,\"tamperingRejected\":true,\"wrongKeyRejected\":true,\"sizeLimitEnforced\":true,\"electronV10Migration\":true}");
  }
  return 0;
}
