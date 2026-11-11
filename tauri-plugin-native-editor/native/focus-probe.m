// Offscreen, real TextKit line rendering and input mapping. Never requests TCC.
#import "editor.m"
#import <objc/runtime.h>
static BOOL interpretedMarked,interpretedFocus;
static unsigned short interpretedCode;
@interface FocusProbeText : SumiTextView
@end
@implementation FocusProbeText
- (BOOL)caretSurfaceActive {return self.window.firstResponder==self && !self.isHiddenOrHasHiddenAncestor;}
- (void)interpretKeyEvents:(NSArray<NSEvent *> *)input {if(input.count){interpretedMarked=self.hasMarkedText;interpretedFocus=self.focusView!=nil;interpretedCode=input.firstObject.keyCode;}[super interpretKeyEvents:input];}
@end
static NSMutableArray *events;
static NSUInteger checks;
static NSInteger rejectEdit;
static BOOL probeMotionEnabled(id receiver,SEL selector){(void)receiver;(void)selector;return NO;}
static BOOL probeMotionReduced(id receiver,SEL selector){(void)receiver;(void)selector;return YES;}
static void require(BOOL ok,NSString *message){checks++;if(!ok){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *ctx,const char *json,char **reply){(void)ctx;(void)reply;NSDictionary *event=SumiJSON(json);[events addObject:event];if(rejectEdit && [event[@"kind"] isEqual:@"edit"]){NSInteger code=rejectEdit;rejectEdit=0;if(code==-2)*reply=strdup("{\"draft_error\":\"synthetic journal failure\"}");return code;}return [event[@"kind"] isEqual:@"edit"]?[event[@"base_revision"] longLongValue]+1:[event[@"revision"] longLongValue];}
static void replyFree(char *value){free(value);}
static NSEvent *key(NSWindow *window,NSString *text,unsigned short code){return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];}
static NSEvent *modifiedKey(NSWindow *window,NSString *value,unsigned short code,NSEventModifierFlags flags){return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:value charactersIgnoringModifiers:value isARepeat:NO keyCode:code];}
static void checkVerticalStep(SumiTextView *text,NSWindow *window,BOOL up){
    SumiFocusView *view=text.focusView;require(view!=nil,@"navigation fixture has focused presentation");
    SumiFocusRow *active=view.rows.firstObject,*neighbor=nil;CGFloat distance=CGFLOAT_MAX;
    for(SumiFocusRow *row in view.rows){CGFloat d=NSMidY(NSMakeRect(0,row.rawOrigin.y,1,row.height))-NSMidY(NSMakeRect(0,active.rawOrigin.y,1,active.height));if((up?d<-.1:d>.1)&&fabs(d)<distance){distance=fabs(d);neighbor=row;}}
    NSRange expected=neighbor?neighbor.range:active.range;CGFloat shift=neighbor?(active.rawOrigin.y+active.height*.5)-(neighbor.rawOrigin.y+neighbor.height*.5):0;
    NSMutableDictionary *points=[NSMutableDictionary new];for(SumiFocusRow *row in view.rows)points[NSStringFromRange(row.range)]=[NSValue valueWithPoint:row.origin];
    NSAttributedString *body=[text.textStorage copy];NSUInteger revision=text.owner.revision;CFTimeInterval activity=view.lastActivity;NSTimer *idle=view.idleTimer;CGFloat strength=view.strength;BOOL undo=text.undoManager.canUndo,redo=text.undoManager.canRedo;NSInteger grouping=text.undoManager.groupingLevel;
    NSUInteger edits=0;for(NSDictionary *event in events)edits+=[event[@"kind"] isEqual:@"edit"];
    [text keyDown:key(window,up?@"\uf700":@"\uf701",up?126:125)];
    require(text.focusView==view,@"plain vertical key retains the same focus view");
    require(NSEqualRanges(view.rows.firstObject.range,expected),@"native Up/Down moves to the adjacent real visual row or stays at document boundary");
    active=view.rows.firstObject;require(fabs(active.origin.y+active.height*.5-NSMidY(view.bounds))<.01,@"new active row stays on the exact viewport center");
    NSUInteger common=0;for(SumiFocusRow *row in view.rows){NSValue *point=points[NSStringFromRange(row.range)];if(!point)continue;NSPoint old=point.pointValue;require(fabs(row.origin.x-old.x)<.01 && fabs(row.origin.y-old.y-shift)<.05,@"every shared row scrolls by one identical native line distance with the inverse direction");common++;}
    require(common>0,@"vertical movement retains overlapping visible document rows");
    require(view.lastActivity==activity && view.idleTimer==idle && view.strength==strength,@"vertical reading preserves typing deadline and current fade strength");
    NSUInteger afterEdits=0;for(NSDictionary *event in events)afterEdits+=[event[@"kind"] isEqual:@"edit"];
    require([body isEqualToAttributedString:text.textStorage] && text.owner.revision==revision && afterEdits==edits && text.undoManager.canUndo==undo && text.undoManager.canRedo==redo && text.undoManager.groupingLevel==grouping,@"vertical focus scrolling preserves full attributed text revision and undo state");
    NSRect raw=[text.owner rectForInsertion:text.selectedRange.location],projected=[text focusRect:raw];require(fabs(NSMidY(projected)-NSMidY(view.bounds))<=active.height && projected.size.height==raw.size.height,@"caret projection follows the centered native row without scaling");
    NSRange actual;NSRect candidate=[text firstRectForCharacterRange:text.selectedRange actualRange:&actual];require(!NSIsEmptyRect(candidate),@"vertical movement keeps native candidate geometry available");
}
static void capture(NSView *view,NSString *path){[view layoutSubtreeIfNeeded];NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];}
int main(int argc,const char **argv){@autoreleasepool{if(@available(macOS 13.0,*)){
    [NSApplication sharedApplication];events=[NSMutableArray new];
    BOOL systemReduceMotion=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    Method motionMethod=class_getInstanceMethod(NSWorkspace.class,@selector(accessibilityDisplayShouldReduceMotion));
    IMP originalMotion=method_setImplementation(motionMethod,(IMP)probeMotionEnabled);
    printf("SYSTEM reduce_motion=%s; animation test overrides only this process query, never system preference\n",systemReduceMotion?"true":"false");
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,960,720) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    NSString *body=@"雨停以后，我把窗推开了一些，街道上的灯光映在湿润的石板上，像一封还没有写完的信。我坐回桌前，听见远处偶尔传来车轮经过的声音。白天那些纷乱的念头终于慢了下来，不再催促我立刻找到答案。我只是沿着刚才的句子继续往下写，想起一个很久没有见面的人，也想起曾经走过的那条小路。夜色渐深，我仍想把这一刻认真写下。\n第二段仍由TextKit保留原来的折行。\n上一行文字。\n接下来连续输入";
    NSDictionary *config=@{@"surface_id":@"focus",@"generation":@1,@"revision":@0,@"bounds":@{@"x":@0,@"y":@0,@"width":@960,@"height":@720},@"appearance":@{@"font_family":@"Sumi System",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#44413c",@"background":@"#f3ead7",@"max_columns":@60,@"bottom_inset":@0,@"caret_motion":@"steady",@"focus_typing":@YES},@"document":@{@"text":body,@"runs":@[]}};
    NSData *json=[NSJSONSerialization dataWithJSONObject:config options:0 error:nil];NSString *string=[[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding];
    void *handle=sumi_editor_mount((__bridge void*)window.contentView,0,string.UTF8String,receive,replyFree,NULL);require(handle!=NULL,@"mount");
    SumiEditor *owner=(__bridge SumiEditor*)handle;SumiTextView *text=owner.text;object_setClass(text,FocusProbeText.class);[window makeFirstResponder:text];[text setSelectedRange:NSMakeRange(body.length,0)];
    [text recordFocusInputAt:10];[text recordFocusInputAt:13];[text recordFocusInputAt:16];require(!text.focusView,@"isolated edits remain reading");
    [text stopFocusTyping];
    for(NSNumber *time in @[@0,@1.5,@1.8,@2.1])[text recordFocusInputAt:time.doubleValue];
    require(!text.focusView,@"expired first input leaves only three events in the rolling two-second window");
    [text recordFocusInputAt:2.2];
    require(text.focusView!=nil,@"four recent inputs enter focus even when the first burst crossed its original two-second boundary");
    [text stopFocusTyping];
    for(NSNumber *time in @[@10,@10.5,@11,@12])[text recordFocusInputAt:time.doubleValue];
    require(text.focusView!=nil,@"input exactly two seconds old remains eligible like Linux");
    [text stopFocusTyping];
    for(NSNumber *time in @[@30,@30.1,@29,@29.1,@29.2])[text recordFocusInputAt:time.doubleValue];
    require(!text.focusView,@"clock rewind discards the previous typing burst");
    [text recordFocusInputAt:29.3];require(text.focusView!=nil,@"four inputs after clock rewind enter focus normally");
    [text stopFocusTyping];[text recordFocusInputAt:40];
    require(!text.focusView && text.focusInputCount==1,@"leaving focus clears the rolling history before a new reading session");
    [text stopFocusTyping];
    for(int n=0;n<3;n++)[text keyDown:key(window,@"a",0)];require(!text.focusView,@"first three inputs remain reading");
    [text keyDown:key(window,@"b",11)];require(text.focusView!=nil,@"four continuous native input events enter focus");
    require(text.focusView.progress<1 && text.focusView.timer!=nil,@"entry starts the real native transition timer with motion enabled");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.10]];
    require(text.focusView.progress>.1 && text.focusView.progress<.9,@"actual animation is between endpoints near half the200ms duration");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.5]];
    require(text.focusView.rows.count>5,@"viewport shows more than five actual visual lines");require(text.focusView.progress==1,@"200ms transition completes");
    SumiFocusRow *current=text.focusView.rows.firstObject;
    require(fabs(current.origin.y+current.height*.5-NSMidY(text.focusView.bounds))<.01,@"current visual line center at50 percent");
    for(SumiFocusRow *row in text.focusView.rows){
        require(fabs(row.origin.x-row.rawOrigin.x)<.01,@"focus keeps the exact original x origin and indentation");
        require(fabs((row.origin.y-current.origin.y)-(row.rawOrigin.y-current.rawOrigin.y))<.01,@"focus preserves exact TextKit line spacing");
        NSPoint probe=NSMakePoint(row.rawOrigin.x+12,row.rawOrigin.y+row.height/2);NSRect projected=[text focusRect:NSMakeRect(probe.x,probe.y,1,1)];NSPoint recovered=[text focusOriginalPoint:projected.origin];require(fabs(probe.x-recovered.x)<.01 && fabs(probe.y-recovered.y)<.01,@"click inverse maps translated line to original TextKit coordinates");
        require(fabs(projected.size.width-1)<.01 && fabs(projected.size.height-1)<.01,@"focus projection never changes glyph or caret dimensions");
    }
    NSString *before=text.string.copy;NSUInteger revision=owner.revision;NSRange selection=text.selectedRange;
    [text updateFocusRows];require([text.string isEqual:before] && owner.revision==revision && NSEqualRanges(text.selectedRange,selection),@"presentation does not mutate text revision or selection");
    [text setMarkedText:@"拼音" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];[text updateFocusRows];
    require(text.hasMarkedText && owner.composing && text.focusView,@"markedText remains owned by real native editor");
    NSRange actual;NSRect candidate=[text firstRectForCharacterRange:text.selectedRange actualRange:&actual];require(!NSIsEmptyRect(candidate),@"IME receives projected screen geometry");[text unmarkText];
    [text updateFocusRows];
    if(argc>1){NSView *view=owner.container;[view layoutSubtreeIfNeeded];NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES];}
    [text keyDown:key(window,@"\uf703",124)];require(!text.focusView,@"horizontal arrow returns to reading");
    NSMutableDictionary *appearance=[owner.appearance mutableCopy];appearance[@"focus_typing"]=@NO;owner.appearance=appearance;
    for(int n=0;n<5;n++)[text keyDown:key(window,@"c",8)];require(!text.focusView,@"disabled preference remains reading");
    // Reuse one continuous paragraph in both renderings, with real native caret.
    NSString *paragraph=[body componentsSeparatedByString:@"\n"].firstObject;
    appearance[@"focus_typing"]=@YES;appearance[@"max_columns"]=@40;owner.appearance=appearance;
    [owner applyProjection:@{@"document":@{@"text":paragraph,@"runs":@[]},@"selection":SumiRange(NSMakeRange(paragraph.length,0))} revision:owner.revision+1];[owner layoutEditor];
    for(int n=0;n<4;n++)[text keyDown:key(window,@"风",3)];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.45]];
    require(text.focusView.rows.count>5 && text.focusView.rows.firstObject.range.location<text.selectedRange.location,@"one long paragraph includes actual current fragment and previous wrapped rows");
    if(argc>1){NSString *path=[NSString stringWithUTF8String:argv[1]];capture(owner.container,[path stringByAppendingString:@".sepia.png"]);}
    // Exactly on a visual wrap boundary, current row must be the downstream row.
    NSUInteger boundary=text.focusView.rows[2].range.location;[text stopFocusTyping];[text setSelectedRange:NSMakeRange(boundary,0)];
    for(int n=0;n<4;n++)[text recordFocusInputAt:100+n*.1];
    require(text.focusView.rows.firstObject.range.location==boundary,@"visual wrap boundary selects downstream current row");
    [text stopFocusTyping];[text setSelectedRange:NSMakeRange(text.string.length,0)];
    for(int n=0;n<4;n++)[text keyDown:key(window,@"x",7)];
    [text keyDown:key(window,@"\r",36)];
    require(text.focusView && text.focusView.rows.firstObject.range.location==text.string.length,@"trailing newline has a real empty current line");
    [text stopFocusTyping];
    // Restore identical continuous paragraph for screenshot comparisons.
    [owner applyProjection:@{@"document":@{@"text":paragraph,@"runs":@[]},@"selection":SumiRange(NSMakeRange(paragraph.length,0))} revision:owner.revision+1];
    [text scrollRangeToVisible:text.selectedRange];
    if(argc>1){NSString *path=[NSString stringWithUTF8String:argv[1]];capture(owner.container,[path stringByAppendingString:@".reading.png"]);}
    for(int n=0;n<4;n++)[text recordFocusInputAt:200+n*.1];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.45]];
    if(argc>1){NSString *path=[NSString stringWithUTF8String:argv[1]];capture(owner.container,[path stringByAppendingString:@".sepia.png"]);}
    appearance[@"foreground"]=@"#b8b8b8";appearance[@"background"]=@"#111111";owner.appearance=appearance;[owner applyStyles];[text updateFocusRows];
    if(argc>1){NSString *path=[NSString stringWithUTF8String:argv[1]];capture(owner.container,[path stringByAppendingString:@".dim.png"]);}
    // A real AppKit mouseDown receives an inverse-projected position before the
    // presentation disappears; queue only its matching mouseUp in this hidden window.
    SumiFocusRow *clicked=text.focusView.rows[1];NSPoint sourcePoint=NSMakePoint(clicked.rawOrigin.x+20,clicked.rawOrigin.y+clicked.height*.5);
    NSRect drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];
    NSUInteger expected=[text focusCharacterIndexAtPoint:drawn.origin];NSPoint windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];
    NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:0];
    [NSApp postEvent:up atStart:YES];
    NSEvent *down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    [text mouseDown:down];require(!text.focusView && NSEqualRanges(text.selectedRange,NSMakeRange(expected,0)),@"click in transformed previous line selects the correct original character");
    // Native selection ranges with explicit focus-to-reading mouse tracking.
    [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:250+n*.1];text.focusView.progress=1;text.focusView.strength=1;
    clicked=text.focusView.rows[1];sourcePoint=NSMakePoint(clicked.rawOrigin.x+25,clicked.rawOrigin.y+clicked.height*.5);
    NSPoint targetPoint=NSMakePoint(sourcePoint.x+140,sourcePoint.y);
    drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];
    NSRect targetDrawn=[text focusRect:NSMakeRect(targetPoint.x,targetPoint.y,0,0)];
    NSPoint dragPoint=[text.focusView convertPoint:targetDrawn.origin toView:nil];
    [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:dragPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:0] atStart:YES];
    [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:dragPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1] atStart:YES];
    down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:1];
    before=text.string.copy;revision=owner.revision;[text mouseDown:down];
    require(text.selectedRange.length>0 && text.selectedRange.location>=clicked.range.location && NSMaxRange(text.selectedRange)<=NSMaxRange(clicked.range),@"projected same-row drag cannot select a different paragraph");
    require([text.string isEqual:before] && owner.revision==revision,@"drag modifies selection only, not document or accepted revision");
    NSRect selectedRect=[owner rectForInsertion:text.selectedRange.location];selectedRect.size.width=MAX(1,selectedRect.size.width);
    require(NSIntersectsRect(selectedRect,text.visibleRect),@"restored selection is readable after drag");
    // Selection changes, scrolling, rejection and appearance changes never count as typing.
    [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:260+n*.1];
    NSUInteger count=events.count;before=text.string.copy;revision=owner.revision;
    [NSNotificationCenter.defaultCenter postNotificationName:NSScrollViewWillStartLiveScrollNotification object:owner.scroll];
    require(!text.focusView && [text.string isEqual:before] && owner.revision==revision && events.count==count,@"live scrolling exits without an edit or host action");
    for(int n=0;n<4;n++)[text recordFocusInputAt:270+n*.1];
    [owner retainDraft:@{@"document":@{@"text":before,@"runs":@[]},@"selection":SumiRange(text.selectedRange)} error:@"synthetic journal failure"];
    for(int n=0;n<8;n++)[text recordFocusInputAt:280+n*.1];
    require(!text.focusView && !text.editable && owner.revision==revision && [text.string isEqual:before],@"P0 retained draft exits focus, stays frozen and cannot reenter");
    [owner applyProjection:@{@"document":@{@"text":before,@"runs":@[]},@"selection":SumiRange(text.selectedRange)} revision:revision+1];
    require(text.editable && !owner.draftError,@"explicit successful projection alone unfreezes draft");
    [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:300+n*.1];
    [owner setBounds:@{@"x":@0,@"y":@0,@"width":@320,@"height":@180}];
    require(text.focusView.rows.count>=1 && text.focusView.rows.count<20,@"short viewport draws only physically visible rows");
    current=text.focusView.rows.firstObject;require(current.origin.y>=0 && current.origin.y+current.height<=180,@"current line fits short viewport");
    [text stopFocusTyping];
    [owner setBounds:@{@"x":@0,@"y":@0,@"width":@960,@"height":@720}];
    [owner applyProjection:@{@"document":@{@"text":@"",@"runs":@[]},@"selection":SumiRange(NSMakeRange(0,0))} revision:owner.revision+1];
    for(int n=0;n<4;n++)[text recordFocusInputAt:310+n*.1];
    require(text.focusView.rows.count==1 && text.focusView.rows.firstObject.range.location==0,@"empty document has an editable current line");
    [text stopFocusTyping];
    NSString *longText=[@"中文 writing 👩‍💻 é " stringByPaddingToLength:100000 withString:@"中文 writing 👩‍💻 é " startingAtIndex:0];
    [owner applyProjection:@{@"document":@{@"text":longText,@"runs":@[]},@"selection":SumiRange(NSMakeRange(100,0))} revision:owner.revision+1];
    before=text.string.copy;revision=owner.revision;count=events.count;
    for(int n=0;n<4;n++)[text recordFocusInputAt:320+n*.1];
    for(int n=0;n<20;n++)[text updateFocusRows];
    require(text.focusView.rows.count>5 && text.focusView.rows.count<100 && [text.string isEqual:before] && owner.revision==revision && events.count==count,@"100k paragraph near start draws bounded rows without edit events");
    [text stopFocusTyping];
    // Regression for a physical click after reading scroll + reentry: a raw
    // mouseUp at the displayed location must never extend a synthetic selection.
    NSMutableString *scrolling=[NSMutableString new];for(int n=0;n<8;n++)[scrolling appendFormat:@"%@\n",paragraph];[scrolling appendString:@"abcdefghi"];
    [owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
    for(int n=0;n<4;n++)[text recordFocusInputAt:350+n*.1];text.focusView.progress=1;text.focusView.strength=1;
    clicked=text.focusView.rows.firstObject;sourcePoint=NSMakePoint(clicked.rawOrigin.x+30,clicked.rawOrigin.y+clicked.height*.5);drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];expected=[text focusCharacterIndexAtPoint:drawn.origin];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];
    [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:1 pressure:0] atStart:YES];
    [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:1 pressure:1]];
    require(NSEqualRanges(text.selectedRange,NSMakeRange(expected,0)),@"long scrolled page focus click plus real-coordinate mouseUp leaves only insertion point");
    [text insertText:@"x" replacementRange:NSMakeRange(NSNotFound,0)];
    require([text.string isEqual:[scrolling stringByReplacingCharactersInRange:NSMakeRange(expected,0) withString:@"x"]],@"typing after long-page focus click cannot replace a previous paragraph");
    for(NSNumber *progress in @[@.5,@1])for(NSNumber *rowNumber in @[@0,@1]){
        [text stopFocusTyping];[owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
        for(int n=0;n<4;n++)[text recordFocusInputAt:355+n*.1];text.focusView.progress=progress.doubleValue;text.focusView.strength=progress.doubleValue;
        clicked=text.focusView.rows[rowNumber.unsignedIntegerValue];NSUInteger offset=MIN((NSUInteger)3,clicked.range.length);
        NSPoint glyph=[clicked.line locationForCharacterAtIndex:clicked.line.characterRange.location+offset];
        sourcePoint=NSMakePoint(clicked.rawOrigin.x+glyph.x+.01,clicked.rawOrigin.y+clicked.height*.5);expected=clicked.range.location+offset;
        drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,0,0)];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];
        require([text focusCharacterIndexAtPoint:drawn.origin]==expected,@"actual laid-out glyph index survives animated inverse hit");
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:5 clickCount:1 pressure:0] atStart:YES];
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:NSMakePoint(windowPoint.x+1,windowPoint.y+1) modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:5 clickCount:1 pressure:1] atStart:YES];
        revision=owner.revision;[text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:5 clickCount:1 pressure:1]];
        require(NSEqualRanges(text.selectedRange,NSMakeRange(expected,0)) && owner.revision==revision,@"one-pixel jitter at animated current/previous row cannot create a range");
        [text insertText:@"x" replacementRange:NSMakeRange(NSNotFound,0)];
        require([text.string isEqual:[scrolling stringByReplacingCharactersInRange:NSMakeRange(expected,0) withString:@"x"]],@"animated/jitter click followed by typing preserves all surrounding paragraphs");
    }
    for(NSNumber *progress in @[@.5,@1])for(NSNumber *reverse in @[@NO,@YES]){
        [text stopFocusTyping];[owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
        for(int n=0;n<4;n++)[text recordFocusInputAt:357+n*.1];text.focusView.progress=progress.doubleValue;text.focusView.strength=progress.doubleValue;clicked=text.focusView.rows.firstObject;
        require(clicked.range.location==scrolling.length-9,@"known abcdefghi fixture is the current actual visual line");
        NSPoint glyphA=[clicked.line locationForCharacterAtIndex:clicked.line.characterRange.location],glyphD=[clicked.line locationForCharacterAtIndex:clicked.line.characterRange.location+3];
        NSRect rectA=[text focusRect:NSMakeRect(clicked.rawOrigin.x+glyphA.x+.01,clicked.rawOrigin.y+clicked.height*.5,0,0)],rectD=[text focusRect:NSMakeRect(clicked.rawOrigin.x+glyphD.x+.01,clicked.rawOrigin.y+clicked.height*.5,0,0)];
        NSPoint pointA=[text.focusView convertPoint:rectA.origin toView:nil],pointD=[text.focusView convertPoint:rectD.origin toView:nil];NSPoint from=reverse.boolValue?pointD:pointA,to=reverse.boolValue?pointA:pointD;
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:to modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:6 clickCount:1 pressure:0] atStart:YES];
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:to modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:6 clickCount:1 pressure:1] atStart:YES];
        revision=owner.revision;[text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:from modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:6 clickCount:1 pressure:1]];
        NSRange abc=NSMakeRange(scrolling.length-9,3);
        require(NSEqualRanges(text.selectedRange,abc) && [[text.string substringWithRange:text.selectedRange] isEqual:@"abc"] && owner.revision==revision,@"same projected-row drag in both directions selects only known abc during/after animation");
        [text insertText:@"x" replacementRange:NSMakeRange(NSNotFound,0)];require([text.string isEqual:[scrolling stringByReplacingCharactersInRange:abc withString:@"x"]],@"typing after projected drag replaces only abc, preserving every paragraph");
    }
    // Word and shift-click use NSTextView's selection granularity but no text edit.
    for(NSNumber *clicks in @[@2,@1]){
        [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:360+n*.1];text.focusView.progress=1;text.focusView.strength=1;
        clicked=text.focusView.rows.firstObject;sourcePoint=NSMakePoint(clicked.rawOrigin.x+30,clicked.rawOrigin.y+clicked.height*.5);drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];expected=[text focusCharacterIndexAtPoint:drawn.origin];
        NSRange expectedSelection=clicks.intValue==2?[text selectionRangeForProposedRange:NSMakeRange(expected,0) granularity:NSSelectByWord]:NSMakeRange(expected,text.string.length-expected);
        NSEventModifierFlags flags=clicks.intValue==1?NSEventModifierFlagShift:0;
        drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];before=text.string.copy;
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:flags timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:4 clickCount:clicks.intValue pressure:0] atStart:YES];
        [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:flags timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:4 clickCount:clicks.intValue pressure:1]];
        require(NSEqualRanges(text.selectedRange,expectedSelection) && [text.string isEqual:before],@"focus word and shift clicks use native ranges without editing");
    }
    // Composition handoff uses the same safe commit barrier as opening a panel.
    for(NSNumber *outcome in @[@0,@-1,@-2]){
        [text stopFocusTyping];[owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
        [text setMarkedText:@"nihao" selectedRange:NSMakeRange(5,0) replacementRange:NSMakeRange(NSNotFound,0)];
        for(int n=0;n<4;n++)[text recordFocusInputAt:370+n*.1];text.focusView.progress=1;text.focusView.strength=1;clicked=text.focusView.rows[1];
        NSPoint glyph=[clicked.line locationForCharacterAtIndex:clicked.line.characterRange.location+2];sourcePoint=NSMakePoint(clicked.rawOrigin.x+glyph.x+.01,clicked.rawOrigin.y+clicked.height*.5);expected=clicked.range.location+2;
        drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,0,0)];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];before=text.string.copy;selection=text.selectedRange;revision=owner.revision;rejectEdit=outcome.integerValue;
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:7 clickCount:1 pressure:0] atStart:YES];
        [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:7 clickCount:1 pressure:1]];
        [NSApp nextEventMatchingMask:NSEventMaskLeftMouseUp untilDate:NSDate.distantPast inMode:NSEventTrackingRunLoopMode dequeue:YES];
        if(outcome.integerValue==0){
            require(!text.hasMarkedText && !owner.composing && NSEqualRanges(text.selectedRange,NSMakeRange(expected,0)),@"successful preedit commit rebuilds laid-out lines before handing click selection over");
            [text insertText:@"X" replacementRange:NSMakeRange(NSNotFound,0)];require([text.string isEqual:[before stringByReplacingCharactersInRange:NSMakeRange(expected,0) withString:@"X"]],@"IME callback click followed by input preserves preedit and all other text");
        }else if(outcome.integerValue==-1){
            require(text.hasMarkedText && owner.composing && [text.string isEqual:before] && NSEqualRanges(text.selectedRange,selection) && owner.revision==revision,@"rejected preedit commit retains marked text and refuses selection handoff");[text unmarkText];
        }else{
            require(owner.draftError && !text.editable && [text.string isEqual:before] && owner.revision==revision && !text.focusView,@"journal-rejected IME handoff retains protected draft and never moves to another line");
        }
    }
    [owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];
    for(NSString *interruption in @[@"remote",@"hidden",@"inactive"]){
        owner.container.hidden=NO;[window makeFirstResponder:text];[text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:380+n*.1];text.focusView.progress=1;text.focusView.strength=1;
        clicked=text.focusView.rows.firstObject;drawn=[text focusRect:NSMakeRect(clicked.rawOrigin.x+1,clicked.rawOrigin.y+clicked.height*.5,0,0)];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];before=text.string.copy;revision=owner.revision;
        NSTimer *interrupt=[NSTimer timerWithTimeInterval:.01 repeats:NO block:^(NSTimer *timer){(void)timer;
            if([interruption isEqual:@"remote"])[owner applyProjection:@{@"document":@{@"text":@"remote paragraph change",@"runs":@[]},@"selection":SumiRange(NSMakeRange(5,0))} revision:owner.revision+1];
            else if([interruption isEqual:@"hidden"])owner.container.hidden=YES;
            else [text caretWindowChanged:nil];
        }];[NSRunLoop.currentRunLoop addTimer:interrupt forMode:NSEventTrackingRunLoopMode];CFTimeInterval start=CACurrentMediaTime();
        [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:8 clickCount:1 pressure:1]];
        require(CACurrentMediaTime()-start<1 && !text.focusTracking && !text.focusView,@"remote/hide/inactive invalidation exits pointer tracking without waiting forever for missing mouseUp");
        if([interruption isEqual:@"remote"])require([text.string isEqual:@"remote paragraph change"] && NSEqualRanges(text.selectedRange,NSMakeRange(5,0)),@"remote projection replaces old line mappings and keeps its authoritative selection");
        else require([text.string isEqual:before] && owner.revision==revision,@"hide/inactive tracking exit preserves exact text and accepted revision");
    }
    owner.container.hidden=NO;[window makeFirstResponder:text];
    // Real Up/Down scrolls the page around a fixed active row. This fixture
    // mixes soft wrapping, paragraph boundaries and blank physical lines.
    NSMutableString *navigation=[NSMutableString new];
    for(int n=0;n<6;n++)[navigation appendFormat:@"%@\n\nshort row %d\nnext row %d\n",paragraph,n,n];
    NSUInteger navMiddle=navigation.length/2;
    [owner applyProjection:@{@"document":@{@"text":navigation,@"runs":@[]},@"selection":SumiRange(NSMakeRange(navMiddle,0))} revision:owner.revision+1];
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];text.focusView.progress=1;text.focusView.strength=1;
    [text.focusView.timer invalidate];text.focusView.timer=nil;
    SumiFocusView *navigationView=text.focusView;
    for(int n=0;n<14;n++)checkVerticalStep(text,window,YES);
    for(int n=0;n<28;n++)checkVerticalStep(text,window,NO);
    for(int n=0;n<14;n++)checkVerticalStep(text,window,YES);
    require(text.focusView==navigationView,@"many consecutive arrows never replace or exit the focused surface");
    navigationView.strength=0;navigationView.targetStrength=0;checkVerticalStep(text,window,YES);checkVerticalStep(text,window,NO);
    require(navigationView.strength==0,@"idle fully-visible context stays fully visible while navigating");
    navigationView.strength=1;navigationView.targetStrength=1;
    if(argc>1)capture(owner.container,[[NSString stringWithUTF8String:argv[1]] stringByAppendingString:@".vertical-focus.png"]);
    // Boundaries must not invent a row or modify text.
    for(NSNumber *end in @[@NO,@YES]){
        [text stopFocusTyping];[text setSelectedRange:NSMakeRange(end.boolValue?text.string.length:0,0)];
        for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];text.focusView.progress=1;text.focusView.strength=1;[text.focusView.timer invalidate];text.focusView.timer=nil;
        checkVerticalStep(text,window,!end.boolValue);checkVerticalStep(text,window,!end.boolValue);
    }
    [text stopFocusTyping];[text setSelectedRange:NSMakeRange(navMiddle,0)];
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    SumiFocusView *enteringNavigation=text.focusView;NSTimer *entryTimer=enteringNavigation.timer;CFTimeInterval entryStart=enteringNavigation.started;
    require(enteringNavigation.progress<1 && entryTimer.valid,@"entry-navigation fixture has actual in-flight spatial and alpha animation");
    CGFloat entryStrength=enteringNavigation.strength;CFTimeInterval entryActivity=enteringNavigation.lastActivity;
    [text keyDown:key(window,@"\uf700",126)];
    require(text.focusView==enteringNavigation && enteringNavigation.progress==1 && enteringNavigation.fromProgress==1 && enteringNavigation.timer==entryTimer && enteringNavigation.started==entryStart && enteringNavigation.strength==entryStrength && enteringNavigation.lastActivity==entryActivity,@"Up finishes only spatial entry while keeping alpha timer and typing deadline");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.08]];
    require(enteringNavigation.progress==1 && enteringNavigation.strength>entryStrength && enteringNavigation.strength<1,@"subsequent animation ticks cannot pull centered navigation back toward old viewport");
    [text keyDown:key(window,@"\uf701",125)];
    require(text.focusView==enteringNavigation && enteringNavigation.progress==1 && enteringNavigation.lastActivity==entryActivity,@"Down during opacity easing retains focus and original typing activity");
    [text stopFocusTyping];[text setSelectedRange:NSMakeRange(navMiddle,0)];
    [text keyDown:key(window,@"\uf700",126)];[text keyDown:key(window,@"\uf701",125)];require(!text.focusView,@"vertical navigation from ordinary reading never activates focus");
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    [text keyDown:modifiedKey(window,@"\uf700",126,NSEventModifierFlagShift)];require(!text.focusView && text.selectedRange.length>0,@"Shift-Up uses visible native selection in reading layout");
    [text setSelectedRange:NSMakeRange(navMiddle,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    [text keyDown:modifiedKey(window,@"\uf701",125,NSEventModifierFlagCommand)];require(!text.focusView,@"Command-Down keeps its document-jump reading behavior");
    [text stopFocusTyping];[text setSelectedRange:NSMakeRange(navMiddle,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    [text setMarkedText:@"nihao" selectedRange:NSMakeRange(5,0) replacementRange:NSMakeRange(NSNotFound,0)];
    interpretedMarked=NO;interpretedFocus=NO;interpretedCode=0;
    [text keyDown:key(window,@"\uf700",126)];
    require(interpretedMarked && interpretedFocus && interpretedCode==126,@"native key interpreter receives marked-text Up before any forced focus exit or preedit commit");
    [text unmarkText];[text stopFocusTyping];
    // Following text remains genuinely interactive, not just a faded picture.
    NSString *future=@"earlier one\nearlier two\nearlier three\ncurrent input row\nabcdefghi\nlater one\nlater two\nlater three";
    NSUInteger currentEnd=[future rangeOfString:@"current input row"].location+[@"current input row" length];
    NSUInteger nextStart=[future rangeOfString:@"abcdefghi"].location;
    for(NSNumber *progress in @[@.5,@1])for(NSNumber *drag in @[@NO,@YES]){
        [owner applyProjection:@{@"document":@{@"text":future,@"runs":@[]},@"selection":SumiRange(NSMakeRange(currentEnd,0))} revision:owner.revision+1];
        for(int n=0;n<4;n++)[text recordFocusInputAt:385+n*.1];text.focusView.progress=progress.doubleValue;text.focusView.strength=progress.doubleValue;
        SumiFocusRow *following=nil;for(SumiFocusRow *row in text.focusView.rows)if(row.range.location==nextStart)following=row;
        require(following!=nil && following.origin.y>text.focusView.rows.firstObject.origin.y,@"actual next paragraph is visible below focused current line");
        NSPoint glyph0=[following.line locationForCharacterAtIndex:following.line.characterRange.location];
        NSPoint glyph3=[following.line locationForCharacterAtIndex:following.line.characterRange.location+3];
        NSRect first=[text focusRect:NSMakeRect(following.rawOrigin.x+glyph0.x+.01,following.rawOrigin.y+following.height*.5,0,0)];
        NSRect last=[text focusRect:NSMakeRect(following.rawOrigin.x+glyph3.x+.01,following.rawOrigin.y+following.height*.5,0,0)];
        NSPoint point0=[text.focusView convertPoint:first.origin toView:nil],point3=[text.focusView convertPoint:last.origin toView:nil];
        [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:point3 modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:9 clickCount:1 pressure:0] atStart:YES];
        if(drag.boolValue)[NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:point3 modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:9 clickCount:1 pressure:1] atStart:YES];
        [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:drag.boolValue?point0:point3 modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:9 clickCount:1 pressure:1]];
        NSRange expectedRange=drag.boolValue?NSMakeRange(nextStart,3):NSMakeRange(nextStart+3,0);
        require(NSEqualRanges(text.selectedRange,expectedRange),@"click/short-drag on following row has exact native character selection during and after transition");
        [text insertText:@"X" replacementRange:NSMakeRange(NSNotFound,0)];
        require([text.string isEqual:[future stringByReplacingCharactersInRange:expectedRange withString:@"X"]],@"editing faded following row preserves every other paragraph");
    }
    // New contract: translate the actual page, preserving all glyph geometry;
    // keep BOTH sides of the active row, with no magic row-count cutoff.
    NSMutableString *context=[NSMutableString new];
    for(int n=0;n<24;n++)[context appendFormat:@"%02d %@\n",n,paragraph];
    NSUInteger middle=context.length/2;
    [owner applyProjection:@{@"document":@{@"text":context,@"runs":@[]},@"selection":SumiRange(NSMakeRange(middle,0))} revision:owner.revision+1];
    appearance[@"font_family"]=@"Sumi System";appearance[@"font_size"]=@22;appearance[@"line_height"]=@1.6;owner.appearance=appearance;[owner applyStyles];[owner layoutEditor];
    NSAttributedString *stablePage=[text.textStorage copy];NSUInteger stableRevision=owner.revision,stableEvents=events.count;NSRange stableSelection=text.selectedRange;
    NSUInteger smallViewportRows=0;
    for(NSNumber *height in @[@480,@960]){
        [text stopFocusTyping];[owner setBounds:@{@"x":@0,@"y":@0,@"width":@960,@"height":height}];
        for(int n=0;n<4;n++)[text recordFocusInputAt:390+n*.1];text.focusView.progress=1;text.focusView.strength=1;
        require(text.focusView.rows.count>5,@"context includes more than five rows in each viewport");
        if(height.intValue==480)smallViewportRows=text.focusView.rows.count;
        else require(text.focusView.rows.count>smallViewportRows,@"larger viewport displays more actual rows instead of a fixed row count");
        current=text.focusView.rows.firstObject;
        require(fabs(NSMidY(text.focusView.bounds)-(current.origin.y+current.height*.5))<.01,@"active line remains exactly centered after resize");
        require(fabs(current.alpha-1)<.001,@"current line is fully opaque");
        NSUInteger above=0,below=0;NSMutableSet *seen=[NSMutableSet new];CGFloat farthest=0,farAlpha=1;
        for(SumiFocusRow *row in text.focusView.rows){
            NSString *identity=NSStringFromRange(row.range);require(![seen containsObject:identity],@"visual line appears only once");[seen addObject:identity];
            CGFloat delta=row.origin.y-current.origin.y;
            if(delta<-.1)above++;if(delta>.1)below++;
            require(fabs(row.origin.x-row.rawOrigin.x)<.01 && fabs(delta-(row.rawOrigin.y-current.rawOrigin.y))<.01,@"context preserves all x positions and actual line gaps");
            require(row.alpha>=0 && row.alpha<=1,@"row opacity stays within valid range");
            if(fabs(delta)>farthest){farthest=fabs(delta);farAlpha=row.alpha;}
            for(SumiFocusRow *other in text.focusView.rows){
                CGFloat otherDistance=fabs(other.origin.y-current.origin.y);
                if(otherDistance>fabs(delta)+1)require(other.alpha<=row.alpha+.001,@"opacity decreases monotonically with distance on both sides");
                if(fabs(otherDistance-fabs(delta))<.01)require(fabs(other.alpha-row.alpha)<.001,@"equal-distance upper and lower rows have equal opacity");
            }
        }
        require(above>2 && below>2,@"several real preceding and following lines are retained");
        require(farthest>height.doubleValue*.4 && farAlpha<.05,@"edge rows approach zero opacity at both viewport ends");
        BOOL onlyViewport=YES;for(NSUInteger e=stableEvents;e<events.count;e++)onlyViewport&=[events[e][@"kind"] isEqual:@"viewport"];
        require([stablePage isEqualToAttributedString:text.textStorage] && owner.revision==stableRevision && onlyViewport && NSEqualRanges(stableSelection,text.selectedRange),@"focus and resize preserve exact styled body, accepted revision and selection; resizing may report only viewport geometry");
    }
    [owner setBounds:@{@"x":@0,@"y":@0,@"width":@960,@"height":@720}];
    for(NSString *theme in @[@"light",@"dark"]){
        appearance[@"foreground"]=[theme isEqual:@"light"]?@"#3D3A35":@"#D6D2CB";
        appearance[@"background"]=[theme isEqual:@"light"]?@"#F2EBDD":@"#121212";owner.appearance=appearance;[owner applyStyles];[owner layoutEditor];
        if(!text.focusView)for(int n=0;n<4;n++)[text recordFocusInputAt:395+n*.1];text.focusView.progress=1;text.focusView.strength=1;
        if(argc>1){NSString *path=[NSString stringWithUTF8String:argv[1]];capture(owner.container,[path stringByAppendingFormat:@".centered-%@.png",theme]);}
    }
    [text stopFocusTyping];
    // Idle affects opacity only: deadline and both transitions use real timers,
    // with just this hidden probe view's timestamps/deadline moved for speed.
    [owner applyProjection:@{@"document":@{@"text":context,@"runs":@[]},@"selection":SumiRange(NSMakeRange(middle,0))} revision:owner.revision+1];
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.3]];
    SumiFocusView *idle=text.focusView;require(idle && idle.progress==1 && idle.strength==1,@"quick entry settles into centered full focus strength");
    require(idle.idleTimer.valid && idle.idleTimer.fireDate.timeIntervalSinceNow>9.3 && idle.idleTimer.fireDate.timeIntervalSinceNow<=10,@"production idle deadline remains ten seconds");
    NSAttributedString *idleBody=[text.textStorage copy];NSRange idleSelection=text.selectedRange;NSUInteger idleRevision=owner.revision,idleEventCount=events.count;
    BOOL couldUndo=text.undoManager.canUndo,couldRedo=text.undoManager.canRedo;NSInteger undoLevel=text.undoManager.groupingLevel;
    SumiFocusRow *idleCurrent=idle.rows.firstObject;CGFloat fixedY=idleCurrent.origin.y;
    idle.lastActivity=CACurrentMediaTime()-9;idle.idleTimer.fireDate=[NSDate dateWithTimeIntervalSinceNow:.005];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.05]];
    require(idle.strength==1 && idle.idleTimer.valid && !idle.timer,@"before ten seconds early timer callback reschedules without restoring opacity");
    idle.lastActivity=CACurrentMediaTime()-10.1;idle.idleTimer.fireDate=[NSDate dateWithTimeIntervalSinceNow:.005];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.4]];
    require(idle.timer && idle.strength>0 && idle.strength<1 && idle.progress==1,@"after ten seconds the real1.2s timer is between focus and opaque endpoints");
    require(fabs(idle.rows.firstObject.origin.y-fixedY)<.01,@"idle opacity transition never moves the centered row");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.95]];
    require(idle.strength==0 && !idle.timer && text.focusView==idle,@"idle timer completes with all rows fully opaque while focus geometry remains mounted");
    if(argc>1)capture(owner.container,[[NSString stringWithUTF8String:argv[1]] stringByAppendingString:@".idle-full.png"]);
    require([idleBody isEqualToAttributedString:text.textStorage] && NSEqualRanges(idleSelection,text.selectedRange) && owner.revision==idleRevision && events.count==idleEventCount && text.undoManager.canUndo==couldUndo && text.undoManager.canRedo==couldRedo && text.undoManager.groupingLevel==undoLevel,@"idle wait and fade preserve exact text, styles, revision, selection and undo state");
    [text recordFocusEvent:key(window,@"x",7)];
    require(idle.timer && idle.idleTimer.valid,@"first valid input activity starts fast refocus without another four-key threshold");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.08]];
    require(idle.strength>0 && idle.strength<1 && idle.progress==1,@"fast refocus has a real intermediate opacity with no recenter animation");
    NSTimer *resumingTimer=idle.timer;CFTimeInterval resumingStarted=idle.started;
    [text recordFocusEvent:key(window,@"y",16)];
    require(idle.timer==resumingTimer && idle.started==resumingStarted,@"continuous valid typing does not restart an in-flight refocus transition");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.2]];
    require(idle.strength==1 && !idle.timer && fabs(idle.rows.firstObject.origin.y-fixedY)<.01,@"fast refocus reaches original opacity gradient within0.2s with fixed center");
    if(argc>1)capture(owner.container,[[NSString stringWithUTF8String:argv[1]] stringByAppendingString:@".idle-refocused.png"]);
    require([idleBody isEqualToAttributedString:text.textStorage] && owner.revision==idleRevision && NSEqualRanges(idleSelection,text.selectedRange) && events.count==idleEventCount,@"presentation-only activity does not synthesize a document edit");
    idle.lastActivity=CACurrentMediaTime()-10.1;idle.idleTimer.fireDate=[NSDate dateWithTimeIntervalSinceNow:.005];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.35]];
    CGFloat interruptedStrength=idle.strength;NSTimer *oldFade=idle.timer;
    require(interruptedStrength>0 && interruptedStrength<1 && oldFade.valid,@"partial idle fade can be interrupted before reaching opaque state");
    [text recordFocusEvent:key(window,@"z",6)];
    require(!oldFade.valid && idle.timer!=oldFade && fabs(idle.fromStrength-interruptedStrength)<.001 && idle.progress==1,@"typing reverses partial opacity from its actual presentation state without moving text");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.25]];
    require(idle.strength==1 && !idle.timer,@"interrupted idle fade quickly returns to focused gradient");
    CFTimeInterval genuineActivity=idle.lastActivity;
    [text recordFocusEvent:key(window,@"\uf703",124)];
    require(idle.lastActivity==genuineActivity,@"arrow activity does not reset the typing idle timestamp");
    NSEvent *repeat=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:YES keyCode:7];text.focusInputChanged=NO;[text recordFocusEvent:repeat];
    require(idle.lastActivity==genuineActivity,@"repeat-only event cannot keep an idle focus session alive");
    // Autorepeat is input activity only after a typing session already exists;
    // observing a repeat flag without an actual text mutation must do nothing.
    NSString *repeatBefore=text.string.copy;NSRange repeatRange=text.selectedRange;NSUInteger repeatRevision=owner.revision;
    idle.lastActivity=CACurrentMediaTime()-5;CFTimeInterval repeatActivity=idle.lastActivity;
    idle.strength=0;idle.targetStrength=0;
    NSEvent *typedRepeat=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:YES keyCode:7];
    [text keyDown:typedRepeat];
    require(text.focusView==idle && idle.lastActivity>repeatActivity && idle.targetStrength==1 && idle.timer,@"actual repeat text insertion refreshes an existing session and resumes its gradient");
    require([text.string isEqual:[repeatBefore stringByReplacingCharactersInRange:repeatRange withString:@"x"]] && owner.revision==repeatRevision+1,@"focused repeat performs exactly its native document insertion");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.25]];
    require(idle.strength==1 && !idle.timer,@"repeat-triggered refocus completes with normal fast opacity easing");
    genuineActivity=idle.lastActivity;
    NSString *remoteBody=[text.string stringByAppendingString:@"\nremote-only content"];
    [owner applyProjection:@{@"document":@{@"text":remoteBody,@"runs":@[]},@"selection":SumiRange(text.selectedRange)} revision:owner.revision+1];
    require(text.focusView==idle && idle.lastActivity==genuineActivity,@"remote projection refreshes visible context without pretending to be new typing");
    [text keyDown:key(window,@"\uf703",124)];
    require(!text.focusView && !idle.timer && !idle.idleTimer,@"actual horizontal navigation exits focus and cancels rather than rescheduling idle");
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];idle=text.focusView;
    NSPasteboard *idlePaste=[NSPasteboard pasteboardWithName:@"net.notemd.sumi.idle-probe"];
    [idlePaste clearContents];[idlePaste setString:@"isolated paste" forType:NSPasteboardTypeString];[text pasteFromPasteboard:idlePaste];
    require(!text.focusView && !idle.timer && !idle.idleTimer && text.focusInputCount==0,@"paste remains a reading operation and cannot restart the typing deadline");
    NSString *readingBefore=text.string.copy;NSRange readingStart=text.selectedRange;NSUInteger readingRevision=owner.revision;
    for(int n=0;n<6;n++){
        NSEvent *readingRepeat=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:YES keyCode:7];
        [text keyDown:readingRepeat];require(!text.focusView && text.focusInputCount==0,@"reading-stage autorepeat does not satisfy the four-key focus-entry threshold");
    }
    require([text.string isEqual:[readingBefore stringByReplacingCharactersInRange:readingStart withString:@"xxxxxx"]] && owner.revision==readingRevision+6,@"reading-stage repeat preserves normal native text insertion behavior");
    // An exiting surface must cancel both timer paths, even during transitions.
    for(NSString *reason in @[@"hide",@"draft",@"stop"]){
        [owner applyProjection:@{@"document":@{@"text":context,@"runs":@[]},@"selection":SumiRange(NSMakeRange(middle,0))} revision:owner.revision+1];
        [window makeFirstResponder:text];
        for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];idle=text.focusView;
        require(idle!=nil,@"lifecycle fixture enters focus");
        if([reason isEqual:@"hide"])sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":false}");
        else if([reason isEqual:@"draft"])[owner retainDraft:@{@"document":@{@"text":text.string,@"runs":@[]},@"selection":SumiRange(text.selectedRange)} error:@"synthetic idle journal failure"];
        else {[text stopFocusTyping];}
        require(!text.focusView && !idle.timer && !idle.idleTimer,@"hide/draft/stop cancel idle and animation timers before removing the surface");
        before=text.string.copy;revision=owner.revision;[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.06]];
        require(!text.focusView && [text.string isEqual:before] && owner.revision==revision,@"cancelled timer cannot reattach or change protected text");
        if(owner.container.hidden)sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":true}");
    }
    [owner applyProjection:@{@"document":@{@"text":context,@"runs":@[]},@"selection":SumiRange(NSMakeRange(middle,0))} revision:owner.revision+1];
    // Reduced motion skips spatial movement, while the explicitly requested
    // opacity easing and independent caret breathing remain observable.
    [text stopFocusTyping];[window makeFirstResponder:text];
    IMP allowedMotion=method_setImplementation(motionMethod,(IMP)probeMotionReduced);
    [owner applyProjection:@{@"document":@{@"text":context,@"runs":@[]},@"selection":SumiRange(NSMakeRange(middle,0))} revision:owner.revision+1];
    appearance[@"caret_motion"]=@"breathing";owner.appearance=appearance;
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    SumiFocusView *reduced=text.focusView;
    require(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion && reduced.progress==1 && reduced.timer,@"ReduceMotion places the line directly in center but retains pure-opacity entry easing");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.08]];
    require(reduced.progress==1 && reduced.strength>0 && reduced.strength<1,@"ReduceMotion true still has a visible entry alpha intermediate");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.2]];
    [text refreshTypewriterCaret:YES];
    CAAnimation *caretBreath=[text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"];
    require(caretBreath!=nil,@"caret retains its explicit breathing animation during reduced motion");
    CFTimeInterval caretPhase=caretBreath.beginTime;NSRect steadyCaret=text.typewriterCaret.frame;
    CGFloat caretOpacity=text.typewriterCaret.layer.opacity;
    reduced.lastActivity=CACurrentMediaTime()-10.1;reduced.idleTimer.fireDate=[NSDate dateWithTimeIntervalSinceNow:.005];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.4]];
    require(reduced.progress==1 && reduced.strength>0 && reduced.strength<1 && reduced.timer,@"ReduceMotion true still slowly restores text opacity after idle deadline");
    require(text.typewriterCaret.layer.opacity==caretOpacity && text.typewriterCaret.alphaValue==1 && reduced.alphaValue==1 && NSEqualRects(steadyCaret,text.typewriterCaret.frame) && [text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"].beginTime==caretPhase,@"opacity strength applies only to text drawing and never fades, moves or restarts the breathing caret");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.95]];
    require(reduced.strength==0 && reduced.progress==1,@"ReduceMotion true reaches fully opaque text while center remains unchanged");
    [text recordFocusEvent:key(window,@"q",12)];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.08]];
    require(reduced.strength>0 && reduced.strength<1 && reduced.progress==1,@"ReduceMotion true fast refocus uses alpha without spatial movement");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.2]];
    require(reduced.strength==1 && text.typewriterCaret.layer.opacity==caretOpacity && [text.typewriterCaret.layer animationForKey:@"sumi-caret-breathing"].beginTime==caretPhase,@"fast focus completes without coupling to caret breathing phase");
    [text stopFocusTyping];appearance[@"caret_motion"]=@"steady";owner.appearance=appearance;
    method_setImplementation(motionMethod,allowedMotion);
    // A truly new empty page prepares its first line at center immediately;
    // this is real mount/focus behavior, not simulated continuous typing.
    [text stopFocusTyping];
    for(NSString *variant in @[@"editable",@"disabled",@"readonly",@"hidden",@"placeholder",@"nonempty"]){
        NSWindow *blankWindow=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        NSView *blankHost=[[NSView alloc]initWithFrame:NSMakeRect(0,0,800,600)];[blankWindow.contentView addSubview:blankHost];
        NSTextField *other=[[NSTextField alloc]initWithFrame:NSMakeRect(0,0,120,24)];[blankWindow.contentView addSubview:other];[blankWindow makeFirstResponder:other];NSResponder *priorResponder=blankWindow.firstResponder;
        BOOL editable=[variant isEqual:@"editable"],hidden=[variant isEqual:@"hidden"];
        NSMutableDictionary *blankAppearance=[appearance mutableCopy];blankAppearance[@"focus_typing"]=@(![variant isEqual:@"disabled"]);blankAppearance[@"font_size"]=@22;blankAppearance[@"caret_motion"]=@"steady";
        NSMutableDictionary *blankConfig=[@{@"surface_id":@"empty-page-probe",@"generation":@1,@"revision":@7,@"bounds":@{@"x":@0,@"y":@0,@"width":@800,@"height":@600},@"appearance":blankAppearance,@"document":@{@"text":[variant isEqual:@"nonempty"]?@"existing saved text":@"",@"runs":@[]}} mutableCopy];
        if([variant isEqual:@"placeholder"])blankConfig[@"document"]=@{@"runs":@[]};
        blankHost.hidden=hidden;NSData *blankData=[NSJSONSerialization dataWithJSONObject:blankConfig options:0 error:nil];
        NSUInteger beforeMountEvents=events.count;
        void *blankHandle=sumi_editor_mount((__bridge void *)blankHost,0,[[[NSString alloc]initWithData:blankData encoding:NSUTF8StringEncoding]UTF8String],receive,replyFree,NULL);
        require(blankHandle!=NULL,@"empty-page variant mounts with normal owner lifecycle");SumiEditor *blankOwner=(__bridge SumiEditor *)blankHandle;SumiTextView *blankText=blankOwner.text;object_setClass(blankText,FocusProbeText.class);
        if([variant isEqual:@"readonly"]){blankText.editable=NO;[blankText updateFocusRows];}
        require(blankWindow.firstResponder==priorResponder,@"empty preparation never steals another control's first responder");
        require(blankOwner.revision==7 && events.count==beforeMountEvents && !blankText.undoManager.canUndo,@"empty preparation does not edit revision history or emit typing");
        if(editable){
            require(blankText.focusView!=nil && blankText.string.length==0,@"editable empty page has centered focus before the first keystroke");
            SumiFocusView *prepared=blankText.focusView;SumiFocusRow *empty=prepared.rows.firstObject;
            require(prepared.rows.count==1 && fabs(empty.origin.y+empty.height*.5-300)<.01 && prepared.progress==1,@"initial empty visual row is centered before typing begins");
            require(!prepared.timer && !prepared.idleTimer && prepared.strength==1 && prepared.targetStrength==1,@"empty preparation does not start a fake typing idle deadline or entry animation");
            [blankText refreshTypewriterCaret:NO];require(![blankText typewriterCaretEligible] && (!blankText.typewriterCaret || blankText.typewriterCaret.hidden),@"prepared empty page cannot display an active caret while another control owns focus");
            [blankWindow makeFirstResponder:blankText];[blankText refreshTypewriterCaret:NO];
            NSRect raw=[blankOwner rectForInsertion:0],drawn=[blankText focusRect:raw];
            require(!blankText.typewriterCaret.hidden && fabs(NSMidY(drawn)-300)<=empty.height,@"real empty-page caret uses centered geometry on first responder entry");
            NSString *typed=@"";
            for(NSString *character in @[@"a",@"b",@"c"]){[blankText keyDown:key(blankWindow,character,0)];typed=[typed stringByAppendingString:character];
                require(blankText.focusView==prepared && [blankText.string isEqual:typed] && blankOwner.revision==7+typed.length,@"each of first three real characters stays focused and inserts exactly once");
                empty=prepared.rows.firstObject;require(fabs(empty.origin.y+empty.height*.5-300)<.01,@"first three characters never wait for four-key threshold to become centered");}
            [blankText keyDown:key(blankWindow,@"\r",36)];require([blankText.string isEqual:@"abc\n"] && blankText.focusView==prepared,@"first Return creates the next real line without leaving centered typing");
            checkVerticalStep(blankText,blankWindow,YES);checkVerticalStep(blankText,blankWindow,NO);
            [blankOwner applyProjection:@{@"document":@{@"text":@"",@"runs":@[]},@"selection":SumiRange(NSMakeRange(0,0))} revision:blankOwner.revision+1];
            require(blankText.focusView && blankText.string.length==0 && fabs(blankText.focusView.rows.firstObject.origin.y+blankText.focusView.rows.firstObject.height*.5-300)<.01,@"authoritative empty projection keeps a correctly centered first line");
            NSMutableDictionary *offAppearance=[blankOwner.appearance mutableCopy];offAppearance[@"focus_typing"]=@NO;
            NSData *offData=[NSJSONSerialization dataWithJSONObject:@{@"command":@"set_appearance",@"appearance":offAppearance} options:0 error:nil];NSUInteger emptyRevision=blankOwner.revision;
            require(sumi_editor_command(blankHandle,[[[NSString alloc]initWithData:offData encoding:NSUTF8StringEncoding]UTF8String])==0 && !blankText.focusView,@"disabling the preference removes prepared empty centering through the real appearance command");
            offAppearance[@"focus_typing"]=@YES;offData=[NSJSONSerialization dataWithJSONObject:@{@"command":@"set_appearance",@"appearance":offAppearance} options:0 error:nil];
            require(sumi_editor_command(blankHandle,[[[NSString alloc]initWithData:offData encoding:NSUTF8StringEncoding]UTF8String])==0 && blankText.focusView && blankOwner.revision==emptyRevision,@"reenabling preference prepares empty centering without a document edit");
            require(sumi_editor_command(blankHandle,"{\"command\":\"set_bounds\",\"bounds\":{\"x\":0,\"y\":0,\"width\":640,\"height\":480}}") ==0 && fabs(blankText.focusView.rows.firstObject.origin.y+blankText.focusView.rows.firstObject.height*.5-240)<.01,@"empty page follows the actual resized viewport center");
            require(sumi_editor_command(blankHandle,"{\"command\":\"set_bounds\",\"bounds\":{\"x\":0,\"y\":0,\"width\":800,\"height\":600}}") ==0 && fabs(blankText.focusView.rows.firstObject.origin.y+blankText.focusView.rows.firstObject.height*.5-300)<.01 && blankOwner.revision==emptyRevision,@"restoring empty viewport bounds keeps exact center and revision");
            [blankOwner retainDraft:@{@"document":@{@"text":@"",@"runs":@[]},@"selection":SumiRange(NSMakeRange(0,0))} error:@"synthetic empty journal failure"];
            [blankText updateFocusRows];require(!blankText.focusView && !blankText.editable,@"empty-page convenience cannot bypass a protected read-only draft");
            [blankOwner applyProjection:@{@"document":@{@"text":@"",@"runs":@[]},@"selection":SumiRange(NSMakeRange(0,0))} revision:blankOwner.revision+1];
            require(blankText.focusView && blankText.editable,@"successful explicit empty projection may restore centered editable page after draft protection");
            sumi_editor_command(blankHandle,"{\"command\":\"set_visible\",\"visible\":false}");[blankText updateFocusRows];require(!blankText.focusView,@"hidden empty page cancels focus and does not recreate it from a layout callback");
            NSResponder *hiddenResponder=blankWindow.firstResponder;sumi_editor_command(blankHandle,"{\"command\":\"set_visible\",\"visible\":true}");require(blankText.focusView!=nil && blankWindow.firstResponder==hiddenResponder,@"showing a ready empty page prepares its centered line again without taking focus");
        }else require(!blankText.focusView,@"disabled readonly hidden placeholder and nonempty reading mounts do not create empty focus");
        SumiFocusView *prepared=blankText.focusView;sumi_editor_detach(blankHandle);require(!prepared.timer && !prepared.idleTimer,@"empty page detach cannot leave timers or recreate the old surface");[blankWindow orderOut:nil];
    }
    [window makeFirstResponder:text];
    if(argc>2){
        NSString *fontRoot=[NSString stringWithUTF8String:argv[2]];
        NSData *manifestData=[NSData dataWithContentsOfFile:@"plugins-src/write/resources/sumi/manifest.json"];
        NSDictionary *manifest=[NSJSONSerialization JSONObjectWithData:manifestData options:0 error:nil];require(manifest!=nil,@"font matrix uses production manifest");
        for(NSDictionary *asset in manifest[@"assets"]){if(!asset[@"postscript"])continue;char *error=NULL;
            NSString *fontPath=[fontRoot stringByAppendingPathComponent:asset[@"file"]];require(sumi_editor_register_font(fontPath.UTF8String,[asset[@"postscript"] UTF8String],&error)==0,@"production font registers with its exact PostScript name");free(error);
        }
        NSDictionary *cascades=manifest[@"cascades"];
        NSDictionary *themes=@{@"sepia":@[@"#44413c",@"#f3ead7"],@"dim":@[@"#b8b8b8",@"#111111"],@"ink":@[@"#ffffff",@"#000000"],@"paper":@[@"#111111",@"#ffffff"],@"crt":@[@"#0ccc68",@"#000000"],@"crt-blue":@[@"#7fb4ff",@"#000000"]};
        for(NSString *alias in [[cascades allKeys] sortedArrayUsingSelector:@selector(compare:)]){
            NSData *cascade=[NSJSONSerialization dataWithJSONObject:@{@"alias":alias,@"families":cascades[alias]} options:0 error:nil];NSString *encoded=[[NSString alloc]initWithData:cascade encoding:NSUTF8StringEncoding];char *error=NULL;
            require(sumi_editor_register_cascade(encoded.UTF8String,&error)==0,@"production Chinese-English cascade registers");free(error);
            for(NSNumber *fontSize in @[@14,@22,@46])for(NSString *theme in [[themes allKeys] sortedArrayUsingSelector:@selector(compare:)]){
                [text stopFocusTyping];appearance[@"font_family"]=alias;appearance[@"font_size"]=fontSize;
                appearance[@"foreground"]=themes[theme][0];appearance[@"background"]=themes[theme][1];owner.appearance=appearance;
                NSString *mixed=[paragraph stringByAppendingString:@" The quiet rhythm of the keys carries every thought onto the page. 一字一句，写下此刻。"];
                [owner applyProjection:@{@"document":@{@"text":mixed,@"runs":@[]},@"selection":SumiRange(NSMakeRange(mixed.length,0))} revision:owner.revision+1];[owner applyStyles];[owner layoutEditor];
                NSUInteger stableRevision=owner.revision;NSAttributedString *styled=[text.textStorage copy];NSRange stableSelection=text.selectedRange;NSUInteger stableEvents=events.count;
                for(int n=0;n<4;n++)[text recordFocusInputAt:400+n*.1];text.focusView.progress=1;text.focusView.strength=1;[text refreshTypewriterCaret:NO];
                require(text.focusView.rows.count>=1 && text.focusView.rows.count<100,@"all six font presets and sizes have viewport-bounded real visual rows");
                SumiFocusRow *active=text.focusView.rows.firstObject;
                require(fabs(active.origin.y+active.height*.5-360)<.01,@"font/theme matrix keeps active glyph row at viewport center");
                for(SumiFocusRow *row in text.focusView.rows){
                    require(fabs(row.origin.x-row.rawOrigin.x)<.01 && fabs((row.origin.y-active.origin.y)-(row.rawOrigin.y-active.rawOrigin.y))<.01,@"font/theme matrix keeps original x and line spacing without font scaling");
                }
                require([styled isEqualToAttributedString:text.textStorage] && NSEqualRanges(stableSelection,text.selectedRange) && owner.revision==stableRevision && stableEvents==events.count,@"font/theme presentation preserves exact attributed body, selection and revision");
                if(fontSize.intValue==22 && argc>1){NSString *suffix=[NSString stringWithFormat:@".%@.%@.png",[alias stringByReplacingOccurrencesOfString:@" " withString:@"-"],theme];capture(owner.container,[[NSString stringWithUTF8String:argv[1]] stringByAppendingString:suffix]);}
            }
        }
    }
    [text stopFocusTyping];[window makeFirstResponder:text];
    for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.05];
    SumiFocusView *detachedView=text.focusView;require(detachedView!=nil,@"detach fixture has live animation and idle ownership");
    require(!window.visible,@"probe never displayed window");sumi_editor_detach(handle);
    require(!detachedView.timer && !detachedView.idleTimer,@"detach cancels both timers before editor removal");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.06]];
    method_setImplementation(motionMethod,originalMotion);
    require(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion==systemReduceMotion,@"process-only motion override restored");
    printf("PASS: %lu checks; native focus input/geometry/selection/drag/IME callback/lifecycle/P0 draft safety. Physical IME requires manual acceptance.\n",(unsigned long)checks);
}else{fprintf(stderr,"SKIP: focus typing requires macOS 13 or newer\n");return 77;}}}
