// Off-screen real AppKit/TextKit 2 coverage. Never orders or activates a window.
#import "editor.m"
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t callback(void *context,const char *json,char **reply){
    (void)context;(void)reply;NSDictionary *event=SumiJSON(json);
    return [event[@"kind"] isEqualToString:@"edit"]?[event[@"base_revision"] longLongValue]+1:0;
}
static void freeReply(char *value){free(value);}
static int command(void *handle,NSDictionary *value){
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    NSString *json=[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding];return sumi_editor_command(handle,json.UTF8String);
}
// Only the eligibility gate is simulated to exercise the timer without making
// a window key. Geometry, NSTextView input/selection and drawing remain AppKit.
@interface SumiCaretClockProbe : SumiTextView
@property(nonatomic) BOOL simulatedActive;
@property(nonatomic) BOOL simulatedReducedMotion;
@end
@implementation SumiCaretClockProbe
- (BOOL)typewriterCaretEligible { return self.simulatedActive && [self usesTypewriterCaret] && self.selectedRange.length==0; }
- (BOOL)reduceCaretMotion { return self.simulatedReducedMotion; }
@end
static void runLoop(NSTimeInterval interval){[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:interval]];}
static NSRect rect(SumiEditor *editor,NSUInteger index){
    editor.text.selectedRange=NSMakeRange(index,0);NSRect result=[editor.text typewriterCaretRect];
    NSRect insertion=[editor rectForInsertion:index];
    require(!NSIsEmptyRect(result),@"TextKit 2 returns a nonempty caret rectangle");
    require(result.size.height>=2 && result.size.height<=4,@"underline thickness is 2–4 points");
    require(NSMinY(result)>=NSMinY(insertion) && NSMaxY(result)<=NSMaxY(insertion)+1,@"caret baseline stays inside its current line segment");
    NSTextLayoutManager *layout=editor.text.textLayoutManager;NSTextContentManager *content=layout.textContentManager;
    id<NSTextLocation> location=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)index];
    NSTextLayoutFragment *fragment=[layout textLayoutFragmentForLocation:location];
    NSInteger local=[content offsetFromLocation:fragment.rangeInElement.location toLocation:location];
    for(NSTextLineFragment *line in fragment.textLineFragments){
        if(NSLocationInRange((NSUInteger)local,line.characterRange)){
            CGFloat baseline=fragment.layoutFragmentFrame.origin.y+line.typographicBounds.origin.y+line.glyphOrigin.y+editor.text.textContainerOrigin.y;
            require(NSMinY(result)>baseline && NSMinY(result)<baseline+5,@"underline is immediately below the independent actual glyph baseline");
            printf("GLYPH baseline=%.2f caret=%.2f\n",baseline,NSMinY(result));break;
        }
    }
    printf("CARET %lu x=%.2f y=%.2f w=%.2f h=%.2f\n",(unsigned long)index,result.origin.x,result.origin.y,result.size.width,result.size.height);
    return result;
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"caret-probe\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":760,\"height\":540},\"appearance\":{\"font_family\":\"Menlo\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#44413c\",\"background\":\"#f3ead7\",\"max_columns\":80,\"bottom_inset\":80},\"document\":{\"text\":\"A中😀\\n\\n\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,config,callback,freeReply,NULL);
    require(handle!=NULL,@"production native editor mounts off-screen");SumiEditor *editor=(__bridge SumiEditor *)handle;
    NSString *original=[editor.text.string copy];uint64_t revision=editor.revision;
    NSRect latin=rect(editor,0),cjk=rect(editor,1),emoji=rect(editor,2),end=rect(editor,4),empty=rect(editor,5);
    require(cjk.size.width>latin.size.width*1.3,@"CJK uses its actual fallback advance");
    require(fabs(emoji.size.width-end.size.width)<1,@"line-end follows preceding full emoji grapheme");
    require(fabs(empty.size.width-latin.size.width)<1,@"empty line uses the Latin monospaced advance");
    require(empty.origin.y>latin.origin.y,@"caret follows TextKit line geometry");
    require(!editor.text.shouldDrawInsertionPoint,@"ordinary native system caret is suppressed");
    require(![editor.text typewriterCaretEligible],@"hidden inactive window cannot show caret or start a timer");
    [editor.text refreshTypewriterCaret:YES];require(editor.text.caretTimer==nil,@"off-screen real editor has no timer");
    require([editor.text.string isEqualToString:original] && editor.revision==revision,@"geometry and drawing do not mutate text/revision");
    [editor.text setMarkedText:@"ni" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(1,0)];
    require(editor.text.hasMarkedText && ![editor.text usesTypewriterCaret],@"marked text restores the system insertion-point path");
    require(editor.text.caretTimer==nil,@"composition has no custom blink timer");
    [editor.text insertText:@"你" replacementRange:NSMakeRange(NSNotFound,0)];
    require(!editor.text.hasMarkedText && [editor.text usesTypewriterCaret],@"committed IME restores typewriter mode");
    require([editor.text.string isEqualToString:@"A你中😀\n\n"] && editor.revision==revision+1,@"IME emits one unchanged canonical transaction");
    require(editor.text.textLayoutManager!=nil,@"caret never switches to TextKit 1");
    NSString *wrapped=[@"A" stringByPaddingToLength:180 withString:@"A" startingAtIndex:0];
    require(command(handle,@{@"command":@"apply_document",@"base_revision":@(editor.revision),@"revision":@(editor.revision+1),@"document":@{@"text":wrapped,@"runs":@[]},@"selection":@{@"start":@110,@"length":@0}})==0,@"remote projection retains ordinary native admission");
    NSRect first=rect(editor,0),second=rect(editor,60),third=rect(editor,120);
    require(second.origin.y>first.origin.y && third.origin.y>second.origin.y,@"soft-wrapped caret follows each actual line without double-counting baselines");
    NSRange savedSelection=editor.text.selectedRange;uint64_t savedRevision=editor.revision;
    NSMutableDictionary *appearance=[editor.appearance mutableCopy];appearance[@"font_size"]=@30;appearance[@"foreground"]=@"#ffffff";
    require(command(handle,@{@"command":@"set_appearance",@"appearance":appearance})==0,@"font/theme update accepted");
    NSRect larger=rect(editor,savedSelection.location);
    require(larger.size.width>latin.size.width && NSEqualRanges(editor.text.selectedRange,savedSelection),@"font changes update caret width without moving selection");
    require([editor.text.string isEqualToString:wrapped] && editor.revision==savedRevision,@"appearance leaves canonical text/revision unchanged");
    require([editor.text.insertionPointColor isEqual:SumiColor(@"#ffffff")],@"theme foreground drives both system and custom caret color");
    NSMutableString *deep=[NSMutableString new];NSUInteger deepIndex=0;
    for(NSUInteger line=0;line<500;line++){if(line==300)deepIndex=deep.length;[deep appendFormat:@"Line %03lu 中 😀\n",(unsigned long)line];}
    require(command(handle,@{@"command":@"apply_document",@"base_revision":@(editor.revision),@"revision":@(editor.revision+1),@"document":@{@"text":deep,@"runs":@[]},@"selection":@{@"start":@(deepIndex),@"length":@0}})==0,@"deep document projection accepted");
    NSRect deepCaret=rect(editor,deepIndex);require(deepCaret.origin.y>1000,@"deep paragraph uses absolute document geometry");
    [editor restoreViewport:@{@"start":@(deepIndex),@"offset":@0}];NSRect scrolled=rect(editor,deepIndex);
    require(NSIntersectsRect(scrolled,editor.text.visibleRect),@"deep caret follows the scrolled viewport");
    SumiCaretView *paint=[[SumiCaretView alloc]initWithFrame:NSMakeRect(0,0,20,3)];paint.color=SumiColor(@"#44413c");
    NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc]initWithBitmapDataPlanes:NULL pixelsWide:20 pixelsHigh:3 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];[paint drawRect:paint.bounds];[NSGraphicsContext restoreGraphicsState];
    NSColor *pixel=[[bitmap colorAtX:10 y:1] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    require(fabs(pixel.redComponent-68.0/255)<0.02 && fabs(pixel.greenComponent-65.0/255)<0.02 && fabs(pixel.blueComponent-60.0/255)<0.02,@"underline pixels use exact theme foreground");
    require([paint hitTest:NSMakePoint(1,1)]==nil && !paint.isAccessibilityElement,@"overlay does not intercept input or accessibility");
    SumiCaretClockProbe *clock=[[SumiCaretClockProbe alloc]initUsingTextLayoutManager:YES];clock.owner=editor;clock.frame=NSMakeRect(0,0,500,400);[window.contentView addSubview:clock];clock.string=@"A";clock.typingAttributes=[editor baseAttributes];clock.simulatedActive=YES;
    [clock refreshTypewriterCaret:YES];require(!clock.typewriterCaret.hidden,@"input starts with steady visible caret");
    runLoop(0.95);require(clock.typewriterCaret.hidden,@"idle caret turns off after the hold interval");
    runLoop(0.75);require(!clock.typewriterCaret.hidden,@"idle caret returns on at slow half-period");
    [clock refreshTypewriterCaret:YES];runLoop(0.5);require(!clock.typewriterCaret.hidden,@"new input restarts the steady hold");
    clock.simulatedReducedMotion=YES;[clock refreshTypewriterCaret:YES];require(!clock.typewriterCaret.hidden && clock.caretTimer==nil,@"reduced motion keeps a steady caret without a timer");
    clock.simulatedReducedMotion=NO;
    clock.frame=NSMakeRect(0,10000,500,400);[clock refreshTypewriterCaret:NO];require(clock.typewriterCaret.hidden && clock.caretTimer==nil,@"outside visibleRect stops the timer");
    clock.frame=NSMakeRect(0,0,500,400);[clock refreshTypewriterCaret:NO];require(!clock.typewriterCaret.hidden && clock.caretTimer!=nil,@"returning to visibleRect restarts the caret");
    clock.selectedRange=NSMakeRange(0,1);[clock refreshTypewriterCaret:YES];require(clock.typewriterCaret.hidden && clock.caretTimer==nil,@"selection hides caret and stops timer");
    clock.selectedRange=NSMakeRange(0,0);[clock refreshTypewriterCaret:YES];clock.simulatedActive=NO;[clock refreshTypewriterCaret:NO];
    require(clock.typewriterCaret.hidden && clock.caretTimer==nil,@"resign/hidden eligibility stops timer");
    sumi_editor_detach(handle);require(editor.text.caretTimer==nil,@"detach stops timer");
    require(!window.visible && !window.isKeyWindow && !NSApp.isActive,@"probe never showed or activated a window");
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"user's foreground application unchanged");
    printf("PASS: real TextKit2 glyph geometry, theme pixels, markedText/commit; simulated active clock; no UI activation\n");
}}
