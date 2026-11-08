// A real TextKit 2 raster test with a positive system-caret control. Windows
// stay unordered and the app cannot activate; only eligibility is simulated.
#import "editor.m"
static void require(BOOL value,NSString *why){if(!value){fprintf(stderr,"FAIL: %s\n",why.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;(void)reply;NSDictionary *event=SumiJSON(json);
    return [event[@"kind"] isEqualToString:@"edit"]?[event[@"base_revision"] longLongValue]+1:0;
}
static void freeReply(char *reply){free(reply);}
@interface CaretRenderWindow : NSWindow
@end
@implementation CaretRenderWindow
- (BOOL)isKeyWindow{return YES;} // Never order or activate the actual window.
@end
@interface CaretSystemControl : NSTextView
@property(nonatomic) NSUInteger legacyDrawCalls;
@end
@implementation CaretSystemControl
- (BOOL)shouldDrawInsertionPoint{return YES;}
- (void)drawInsertionPointInRect:(NSRect)rect color:(NSColor *)color turnedOn:(BOOL)on {
    self.legacyDrawCalls++;[super drawInsertionPointInRect:rect color:color turnedOn:on];
}
@end
@interface CaretSumiControl : SumiTextView
@end
@implementation CaretSumiControl
- (BOOL)typewriterCaretEligible{return [self usesTypewriterCaret] && self.selectedRange.length==0;}
- (BOOL)reduceCaretMotion{return YES;}
- (BOOL)shouldDrawInsertionPoint {
    // Make the system eligible during IME despite the deliberately inactive
    // app. Ordinary typing executes the production suppression unchanged.
    return [self usesTypewriterCaret]?[super shouldDrawInsertionPoint]:YES;
}
@end
@interface CaretSuppressionMutation : CaretSumiControl
@end
@implementation CaretSuppressionMutation
- (BOOL)shouldDrawInsertionPoint{return YES;}
- (void)syncSystemCaretColor {} // Deliberately remove both public suppression gates.
@end
static NSUInteger systemIndicators(NSView *view,BOOL opaque){
    NSUInteger count=0;
    if(@available(macOS 14.0,*))if([view isKindOfClass:NSTextInsertionIndicator.class] && !view.hidden && (!opaque || ((NSTextInsertionIndicator *)view).color.alphaComponent>0))count++;
    for(NSView *child in view.subviews)count+=systemIndicators(child,opaque);
    return count;
}
static NSDictionary *capture(NSTextView *text,NSString *name,BOOL blue){
    [text.textLayoutManager ensureLayoutForRange:text.textLayoutManager.documentRange];
    [text updateInsertionPointStateAndRestartTimer:YES];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    NSBitmapImageRep *bitmap=[text bitmapImageRepForCachingDisplayInRect:text.bounds];
    [text cacheDisplayInRect:text.bounds toBitmapImageRep:bitmap];
    NSString *path=[@"tasks/sumi-native" stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    require([[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:path atomically:YES],@"save exact AppKit raster evidence");
    NSInteger count=0,left=NSIntegerMax,top=NSIntegerMax,right=0,bottom=0,stale=0;
    for(NSInteger y=0;y<bitmap.pixelsHigh;y++)for(NSInteger x=0;x<bitmap.pixelsWide;x++){
        NSColor *color=[[bitmap colorAtX:x y:y]colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        BOOL red=color.redComponent>0.7 && color.greenComponent<0.4 && color.blueComponent<0.4;
        BOOL current=blue?(color.blueComponent>0.7 && color.redComponent<0.4 && color.greenComponent<0.4):red;
        if(current){count++;left=MIN(left,x);top=MIN(top,y);right=MAX(right,x);bottom=MAX(bottom,y);}
        if(blue && red)stale++;
    }
    NSDictionary *result=@{@"pixels":@(count),@"width":@(count?right-left+1:0),@"height":@(count?bottom-top+1:0),@"stale_red":@(stale),@"system_indicators":@(systemIndicators(text,YES)),@"system_indicator_objects":@(systemIndicators(text,NO))};
    printf("%s %s\n",name.UTF8String,result.description.UTF8String);
    require(text.textLayoutManager!=nil,@"raster uses TextKit 2 throughout");
    return result;
}
static void customVertical(NSDictionary *r){
    require([r[@"pixels"] integerValue]>0,@"custom caret is actually rendered, not merely configured");
    require([r[@"height"] doubleValue]>[r[@"width"] doubleValue]*3,@"raster contains the requested vertical caret");
    require([r[@"width"] integerValue]>=4 && [r[@"width"] integerValue]<=6,@"Retina raster has the heavier 2–3pt vertical stroke");
    require([r[@"system_indicators"] integerValue]==0,@"no visible modern system indicator alongside custom caret");
}
static NSWindow *prepare(NSTextView *text){
    NSWindow *window=[[CaretRenderWindow alloc]initWithContentRect:NSMakeRect(0,0,400,200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    text.frame=NSMakeRect(0,0,400,200);text.minSize=NSMakeSize(0,200);text.verticallyResizable=YES;text.font=[NSFont fontWithName:@"Menlo" size:30];
    text.string=@"ABC";text.backgroundColor=NSColor.whiteColor;text.textColor=NSColor.blackColor;
    text.insertionPointColor=NSColor.redColor;text.selectedRange=NSMakeRange(3,0);
    [window.contentView addSubview:text];[window makeFirstResponder:text];return window;
}
static SumiEditor *owner(SumiTextView *text){
    SumiEditor *editor=[SumiEditor new];editor.surfaceID=@"caret-render";editor.generation=1;editor.text=text;text.owner=editor;
    editor.appearance=@{@"font_family":@"Menlo",@"font_size":@30,@"line_height":@1.6,@"foreground":@"#ff0000",@"background":@"#ffffff"};
    editor.pending=[NSMutableArray new];editor.runs=@[];editor.callback=receive;editor.freeReply=freeReply;
    return editor;
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    CaretSystemControl *system=[[CaretSystemControl alloc]initUsingTextLayoutManager:YES];NSWindow *systemWindow=prepare(system);
    NSDictionary *vertical=capture(system,@"caret-render-system",NO);
    require([vertical[@"height"] integerValue]>30 && [vertical[@"width"] integerValue]<8,@"positive control actually renders the default vertical line");
    if(@available(macOS 14.0,*))require([vertical[@"system_indicators"] integerValue]>0,@"positive control exercises modern NSTextInsertionIndicator");
    printf("System legacy drawInsertionPoint calls=%lu\n",(unsigned long)system.legacyDrawCalls);
    CaretSumiControl *text=[[CaretSumiControl alloc]initUsingTextLayoutManager:YES];SumiEditor *editor=owner(text);NSWindow *window=prepare(text);editor.committed=text.string;text.delegate=editor;
    NSDictionary *initial=capture(text,@"caret-render-sumi",NO);customVertical(initial);
    NSMutableDictionary *appearance=[editor.appearance mutableCopy];appearance[@"font_size"]=@44;appearance[@"foreground"]=@"#0000ff";editor.appearance=appearance;
    text.font=[NSFont fontWithName:@"Menlo" size:44];text.insertionPointColor=NSColor.blueColor;
    NSDictionary *changed=capture(text,@"caret-render-font-theme",YES);customVertical(changed);require([changed[@"stale_red"] integerValue]==0 && [changed[@"height"] integerValue]>[initial[@"height"] integerValue],@"font/theme update grows caret height and leaves no old pixels");
    appearance=[editor.appearance mutableCopy];appearance[@"foreground"]=@"#ff0000";editor.appearance=appearance;text.insertionPointColor=NSColor.redColor;
    [text setMarkedText:@"ni" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(3,0)];
    NSDictionary *marked=capture(text,@"caret-render-ime",NO);
    require([marked[@"height"] integerValue]>30 && [marked[@"width"] integerValue]<8,@"marked text renders one real system vertical caret");
    require(!text.typewriterCaret || text.typewriterCaret.hidden,@"custom caret stays hidden during marked text");
    [text insertText:@"你" replacementRange:NSMakeRange(NSNotFound,0)];
    customVertical(capture(text,@"caret-render-after-ime",NO));
    require([text.string isEqualToString:@"ABC你"] && editor.revision==1,@"raster/IME path preserves the single input transaction");
    CaretSuppressionMutation *mutant=[[CaretSuppressionMutation alloc]initUsingTextLayoutManager:YES];SumiEditor *mutationOwner=owner(mutant);NSWindow *mutationWindow=prepare(mutant);
    NSDictionary *mutation=capture(mutant,@"caret-render-mutation",NO);
    require([mutation[@"system_indicators"] integerValue]>0,@"removing production suppression exposes the real duplicate system indicator");
    require(mutationOwner.text==mutant,@"mutation owner stays alive for the whole control");
    require(!systemWindow.visible && !window.visible && !mutationWindow.visible && !NSApp.active,@"no window was shown and app never activated");
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"user's foreground application unchanged");
    printf("PASS: real modern vertical positive control, one custom font-height vertical caret, font/theme, IME roundtrip, suppression mutation; no window activation\n");
}}
