#import <Foundation/Foundation.h>
#import "../../control-native/macos/RelayDeskNative/NativeVault.h"

// Read only an existing native Agent envelope. No key or plaintext is persisted;
// the parent immediately re-encrypts the result with Electron safeStorage.
int main(int argc,const char *argv[]) {
  @autoreleasepool {
    if(argc!=2)return 2;
    NSError *error=nil;
    NSData *input=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] options:0 error:&error];
    if(!input || input.length>65636)return 3;
    NSData *key=CXVaultKey(@"com.codexer.connector.NativeVault",NO,&error);
    NSData *plaintext=key?CXOpen(input,key,&error):nil;
    if(!plaintext || ![NSJSONSerialization JSONObjectWithData:plaintext options:0 error:&error])return 4;
    return fwrite(plaintext.bytes,1,plaintext.length,stdout)==plaintext.length?0:5;
  }
}
