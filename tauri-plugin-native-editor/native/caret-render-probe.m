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
- (BOOL)caretSurfaceActive{return [self usesTypewriterCaret] && self.isEditable && !self.isHiddenOrHasHiddenAncestor;}
@end
@interface CaretInputAudit : NSObject
@property(nonatomic, weak) SumiTextView *text;
@property(nonatomic) BOOL watching;
@property(nonatomic) NSUInteger observations;
@property(nonatomic) NSUInteger gaps;
@property(nonatomic) NSUInteger visibleSystemColors;
@end
@implementation CaretInputAudit
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    (void)keyPath;(void)object;(void)change;(void)context;if(!self.watching)return;self.observations++;
    if(self.text.typewriterCaret.hidden || NSIsEmptyRect(self.text.typewriterCaret.frame) || self.text.typewriterCaret.layer.opacity<0.99)self.gaps++;
    if(self.text.insertionPointColor.alphaComponent!=0)self.visibleSystemColors++;
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
static NSDictionary *captureRaster(NSTextView *text,NSString *name,BOOL blue,BOOL prepareLayout){
    if(prepareLayout){
        [text.textLayoutManager ensureLayoutForRange:text.textLayoutManager.documentRange];
        [text updateInsertionPointStateAndRestartTimer:YES];
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    NSBitmapImageRep *bitmap=[text bitmapImageRepForCachingDisplayInRect:text.bounds];
    [text cacheDisplayInRect:text.bounds toBitmapImageRep:bitmap];
    NSString *path=[@"tasks/sumi-native" stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    require([[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:path atomically:YES],@"save exact AppKit raster evidence");
    // Preedit now inherits the body's color, which is also the custom caret
    // color. Measure the actual caret view's raster, not same-colored glyphs
    // elsewhere in the document. Keep the system-indicator audit global.
    NSRect caretRegion=text.bounds;
    if([text isKindOfClass:SumiTextView.class]){
        NSView *caret=((SumiTextView *)text).typewriterCaret;
        caretRegion=[text convertRect:caret.bounds fromView:caret];
    }
    CGFloat pixelScale=bitmap.pixelsWide/text.bounds.size.width;
    NSInteger count=0,left=NSIntegerMax,top=NSIntegerMax,right=0,bottom=0,stale=0;
    for(NSInteger y=0;y<bitmap.pixelsHigh;y++)for(NSInteger x=0;x<bitmap.pixelsWide;x++){
        NSColor *color=[[bitmap colorAtX:x y:y]colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        BOOL red=color.redComponent>0.7 && color.greenComponent<0.4 && color.blueComponent<0.4;
        BOOL current=blue?(color.blueComponent>0.7 && color.redComponent<0.4 && color.greenComponent<0.4):red;
        if(current && NSPointInRect(NSMakePoint((x+.5)/pixelScale,(y+.5)/pixelScale),caretRegion)){count++;left=MIN(left,x);top=MIN(top,y);right=MAX(right,x);bottom=MAX(bottom,y);}
        if(blue && red)stale++;
    }
    NSDictionary *result=@{@"pixels":@(count),@"width":@(count?right-left+1:0),@"height":@(count?bottom-top+1:0),@"stale_red":@(stale),@"system_indicators":@(systemIndicators(text,YES)),@"system_indicator_objects":@(systemIndicators(text,NO))};
    printf("%s %s\n",name.UTF8String,result.description.UTF8String);
    require(text.textLayoutManager!=nil,@"raster uses TextKit 2 throughout");
    return result;
}
static NSDictionary *capture(NSTextView *text,NSString *name,BOOL blue){return captureRaster(text,name,blue,YES);}
static void customVertical(NSDictionary *r){
    require([r[@"pixels"] integerValue]>0,@"custom caret is actually rendered, not merely configured");
    require([r[@"height"] doubleValue]>[r[@"width"] doubleValue]*3,@"raster contains the requested vertical caret");
    require([r[@"width"] integerValue]>=4 && [r[@"width"] integerValue]<=6,@"Retina raster has the heavier 2–3pt vertical stroke");
    require([r[@"system_indicators"] integerValue]==0,@"no visible modern system indicator alongside custom caret");
}
static void sampleThemeCaret(SumiTextView *text,NSString *name){
    require(!text.typewriterCaret.hidden && text.typewriterCaret.layer.opacity==1,@"steady theme caret exists before any rendering/layout helper");
    NSRect actual=text.typewriterCaret.frame;
    require(NSEqualRects(actual,[text typewriterCaretRect]),@"input returns with caret at the actual TextKit insertion position");
    NSBitmapImageRep *bitmap=[text bitmapImageRepForCachingDisplayInRect:text.bounds];[text cacheDisplayInRect:text.bounds toBitmapImageRep:bitmap];
    CGFloat scale=bitmap.pixelsWide/text.bounds.size.width;
    NSColor *expected=[SumiColor(text.owner.appearance[@"foreground"]) colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    NSInteger matched=0,total=0;
    for(NSInteger y=(NSInteger)ceil(NSMinY(actual)*scale)+1;y<(NSInteger)floor(NSMaxY(actual)*scale)-1;y++)
        for(NSInteger x=(NSInteger)ceil(NSMinX(actual)*scale);x<(NSInteger)floor(NSMaxX(actual)*scale);x++){
            require(x>=0 && x<bitmap.pixelsWide && y>=0 && y<bitmap.pixelsHigh,@"caret raster stays in viewport");
            NSColor *pixel=[[bitmap colorAtX:x y:y]colorUsingColorSpace:NSColorSpace.sRGBColorSpace];total++;
            if(fabs(pixel.redComponent-expected.redComponent)<0.08 && fabs(pixel.greenComponent-expected.greenComponent)<0.08 && fabs(pixel.blueComponent-expected.blueComponent)<0.08)matched++;
        }
    require(total>0 && matched>total*0.95,@"full-width steady caret pixels match the actual sepia foreground throughout input");
    require(systemIndicators(text,YES)==0,@"no visible system indicator in actual font/theme");
    NSString *path=[@"tasks/sumi-native" stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:path atomically:YES];
    printf("%s fixed_rect=%s pixels=%ld/%ld system=0\n",name.UTF8String,NSStringFromRect(actual).UTF8String,(long)matched,(long)total);
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
    editor.appearance=@{@"font_family":@"Menlo",@"font_size":@30,@"line_height":@1.6,@"foreground":@"#ff0000",@"background":@"#ffffff",@"caret_motion":@"steady"};
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
    [text refreshTypewriterCaret:NO];
    CaretInputAudit *audit=[CaretInputAudit new];audit.text=text;
    for(NSString *key in @[@"hidden",@"frame"])[text.typewriterCaret addObserver:audit forKeyPath:key options:0 context:NULL];
    [text addObserver:audit forKeyPath:@"insertionPointColor" options:0 context:NULL];
    [text.typewriterCaret.layer addObserver:audit forKeyPath:@"opacity" options:0 context:NULL];
    audit.watching=YES;
    NSUInteger step=0;
    for(NSString *marked in @[@"n",@"ni",@"ni hao",@"你好"]){
        [text setMarkedText:marked selectedRange:NSMakeRange(marked.length,0) replacementRange:step==0?NSMakeRange(3,0):NSMakeRange(NSNotFound,0)];
        require(!text.typewriterCaret.hidden && !NSIsEmptyRect(text.typewriterCaret.frame),@"steady caret already exists immediately when marked-text update returns");
        customVertical(captureRaster(text,[NSString stringWithFormat:@"caret-render-ime-%lu",(unsigned long)step],NO,NO));
        NSRect candidate=[text firstRectForCharacterRange:NSMakeRange(text.selectedRange.location,0) actualRange:NULL];
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        customVertical(captureRaster(text,[NSString stringWithFormat:@"caret-render-ime-settled-%lu",(unsigned long)step++],NO,NO));
        require(NSEqualRects(candidate,[text firstRectForCharacterRange:NSMakeRange(text.selectedRange.location,0) actualRange:NULL]),@"caret refresh leaves public IME candidate geometry unchanged");
    }
    [text insertText:@"你好" replacementRange:NSMakeRange(NSNotFound,0)];
    customVertical(captureRaster(text,@"caret-render-after-ime",NO,NO));
    require([text.string isEqualToString:@"ABC你好"] && editor.revision==1,@"raster/IME path preserves the single input transaction");
    for(NSString *letter in @[@"x",@"y",@"z"]){
        [text insertText:letter replacementRange:text.selectedRange];
        customVertical(captureRaster(text,[@"caret-render-typing-" stringByAppendingString:letter],NO,NO));
    }
    audit.watching=NO;
    printf("INPUT AUDIT observations=%lu gaps=%lu visible_system_colors=%lu\n",(unsigned long)audit.observations,(unsigned long)audit.gaps,(unsigned long)audit.visibleSystemColors);
    require(audit.observations>=20 && audit.gaps==0 && audit.visibleSystemColors==0,@"continuous KVO audit detects no transient steady-caret gap or visible system color during input");
    for(NSString *key in @[@"hidden",@"frame"])[text.typewriterCaret removeObserver:audit forKeyPath:key];
    [text removeObserver:audit forKeyPath:@"insertionPointColor"];
    [text.typewriterCaret.layer removeObserver:audit forKeyPath:@"opacity"];
    // Match the user's actual failing preferences, using only bundled fonts
    // and a synthetic off-screen document, never their writing or window.
    NSString *fontPath=[NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:@"src-tauri/resources/sumi/ZhaohuaTypeWriter.ttf"];
    require(sumi_editor_register_font(fontPath.UTF8String,"ZhaohuaTypeWriter-Light",NULL)==0,@"register actual Zhaohua bundled face");
    require(sumi_editor_register_cascade("{\"alias\":\"Sumi Zhaohua\",\"families\":[\"ZhaohuaTypeWriter-Light\"]}",NULL)==0,@"register actual Zhaohua preset");
    CaretSumiControl *zhaohua=[[CaretSumiControl alloc]initUsingTextLayoutManager:YES];SumiEditor *zhaohuaOwner=owner(zhaohua);NSWindow *zhaohuaWindow=prepare(zhaohua);
    zhaohuaOwner.appearance=@{@"font_family":@"Sumi Zhaohua",@"font_size":@32,@"line_height":@1.6,@"max_columns":@80,@"bottom_inset":@20,@"foreground":@"#44413c",@"background":@"#f3ead7",@"caret_motion":@"steady"};
    zhaohuaOwner.committed=zhaohua.string;zhaohua.delegate=zhaohuaOwner;[zhaohuaOwner applyStyles];[zhaohua refreshTypewriterCaret:NO];
    require([((NSFont *)[zhaohua.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL]).fontName isEqualToString:@"ZhaohuaTypeWriter-Light"],@"production text storage uses exact 32pt Zhaohua face");
    CaretInputAudit *zhaohuaAudit=[CaretInputAudit new];zhaohuaAudit.text=zhaohua;
    for(NSString *key in @[@"hidden",@"frame"])[zhaohua.typewriterCaret addObserver:zhaohuaAudit forKeyPath:key options:0 context:NULL];
    [zhaohua addObserver:zhaohuaAudit forKeyPath:@"insertionPointColor" options:0 context:NULL];
    [zhaohua.typewriterCaret.layer addObserver:zhaohuaAudit forKeyPath:@"opacity" options:0 context:NULL];zhaohuaAudit.watching=YES;
    sampleThemeCaret(zhaohua,@"caret-zhaohua-before");step=0;
    for(NSString *marked in @[@"z",@"zh",@"zhong",@"中文"]){
        [zhaohua setMarkedText:marked selectedRange:NSMakeRange(marked.length,0) replacementRange:step==0?NSMakeRange(3,0):NSMakeRange(NSNotFound,0)];
        sampleThemeCaret(zhaohua,[NSString stringWithFormat:@"caret-zhaohua-marked-%lu",(unsigned long)step++]);
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    [zhaohua insertText:@"中文" replacementRange:NSMakeRange(NSNotFound,0)];sampleThemeCaret(zhaohua,@"caret-zhaohua-commit");
    [zhaohua insertText:@"x" replacementRange:zhaohua.selectedRange];sampleThemeCaret(zhaohua,@"caret-zhaohua-typing");
    [zhaohua setMarkedText:@"替换子句" selectedRange:NSMakeRange(1,2) replacementRange:NSMakeRange(3,2)];
    require(zhaohua.selectedRange.length==2,@"IME retains its actual selected clause");
    sampleThemeCaret(zhaohua,@"caret-zhaohua-clause");
    NSRect clauseCandidate=[zhaohua firstRectForCharacterRange:zhaohua.selectedRange actualRange:NULL];
    [zhaohua refreshTypewriterCaret:NO];
    require(NSEqualRects(clauseCandidate,[zhaohua firstRectForCharacterRange:zhaohua.selectedRange actualRange:NULL]),@"selected-clause candidate geometry is unchanged");
    [zhaohua insertText:@"替换" replacementRange:NSMakeRange(NSNotFound,0)];sampleThemeCaret(zhaohua,@"caret-zhaohua-replacement");
    require([zhaohua.string isEqualToString:@"ABC替换x"],@"marked text replaces only the requested canonical range");
    [zhaohua insertText:@"\n" replacementRange:zhaohua.selectedRange];sampleThemeCaret(zhaohua,@"caret-zhaohua-newline");
    [zhaohua setMarkedText:@"下一行" selectedRange:NSMakeRange(3,0) replacementRange:zhaohua.selectedRange];sampleThemeCaret(zhaohua,@"caret-zhaohua-next-line-ime");
    [zhaohua insertText:@"下一行" replacementRange:NSMakeRange(NSNotFound,0)];sampleThemeCaret(zhaohua,@"caret-zhaohua-next-line-commit");
    zhaohuaAudit.watching=NO;
    printf("ZHAOHUA INPUT AUDIT observations=%lu gaps=%lu visible_system_colors=%lu\n",(unsigned long)zhaohuaAudit.observations,(unsigned long)zhaohuaAudit.gaps,(unsigned long)zhaohuaAudit.visibleSystemColors);
    require(zhaohuaAudit.observations>0 && zhaohuaAudit.gaps==0 && zhaohuaAudit.visibleSystemColors==0,@"actual Zhaohua/32/sepia/steady preferences remain continuously visible during composition and input");
    for(NSString *key in @[@"hidden",@"frame"])[zhaohua.typewriterCaret removeObserver:zhaohuaAudit forKeyPath:key];
    [zhaohua removeObserver:zhaohuaAudit forKeyPath:@"insertionPointColor"];[zhaohua.typewriterCaret.layer removeObserver:zhaohuaAudit forKeyPath:@"opacity"];
    CaretSuppressionMutation *mutant=[[CaretSuppressionMutation alloc]initUsingTextLayoutManager:YES];SumiEditor *mutationOwner=owner(mutant);NSWindow *mutationWindow=prepare(mutant);
    NSDictionary *mutation=capture(mutant,@"caret-render-mutation",NO);
    require([mutation[@"system_indicators"] integerValue]>0,@"removing production suppression exposes the real duplicate system indicator");
    require(mutationOwner.text==mutant,@"mutation owner stays alive for the whole control");
    require(!systemWindow.visible && !window.visible && !zhaohuaWindow.visible && !mutationWindow.visible && !NSApp.active,@"no window was shown and app never activated");
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"user's foreground application unchanged");
    printf("PASS: real modern positive control, uninterrupted custom steady caret through markedText/commit/typing, candidate geometry, suppression mutation; no window activation\n");
}}
