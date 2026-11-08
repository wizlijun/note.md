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
// Only the active-surface gate is simulated to exercise animation without making
// a window key. Geometry, NSTextView input/selection and drawing remain AppKit.
@interface SumiCaretClockProbe : SumiTextView
@property(nonatomic) BOOL simulatedActive;
@property(nonatomic) BOOL simulatedReducedMotion;
@property(nonatomic) NSUInteger geometryCalls;
@property(nonatomic) NSUInteger missingSegments;
@end
@implementation SumiCaretClockProbe
- (BOOL)caretSurfaceActive { return self.simulatedActive && [self usesTypewriterCaret]; }
- (BOOL)reduceCaretMotion { return self.simulatedReducedMotion; }
- (NSRect)typewriterCaretRect {self.geometryCalls++;if(self.missingSegments){self.missingSegments--;return NSZeroRect;}return [super typewriterCaretRect];}
@end
static void runLoop(NSTimeInterval interval){[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:interval]];}
static NSRect rect(SumiEditor *editor,NSUInteger index){
    editor.text.selectedRange=NSMakeRange(index,0);NSRect result=[editor.text typewriterCaretRect];
    NSRect insertion=[editor rectForInsertion:index];
    require(!NSIsEmptyRect(result),@"TextKit 2 returns a nonempty caret rectangle");
    require(result.size.width>=2 && result.size.width<=3,@"vertical stroke thickness is 2–3 points");
    NSFont *font=[editor baseFont];require(fabs(result.size.height-(font.ascender-font.descender))<1,@"caret height matches overall font metrics, not line spacing");
    require(NSMinY(result)>=NSMinY(insertion) && NSMaxY(result)<=NSMaxY(insertion)+1,@"caret baseline stays inside its current line segment");
    NSTextLayoutManager *layout=editor.text.textLayoutManager;NSTextContentManager *content=layout.textContentManager;
    id<NSTextLocation> location=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)index];
    NSTextLayoutFragment *fragment=[layout textLayoutFragmentForLocation:location];
    NSInteger local=[content offsetFromLocation:fragment.rangeInElement.location toLocation:location];
    for(NSTextLineFragment *line in fragment.textLineFragments){
        if(NSLocationInRange((NSUInteger)local,line.characterRange)){
            CGFloat baseline=fragment.layoutFragmentFrame.origin.y+line.typographicBounds.origin.y+line.glyphOrigin.y+editor.text.textContainerOrigin.y;
            require(fabs(NSMinY(result)-(baseline-font.ascender))<1,@"vertical top follows the independent actual glyph baseline minus ascent");
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
    require(NSEqualSizes(cjk.size,latin.size) && NSEqualSizes(emoji.size,latin.size) && NSEqualSizes(end.size,latin.size),@"Latin/CJK/emoji/end retain the same overall-font vertical dimensions");
    require(NSEqualSizes(empty.size,latin.size),@"empty line retains the same overall-font caret");
    require(empty.origin.y>latin.origin.y,@"caret follows TextKit line geometry");
    require(!editor.text.shouldDrawInsertionPoint,@"ordinary native system caret is suppressed");
    require(![editor.text typewriterCaretEligible],@"hidden inactive window cannot show caret or start animation");
    [editor.text refreshTypewriterCaret:YES];require([editor.text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"off-screen real editor has no animation");
    require([editor.text.string isEqualToString:original] && editor.revision==revision,@"geometry and drawing do not mutate text/revision");
    [editor.text setMarkedText:@"ni" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(1,0)];
    require(editor.text.hasMarkedText && [editor.text usesTypewriterCaret] && editor.text.insertionPointColor.alphaComponent==0,@"marked text retains the custom caret and keeps the system insertion point transparent");
    require([editor.text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"inactive composition has no custom animation");
    [editor.text insertText:@"你" replacementRange:NSMakeRange(NSNotFound,0)];
    require(!editor.text.hasMarkedText && [editor.text usesTypewriterCaret],@"committed IME retains custom caret ownership");
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
    require(larger.size.height>latin.size.height && NSEqualRanges(editor.text.selectedRange,savedSelection),@"font changes update caret height without moving selection");
    require([editor.text.string isEqualToString:wrapped] && editor.revision==savedRevision,@"appearance leaves canonical text/revision unchanged");
    require(editor.text.insertionPointColor.alphaComponent==0,@"ordinary system caret has a transparent public color");
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
    require(fabs(pixel.redComponent-68.0/255)<0.02 && fabs(pixel.greenComponent-65.0/255)<0.02 && fabs(pixel.blueComponent-60.0/255)<0.02,@"caret pixels use exact theme foreground");
    require([paint hitTest:NSMakePoint(1,1)]==nil && !paint.isAccessibilityElement,@"overlay does not intercept input or accessibility");
    SumiCaretClockProbe *clock=[[SumiCaretClockProbe alloc]initUsingTextLayoutManager:YES];clock.owner=editor;clock.frame=NSMakeRect(0,0,500,400);[window.contentView addSubview:clock];clock.string=@"A";clock.typingAttributes=[editor baseAttributes];clock.simulatedActive=YES;
    [clock refreshTypewriterCaret:YES];require(!clock.typewriterCaret.hidden,@"breathing keeps the caret visible");
    CABasicAnimation *breathing=(CABasicAnimation *)[clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"];
    require([breathing.keyPath isEqualToString:@"opacity"] && [breathing.fromValue doubleValue]==1 && [breathing.toValue doubleValue]==0.25 && breathing.duration==3 && breathing.autoreverses,@"public layer animation breathes 1→0.25→1 over six seconds");
    require(breathing.preferredFrameRateRange.maximum==30,@"animation requests at most 30fps");
    runLoop(0.05); // Finish the initial native view layout before observing animation-only frames.
    CFTimeInterval epoch=clock.caretBreathingEpoch,begin=breathing.beginTime;NSUInteger geometry=clock.geometryCalls;
    runLoop(0.25);require(clock.geometryCalls==geometry,@"animation frames never recompute geometry or text layout");
    [clock refreshTypewriterCaret:YES];[clock refreshTypewriterCaret:YES];
    require(clock.caretBreathingEpoch==epoch && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"].beginTime==begin,@"input/selection refreshes preserve stable breathing phase");
    editor.appearance=[editor.appearance mutableCopy];NSMutableDictionary *motion=[editor.appearance mutableCopy];motion[@"caret_motion"]=@"steady";editor.appearance=motion;
    [clock refreshTypewriterCaret:YES];require(!clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil && clock.typewriterCaret.layer.opacity==1,@"steady mode is immediately fully opaque with no animation");
    motion=[editor.appearance mutableCopy];motion[@"caret_motion"]=@"breathing";editor.appearance=motion;
    clock.simulatedReducedMotion=YES;[clock refreshTypewriterCaret:YES];require(!clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil && clock.typewriterCaret.layer.opacity==1,@"reduced motion keeps a steady caret without animation");
    clock.simulatedReducedMotion=NO;
    NSRect lastValid=clock.typewriterCaret.frame;clock.missingSegments=2;
    [clock refreshTypewriterCaret:NO];runLoop(0.02);
    require(!clock.typewriterCaret.hidden && NSEqualRects(lastValid,clock.typewriterCaret.frame) && clock.missingSegments==0,@"two transient missing segments preserve the valid steady caret through the queued retry");
    [clock layout];require(!clock.typewriterCaret.hidden && NSEqualRects(clock.typewriterCaret.frame,[clock typewriterCaretRect]),@"native layout completion recovers the actual insertion geometry");
    clock.frame=NSMakeRect(0,10000,500,400);[clock refreshTypewriterCaret:NO];require(clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"outside visibleRect stops animation");
    clock.frame=NSMakeRect(0,0,500,400);[clock refreshTypewriterCaret:NO];require(!clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]!=nil,@"returning to visibleRect restores the caret");
    epoch=clock.caretBreathingEpoch;clock.selectedRange=NSMakeRange(0,1);[clock refreshTypewriterCaret:YES];require(clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"selection hides caret and stops animation");
    editor.applying=YES;[clock refreshTypewriterCaret:NO];editor.applying=NO;
    require(clock.typewriterCaret.hidden,@"host focus/inspect transactions cannot create a caret over a normal nonempty selection");
    clock.selectedRange=NSMakeRange(0,0);[clock refreshTypewriterCaret:YES];clock.simulatedActive=NO;[clock refreshTypewriterCaret:NO];
    require(clock.caretBreathingEpoch==epoch,@"temporary selection/focus changes retain phase origin");
    require(clock.typewriterCaret.hidden && [clock.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"resign/hidden eligibility stops animation");
    // A remote insertion point must not move the reading viewport when its
    // caret is recomputed after repeated scrolling in a long document.
    SumiEditor *largeOwner=[SumiEditor new];largeOwner.appearance=editor.appearance;
    SumiCaretClockProbe *large=[[SumiCaretClockProbe alloc]initUsingTextLayoutManager:YES];large.owner=largeOwner;largeOwner.text=large;
    NSScrollView *largeScroll=[[NSScrollView alloc]initWithFrame:NSMakeRect(0,0,500,400)];largeOwner.scroll=largeScroll;
    large.frame=NSMakeRect(0,0,500,400);large.verticallyResizable=YES;large.maxSize=NSMakeSize(500,CGFLOAT_MAX);large.textContainer.containerSize=NSMakeSize(500,CGFLOAT_MAX);large.textContainer.widthTracksTextView=YES;
    largeScroll.documentView=large;[window.contentView addSubview:largeScroll];
    large.string=[@"Line 中 text\n" stringByPaddingToLength:120000 withString:@"Line 中 text\n" startingAtIndex:0];large.font=[largeOwner baseFont];large.simulatedActive=YES;
    large.selectedRange=NSMakeRange(large.string.length,0);[large scrollRangeToVisible:large.selectedRange];[large.textLayoutManager.textViewportLayoutController layoutViewport];[large refreshTypewriterCaret:NO];
    CFTimeInterval scrollingStart=CACurrentMediaTime();
    for(NSUInteger scroll=0;scroll<12;scroll++){
        NSPoint origin=NSMakePoint(0,scroll%2?40:0);[largeScroll.contentView scrollToPoint:origin];[largeScroll reflectScrolledClipView:largeScroll.contentView];
        [large.textLayoutManager.textViewportLayoutController layoutViewport];NSPoint before=largeScroll.contentView.bounds.origin;
        [large refreshTypewriterCaret:NO];
        require(NSEqualPoints(before,largeScroll.contentView.bounds.origin),@"offscreen caret refresh never scrolls 120k text back to the insertion point");
        require(large.typewriterCaret.hidden,@"far-away insertion caret remains clipped during reading");
    }
    printf("LONG DOCUMENT scrolls=12 elapsed=%.4fs geometry_calls=%lu\n",CACurrentMediaTime()-scrollingStart,(unsigned long)large.geometryCalls);
    require(CACurrentMediaTime()-scrollingStart<3,@"120k text offscreen caret refresh stays bounded for repeated reading scrolls");
    sumi_editor_detach(handle);require([editor.text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"]==nil,@"detach stops animation");
    require(!window.visible && !window.isKeyWindow && !NSApp.isActive,@"probe never showed or activated a window");
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"user's foreground application unchanged");
    printf("PASS: font-height vertical caret, real TextKit2 geometry/theme/IME; six-second phase-stable layer breathing/steady; no UI activation\n");
}}
