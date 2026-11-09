// Offscreen, real TextKit line rendering and input mapping. Never requests TCC.
#import "editor.m"
#import <objc/runtime.h>
@interface FocusProbeText : SumiTextView
@end
@implementation FocusProbeText
- (BOOL)caretSurfaceActive {return self.window.firstResponder==self && !self.isHiddenOrHasHiddenAncestor;}
@end
static NSMutableArray *events;
static NSUInteger checks;
static NSInteger rejectEdit;
static BOOL probeMotionEnabled(id receiver,SEL selector){(void)receiver;(void)selector;return NO;}
static void require(BOOL ok,NSString *message){checks++;if(!ok){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *ctx,const char *json,char **reply){(void)ctx;(void)reply;NSDictionary *event=SumiJSON(json);[events addObject:event];if(rejectEdit && [event[@"kind"] isEqual:@"edit"]){NSInteger code=rejectEdit;rejectEdit=0;if(code==-2)*reply=strdup("{\"draft_error\":\"synthetic journal failure\"}");return code;}return [event[@"kind"] isEqual:@"edit"]?[event[@"base_revision"] longLongValue]+1:[event[@"revision"] longLongValue];}
static void replyFree(char *value){free(value);}
static NSEvent *key(NSWindow *window,NSString *text,unsigned short code){return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];}
static void capture(NSView *view,NSString *path){[view layoutSubtreeIfNeeded];NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];}
int main(int argc,const char **argv){@autoreleasepool{
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
    for(int n=0;n<3;n++)[text keyDown:key(window,@"a",0)];require(!text.focusView,@"first three inputs remain reading");
    [text keyDown:key(window,@"b",11)];require(text.focusView!=nil,@"four continuous native input events enter focus");
    require(text.focusView.progress<1 && text.focusView.timer!=nil,@"entry starts the real native transition timer with motion enabled");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.20]];
    require(text.focusView.progress>.1 && text.focusView.progress<.9,@"actual animation is between endpoints near half the420ms duration");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.5]];
    require(text.focusView.rows.count==5,@"exactly current plus four visual lines");require(text.focusView.progress==1,@"420ms transition completes");
    SumiFocusRow *current=text.focusView.rows.firstObject;require(fabs(current.origin.y+current.baseline*current.scale-720*.57)<.01,@"current baseline at57 percent");
    CGFloat width=text.textContainer.size.width;CGFloat midpoint=480;
    for(SumiFocusRow *row in text.focusView.rows){
        CGFloat left=row.origin.x-(row.rawOrigin.x-text.textContainerOrigin.x)*row.scale;
        CGFloat right=left+width*row.scale;require(fabs((left+right)/2-midpoint)<.01,@"each row uses one common page center");require(left>=0 && right<=960,@"projected full column stays inside viewport");
        NSPoint probe=NSMakePoint(row.rawOrigin.x+12,row.rawOrigin.y+row.height/2);NSRect projected=[text focusRect:NSMakeRect(probe.x,probe.y,1,1)];NSPoint recovered=[text focusOriginalPoint:projected.origin];require(fabs(probe.x-recovered.x)<.01 && fabs(probe.y-recovered.y)<.01,@"click inverse maps projected line to original TextKit coordinates");
    }
    NSString *before=text.string.copy;NSUInteger revision=owner.revision;NSRange selection=text.selectedRange;
    [text updateFocusRows];require([text.string isEqual:before] && owner.revision==revision && NSEqualRanges(text.selectedRange,selection),@"presentation does not mutate text revision or selection");
    [text setMarkedText:@"拼音" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];[text updateFocusRows];
    require(text.hasMarkedText && owner.composing && text.focusView,@"markedText remains owned by real native editor");
    NSRange actual;NSRect candidate=[text firstRectForCharacterRange:text.selectedRange actualRange:&actual];require(!NSIsEmptyRect(candidate),@"IME receives projected screen geometry");[text unmarkText];
    [text updateFocusRows];
    if(argc>1){NSView *view=owner.container;[view layoutSubtreeIfNeeded];NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES];}
    [text keyDown:key(window,@"\uf703",124)];require(!text.focusView,@"arrow returns to reading");
    NSMutableDictionary *appearance=[owner.appearance mutableCopy];appearance[@"focus_typing"]=@NO;owner.appearance=appearance;
    for(int n=0;n<5;n++)[text keyDown:key(window,@"c",8)];require(!text.focusView,@"disabled preference remains reading");
    // Reuse one continuous paragraph in both renderings, with real native caret.
    NSString *paragraph=[body componentsSeparatedByString:@"\n"].firstObject;
    appearance[@"focus_typing"]=@YES;appearance[@"max_columns"]=@40;owner.appearance=appearance;
    [owner applyProjection:@{@"document":@{@"text":paragraph,@"runs":@[]},@"selection":SumiRange(NSMakeRange(paragraph.length,0))} revision:owner.revision+1];[owner layoutEditor];
    for(int n=0;n<4;n++)[text keyDown:key(window,@"风",3)];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.45]];
    require(text.focusView.rows.count==5 && text.focusView.rows.firstObject.range.location<text.selectedRange.location,@"one long paragraph includes actual current fragment and previous wrapped rows");
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
    [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:250+n*.1];text.focusView.progress=1;
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
    require(text.focusView.rows.count>=1 && text.focusView.rows.count<=5,@"short viewport keeps current row and only fitting previous rows");
    current=text.focusView.rows.firstObject;require(current.origin.y>=0 && current.origin.y+current.height*current.scale<=180,@"current line fits short viewport");
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
    require(text.focusView.rows.count>=1 && text.focusView.rows.count<=5 && [text.string isEqual:before] && owner.revision==revision && events.count==count,@"100k paragraph near start draws bounded rows without edit events");
    [text stopFocusTyping];
    // Regression for a physical click after reading scroll + reentry: a raw
    // mouseUp at the displayed location must never extend a synthetic selection.
    NSMutableString *scrolling=[NSMutableString new];for(int n=0;n<8;n++)[scrolling appendFormat:@"%@\n",paragraph];[scrolling appendString:@"abcdefghi"];
    [owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
    for(int n=0;n<4;n++)[text recordFocusInputAt:350+n*.1];text.focusView.progress=1;
    clicked=text.focusView.rows.firstObject;sourcePoint=NSMakePoint(clicked.rawOrigin.x+30,clicked.rawOrigin.y+clicked.height*.5);drawn=[text focusRect:NSMakeRect(sourcePoint.x,sourcePoint.y,1,1)];expected=[text focusCharacterIndexAtPoint:drawn.origin];windowPoint=[text.focusView convertPoint:drawn.origin toView:nil];
    [NSApp postEvent:[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:1 pressure:0] atStart:YES];
    [text mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil eventNumber:3 clickCount:1 pressure:1]];
    require(NSEqualRanges(text.selectedRange,NSMakeRange(expected,0)),@"long scrolled page focus click plus real-coordinate mouseUp leaves only insertion point");
    [text insertText:@"x" replacementRange:NSMakeRange(NSNotFound,0)];
    require([text.string isEqual:[scrolling stringByReplacingCharactersInRange:NSMakeRange(expected,0) withString:@"x"]],@"typing after long-page focus click cannot replace a previous paragraph");
    for(NSNumber *progress in @[@.5,@1])for(NSNumber *rowNumber in @[@0,@1]){
        [text stopFocusTyping];[owner applyProjection:@{@"document":@{@"text":scrolling,@"runs":@[]},@"selection":SumiRange(NSMakeRange(scrolling.length,0))} revision:owner.revision+1];[text scrollRangeToVisible:text.selectedRange];
        for(int n=0;n<4;n++)[text recordFocusInputAt:355+n*.1];text.focusView.progress=progress.doubleValue;
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
        for(int n=0;n<4;n++)[text recordFocusInputAt:357+n*.1];text.focusView.progress=progress.doubleValue;clicked=text.focusView.rows.firstObject;
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
        [text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:360+n*.1];text.focusView.progress=1;
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
        for(int n=0;n<4;n++)[text recordFocusInputAt:370+n*.1];text.focusView.progress=1;clicked=text.focusView.rows[1];
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
        owner.container.hidden=NO;[window makeFirstResponder:text];[text setSelectedRange:NSMakeRange(text.string.length,0)];for(int n=0;n<4;n++)[text recordFocusInputAt:380+n*.1];text.focusView.progress=1;
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
                for(int n=0;n<4;n++)[text recordFocusInputAt:400+n*.1];text.focusView.progress=1;[text refreshTypewriterCaret:NO];
                require(text.focusView.rows.count>=1 && text.focusView.rows.count<=5,@"all six font presets and sizes have visible real visual rows");
                CGFloat priorScale=CGFLOAT_MAX;
                for(SumiFocusRow *row in text.focusView.rows){CGFloat left=row.origin.x-(row.rawOrigin.x-text.textContainerOrigin.x)*row.scale,right=left+text.textContainer.size.width*row.scale;
                    require(left>=0 && right<=960 && fabs((left+right)*.5-480)<.01 && row.scale<priorScale,@"font/theme matrix preserves centered paper and shrinking rows");priorScale=row.scale;
                }
                require([styled isEqualToAttributedString:text.textStorage] && NSEqualRanges(stableSelection,text.selectedRange) && owner.revision==stableRevision && stableEvents==events.count,@"font/theme presentation preserves exact attributed body, selection and revision");
                if(fontSize.intValue==22 && argc>1){NSString *suffix=[NSString stringWithFormat:@".%@.%@.png",[alias stringByReplacingOccurrencesOfString:@" " withString:@"-"],theme];capture(owner.container,[[NSString stringWithUTF8String:argv[1]] stringByAppendingString:suffix]);}
            }
        }
    }
    [text stopFocusTyping];
    require(!window.visible,@"probe never displayed window");sumi_editor_detach(handle);
    method_setImplementation(motionMethod,originalMotion);
    require(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion==systemReduceMotion,@"process-only motion override restored");
    printf("PASS: %lu checks; native focus input/geometry/selection/drag/IME callback/lifecycle/P0 draft safety. Physical IME requires manual acceptance.\n",(unsigned long)checks);
}}
