#import "probe-common.h"
@interface ProbeBody : NSTextView
@end
@implementation ProbeBody
- (NSArray *)validAttributesForMarkedText {return [[super validAttributesForMarkedText]arrayByAddingObject:ProbeMarker];}
@end
@interface ProbeHost : NSObject <NSApplicationDelegate>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,strong) ProbeBody *body;
@property(nonatomic,strong) NSTextView *search;
@property(nonatomic,strong) NSRunningApplication *previousApp;
@property(nonatomic,copy) NSString *previousSource;
@property(nonatomic) NSUInteger phase;
@end
@implementation ProbeHost
- (void)finish:(BOOL)success reason:(NSString *)reason {
    TISInputSourceRef original=ProbeFindSource(self.previousSource);OSStatus status=original?TISSelectInputSource(original):paramErr;if(original)CFRelease(original);
    ProbeLog(@"host.jsonl",@{@"phase":@"finish",@"success":@(success),@"reason":reason,@"restoreStatus":@(status),@"body":self.body.string?:@"",@"search":self.search.string?:@""});
    [self.window orderOut:nil];[self.previousApp activateWithOptions:0];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
        TISInputSourceRef again=ProbeFindSource(self.previousSource);if(again){TISSelectInputSource(again);CFRelease(again);}exit(success && status==noErr?0:1);
    });
}
- (void)step {
    if(self.phase==3){[self finish:[self.body.string isEqualToString:@"验验"] && [self.search.string isEqualToString:@"验"] reason:@"three IMK insertText callbacks"];return;}
    NSTextView *target=self.phase==1?self.search:self.body;[self.window makeFirstResponder:target];
    TISInputSourceRef probe=ProbeFindSource(ProbeSourceID);OSStatus status=probe?TISSelectInputSource(probe):paramErr;if(probe)CFRelease(probe);
    if(status!=noErr){[self finish:NO reason:[NSString stringWithFormat:@"TISSelectInputSource failed %d",(int)status]];return;}
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,350*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
        NSString *key=@[@"a",@"b",@"c"][self.phase];
        NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:self.window.windowNumber context:nil characters:key charactersIgnoringModifiers:key isARepeat:NO keyCode:0];
        BOOL handled=[target.inputContext handleEvent:event];
        TISInputSourceRef current=TISCopyCurrentKeyboardInputSource();
        ProbeLog(@"host.jsonl",@{@"phase":@"key",@"step":@(self.phase),@"key":key,@"handled":@(handled),@"clientMatches":@(target.inputContext.client==target),@"source":ProbeSourceName(current)?:@""});if(current)CFRelease(current);
        self.phase++;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,350*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self step];});
    });
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,100,540,300) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];self.window.title=@"Sumi isolated IMK marker probe";
    self.body=[[ProbeBody alloc]initWithFrame:NSMakeRect(20,150,500,120)];self.search=[[NSTextView alloc]initWithFrame:NSMakeRect(20,20,500,100)];
    self.body.font=[NSFont systemFontOfSize:24];self.search.font=self.body.font;
    [self.window.contentView addSubview:self.body];[self.window.contentView addSubview:self.search];
    [self.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{[self step];});
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,12*NSEC_PER_SEC),dispatch_get_main_queue(),^{[self finish:NO reason:@"timeout"];});
}
@end
int main(int argc,const char **argv){@autoreleasepool{
    if(argc!=2 || strcmp(argv[1],"--run")!=0){fprintf(stderr,"Explicit --run is required; this activates an isolated window and temporarily selects the probe input source.\n");return 2;}
    TISInputSourceRef original=TISCopyCurrentKeyboardInputSource();NSString *identifier=ProbeSourceName(original);if(!identifier)return 3;
    [NSApplication sharedApplication];ProbeHost *host=[ProbeHost new];host.previousSource=identifier;host.previousApp=NSWorkspace.sharedWorkspace.frontmostApplication;if(original)CFRelease(original);
    ProbeLog(@"host.jsonl",@{@"phase":@"start",@"previousSource":identifier,@"previousApp":host.previousApp.bundleIdentifier?:@""});
    NSApp.delegate=host;[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[NSApp run];
}}
