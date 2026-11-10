#import "probe-common.h"
static NSDictionary *Describe(TISInputSourceRef source){
    return @{@"id":ProbeSourceName(source)?:@"",@"name":(__bridge NSString *)TISGetInputSourceProperty(source,kTISPropertyLocalizedName)?:@"",@"type":(__bridge NSString *)TISGetInputSourceProperty(source,kTISPropertyInputSourceType)?:@"",@"enableCapable":@([(__bridge id)TISGetInputSourceProperty(source,kTISPropertyInputSourceIsEnableCapable) boolValue]),@"enabled":@([(__bridge id)TISGetInputSourceProperty(source,kTISPropertyInputSourceIsEnabled) boolValue]),@"selected":@([(__bridge id)TISGetInputSourceProperty(source,kTISPropertyInputSourceIsSelected) boolValue]),@"selectable":@([(__bridge id)TISGetInputSourceProperty(source,kTISPropertyInputSourceIsSelectCapable) boolValue])};
}
static void Print(id object){NSData *data=[NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingPrettyPrinted error:NULL];fwrite(data.bytes,1,data.length,stdout);putchar('\n');}
int main(int argc,const char **argv){@autoreleasepool{
    NSString *command=argc>1?[NSString stringWithUTF8String:argv[1]]:@"inspect";
    TISInputSourceRef probe=ProbeFindSource(ProbeSourceID);
    if([command isEqualToString:@"inspect"] || [command isEqualToString:@"snapshot"]){
        TISInputSourceRef current=TISCopyCurrentKeyboardInputSource();NSMutableDictionary *record=[@{@"current":ProbeSourceName(current)?:@"",@"probe":probe?Describe(probe):(id)NSNull.null}mutableCopy];if(current)CFRelease(current);if(probe)CFRelease(probe);
        TISInputSourceRef parent=ProbeFindSource(ProbeBundleID);record[@"parent"]=parent?Describe(parent):(id)NSNull.null;if(parent)CFRelease(parent);Print(record);return 0;
    }
    OSStatus status=paramErr;
    if([command isEqualToString:@"register"] && argc==3){
        NSString *path=[[NSString stringWithUTF8String:argv[2]]stringByStandardizingPath];
        NSString *expected=[NSHomeDirectory()stringByAppendingPathComponent:@"Library/Input Methods/SumiMarkerProbe.app"];
        NSBundle *bundle=[NSBundle bundleWithPath:path];
        if([path isEqualToString:expected] && [bundle.bundleIdentifier isEqualToString:ProbeBundleID]){
            status=LSRegisterURL((__bridge CFURLRef)[NSURL fileURLWithPath:path],true);
            if(status==noErr)status=TISRegisterInputSource((__bridge CFURLRef)[NSURL fileURLWithPath:path]);
        }
    }else if([command isEqualToString:@"enable-parent"]){TISInputSourceRef parent=ProbeFindSource(ProbeBundleID);if(parent){status=TISEnableInputSource(parent);CFRelease(parent);}}
    else if([command isEqualToString:@"enable"] && probe)status=TISEnableInputSource(probe);
    else if([command isEqualToString:@"disable"] && probe)status=TISDisableInputSource(probe);
    else if([command isEqualToString:@"stop"]){
        status=noErr;NSString *expected=[NSHomeDirectory()stringByAppendingPathComponent:@"Library/Input Methods/SumiMarkerProbe.app"];
        for(NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:ProbeBundleID]){
            if([app.bundleURL.path isEqualToString:expected]){if(![app terminate])status=paramErr;}
        }
    }
    else if([command isEqualToString:@"restore"] && argc==3){
        NSData *data=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];NSDictionary *saved=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]:nil;
        NSString *identifier=[saved[@"current"]isKindOfClass:NSString.class]?saved[@"current"]:nil;
        TISInputSourceRef original=identifier?ProbeFindSource(identifier):NULL;
        if(original){status=TISSelectInputSource(original);CFRelease(original);}
        if(status==noErr && probe && (saved[@"probe"]==NSNull.null || ![saved[@"probe"][@"enabled"]boolValue]))status=TISDisableInputSource(probe);
        TISInputSourceRef parent=ProbeFindSource(ProbeBundleID);id oldParent=saved[@"parent"];
        if(status==noErr && parent && (!oldParent || oldParent==NSNull.null || ![oldParent[@"enabled"]boolValue]))status=TISDisableInputSource(parent);if(parent)CFRelease(parent);
    }
    if(probe)CFRelease(probe);Print(@{@"command":command,@"status":@(status)});return status==noErr?0:1;
}}
