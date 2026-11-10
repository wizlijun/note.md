#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
static NSString *const ProbeBundleID=@"com.notemd.inputmethod.SumiMarkerProbe";
static NSString *const ProbeSourceID=@"com.notemd.inputmethod.SumiMarkerProbe.Hans";
static NSString *const ProbeMarker=@"com.notemd.sumi.candidates.v1.00000000-0000-4000-8000-000000000001";
static void ProbeLog(NSString *filename,NSDictionary *record) {
    NSString *directory=NSBundle.mainBundle.infoDictionary[@"SumiProbeEvidenceDirectory"];
    if(!directory)return;
    NSMutableDictionary *row=[record mutableCopy];row[@"pid"]=@(getpid());row[@"time"]=@([[NSDate date]timeIntervalSince1970]);
    NSData *json=[NSJSONSerialization dataWithJSONObject:row options:0 error:NULL];
    NSString *path=[directory stringByAppendingPathComponent:filename];
    if(![NSFileManager.defaultManager fileExistsAtPath:path])[NSData.data writeToFile:path atomically:YES];
    NSFileHandle *file=[NSFileHandle fileHandleForWritingAtPath:path];[file seekToEndOfFile];[file writeData:json];[file writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];[file closeFile];
}
static NSString *ProbeSourceName(TISInputSourceRef source) {
    return source?(__bridge NSString *)TISGetInputSourceProperty(source,kTISPropertyInputSourceID):nil;
}
static TISInputSourceRef ProbeFindSource(NSString *identifier) {
    CFArrayRef array=TISCreateInputSourceList((__bridge CFDictionaryRef)@{(__bridge NSString *)kTISPropertyInputSourceID:identifier},true);
    TISInputSourceRef source=array && CFArrayGetCount(array)?(TISInputSourceRef)CFRetain(CFArrayGetValueAtIndex(array,0)):NULL;if(array)CFRelease(array);return source;
}
