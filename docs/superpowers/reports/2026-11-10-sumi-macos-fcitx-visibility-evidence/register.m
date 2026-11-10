#import <Foundation/Foundation.h>
#import <Carbon/Carbon.h>
#include <unistd.h>
int main(void) { @autoreleasepool {
 if (geteuid() != 0) { fprintf(stderr,"System registration requires administrator privileges.\n"); return 1; }
 NSURL *url=[NSURL fileURLWithPath:@"/Library/Input Methods/Fcitx5.app"];
 NSBundle *bundle=[NSBundle bundleWithURL:url];
 if (![bundle.bundleIdentifier isEqualToString:@"org.fcitx.inputmethod.Fcitx5"]) { fprintf(stderr,"Installed Fcitx5 bundle missing or mismatched.\n"); return 1; }
 OSStatus result=TISRegisterInputSource((__bridge CFURLRef)url);
 printf("Fcitx5 system TISRegisterInputSource=%d\n",(int)result);
 return result == noErr ? 0 : 1;
} }
