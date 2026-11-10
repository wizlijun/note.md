// Real AppKit layout and composition, offscreen synthetic document only.
#import <objc/runtime.h>
#import "editor.m"
@interface CandidateProbeText : SumiTextView @end
@implementation CandidateProbeText
- (BOOL)caretSurfaceActive {return self.window.firstResponder==self && !self.owner.detached && !self.isHiddenOrHasHiddenAncestor;}
@end
static NSUInteger checks;
static void require(BOOL ok,NSString *message){checks++;if(!ok){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static NSString *body;
static uint64_t revision;
static SumiEditor *editor;
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;NSDictionary *event=SumiJSON(json);
    if([event[@"kind"]isEqual:@"edit"]){
        NSRange range=SumiReadRange(event[@"range"]);require(NSMaxRange(range)<=body.length,@"valid composition replacement");
        body=[body stringByReplacingCharactersInRange:range withString:event[@"replacement"]];revision++;
        NSDictionary *projection=@{@"document":@{@"text":body,@"runs":@[]},@"selection":SumiRange(editor.text.selectedRange)};
        *reply=strdup([[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:projection options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);return revision;
    }return revision;
}
static void freeReply(char *reply){free(reply);}
static NSDictionary *snapshot(NSUInteger count,NSUInteger serial){
    NSMutableArray *items=[NSMutableArray new];for(NSUInteger i=0;i<count;i++)[items addObject:@{@"index":@(i),@"text":[NSString stringWithFormat:@"候选词%lu",(unsigned long)i],@"label":[NSString stringWithFormat:@"%lu",(unsigned long)i+1],@"comment":@""}];
    return @{@"serial":[NSString stringWithFormat:@"%lu",(unsigned long)serial],@"candidates":items,@"cursor":@0,@"hasPrev":@NO,@"hasNext":@YES};
}
static void show(NSDictionary *value){require(editor.text.candidateBridge.prepare(value),@"native snapshot prepared");editor.text.candidateBridge.present();}
int main(int argc,const char **argv){@autoreleasepool{if(@available(macOS 13.0,*)){
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,700,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    NSMutableString *initial=[NSMutableString new];for(int i=0;i<60;i++)[initial appendFormat:@"Line %d 中文正文 and English keep their original position.\n",i];body=initial.copy;
    NSDictionary *config=@{@"surface_id":@"candidate-probe",@"generation":@1,@"revision":@0,@"bounds":@{@"x":@0,@"y":@0,@"width":@700,@"height":@500},@"appearance":@{@"font_family":@"Sumi System",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#34302a",@"background":@"#eee5d3",@"max_columns":@80,@"bottom_inset":@0,@"caret_motion":@"steady",@"focus_typing":@NO},@"document":@{@"text":body,@"runs":@[]}};
    NSString *json=[[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:config options:0 error:nil] encoding:NSUTF8StringEncoding];void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,json.UTF8String,receive,freeReply,NULL);require(handle!=NULL,@"native editor mounted");editor=(__bridge SumiEditor *)handle;
    object_setClass(editor.text,CandidateProbeText.class);[window makeFirstResponder:editor.text];
    require([editor.text.validAttributesForMarkedText containsObject:editor.text.candidateBridge.marker],@"native input client declares stable capability");
    NSTextField *search=[[NSTextField alloc]initWithFrame:NSMakeRect(0,510,600,30)];[window.contentView addSubview:search];
    editor.text.selectedRange=NSMakeRange(body.length/2,0);[editor.text scrollRangeToVisible:editor.text.selectedRange];[editor.text layoutSubtreeIfNeeded];
    NSPoint scroll=editor.scroll.contentView.bounds.origin;NSSize viewport=editor.scroll.contentView.bounds.size;NSRange selection=editor.text.selectedRange;NSString *before=body.copy;
    NSUInteger serial=0;
    for(NSNumber *count in @[@0,@1,@32,@1,@0]){
        show(snapshot(count.unsignedIntegerValue,++serial));
        require(NSEqualPoints(scroll,editor.scroll.contentView.bounds.origin),@"candidate transitions preserve native scroll");
        require(NSEqualSizes(viewport,editor.scroll.contentView.bounds.size) && NSEqualRanges(selection,editor.text.selectedRange),@"candidate transitions preserve viewport and selection");
        require([editor.text.string isEqual:before] && revision==0,@"candidate data never enters document or transaction history");
        if(count.unsignedIntegerValue)require(fabs(NSMaxY(editor.text.candidateView.frame)-NSMaxY(editor.container.bounds))<.01,@"ordinary candidate bottom stays fixed");
        require(editor.text.candidateView.rowCount<=4,@"candidate rows bounded");
    }
    show(snapshot(32,++serial));
    if(argc>1){NSBitmapImageRep *bitmap=[editor.container bitmapImageRepForCachingDisplayInRect:editor.container.bounds];[editor.container cacheDisplayInRect:editor.container.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES];}
    // Moving the ordinary insertion point to the covered bottom never exposes a second caret.
    editor.text.selectedRange=NSMakeRange(body.length-1,0);[editor.text scrollRangeToVisible:editor.text.selectedRange];[editor.text refreshTypewriterCaret:NO];
    NSRect caret=[editor.container convertRect:editor.text.typewriterCaret.frame fromView:editor.text.typewriterCaret.superview];
    if(NSIntersectsRect(caret,editor.text.candidateView.frame))require(editor.text.typewriterCaret.hidden,@"covered caret is hidden without moving selection");
    [editor.text.candidateBridge releaseLease];
    NSMutableDictionary *appearance=editor.appearance.mutableCopy;appearance[@"focus_typing"]=@YES;editor.appearance=appearance;
    editor.text.selectedRange=selection;[editor.text scrollRangeToVisible:selection];
    for(int i=0;i<4;i++)[editor.text recordFocusInputAt:CACurrentMediaTime()+i*.01];
    require(editor.text.focusView!=nil,@"native focus presentation active");[editor.text.focusView.timer invalidate];editor.text.focusView.timer=nil;editor.text.focusView.progress=1;[editor.text updateFocusRows];
    SumiFocusRow *active=editor.text.focusView.rows.firstObject;NSRect activeBefore=[editor.text focusRect:NSMakeRect(active.rawOrigin.x,active.rawOrigin.y,1,active.height)];
    scroll=editor.scroll.contentView.bounds.origin;show(snapshot(32,++serial));
    NSRect activeAfter=[editor.text focusRect:NSMakeRect(active.rawOrigin.x,active.rawOrigin.y,1,active.height)];
    require(NSEqualRects(activeBefore,activeAfter),@"focus candidate does not move active line");
    require(NSMinY(editor.text.candidateView.frame)>=NSMaxY(activeAfter),@"focus candidates begin below full active line");
    require(editor.text.candidateGap==editor.text.candidateView.contentHeight && editor.text.candidateGap>0,@"temporary focus gap matches display height");
    for(SumiFocusRow *row in editor.text.focusView.rows)if(row.rawOrigin.y>active.rawOrigin.y){NSRect displayed=[editor.text focusRect:NSMakeRect(row.rawOrigin.x,row.rawOrigin.y,1,row.height)];require(NSMinY(displayed)>=NSMaxY(editor.text.candidateView.frame)-.1,@"following focus rows do not overlap candidates");}
    require(NSEqualPoints(scroll,editor.scroll.contentView.bounds.origin) && [editor.text.string isEqual:before],@"focus gap is presentation only");
    [window makeFirstResponder:search];require(editor.text.candidateSnapshot==nil && editor.text.candidateView.hidden && editor.text.candidateGap==0,@"search focus clears old candidates and gap");
    require([editor.text candidateGeneration]==nil,@"inactive body rejects handshake even with cached capability");
    [window makeFirstResponder:editor.text];[editor.text stopFocusTyping];
    require(!editor.text.candidateBridge.connected,@"first composition begins before asynchronous candidate handshake");
    NSDictionary *ordinarySelection=editor.text.selectedTextAttributes.copy;
    uint64_t beforeCompositionRevision=revision;
    NSUInteger insertion=editor.text.selectedRange.location;
    NSAttributedString *preedit=[[NSAttributedString alloc]initWithString:@"nihao" attributes:@{NSBackgroundColorAttributeName:NSColor.blueColor,NSFontAttributeName:[NSFont systemFontOfSize:9]}];
    [editor.text setMarkedText:preedit selectedRange:NSMakeRange(0,5) replacementRange:NSMakeRange(NSNotFound,0)];
    require(editor.text.hasMarkedText && editor.composing,@"real NSTextView composition retained");
    NSDictionary *attrs=[editor.text.textStorage attributesAtIndex:editor.text.markedRange.location effectiveRange:NULL];require(!attrs[NSBackgroundColorAttributeName] && [attrs[NSFontAttributeName]isEqual:[editor baseFont]],@"unconnected first preedit retains body font and no stored blue fill");
    require([editor.text.selectedTextAttributes[NSBackgroundColorAttributeName]alphaComponent]==0 && [editor.text.selectedTextAttributes[NSUnderlineStyleAttributeName]integerValue]==NSUnderlineStyleSingle,@"unconnected first selected IME clause uses clear background and thin underline");
    require([editor.text.candidateNormalSelection isEqual:ordinarySelection] && revision==beforeCompositionRevision && [body isEqual:before],@"preedit saves ordinary selection feedback without a document transaction");
    NSRange markedBeforeRelease=editor.text.markedRange,selectedBeforeRelease=editor.text.selectedRange;NSString *composingText=editor.text.string.copy;
    editor.text.candidateBridge.lease=@"test";editor.text.candidateBridge.context=@"test";editor.text.candidateBridge.generation=@"1";editor.text.candidateBridge.lastSeen=CACurrentMediaTime();
    [editor.text.candidateBridge releaseLease];
    require(!editor.text.candidateBridge.connected && editor.text.hasMarkedText && editor.composing,@"candidate lease loss leaves native composition active");
    require([editor.text.selectedTextAttributes[NSBackgroundColorAttributeName]alphaComponent]==0 && [editor.text.candidateNormalSelection isEqual:ordinarySelection],@"lease loss does not restore a filled IME selection");
    require(NSEqualRanges(markedBeforeRelease,editor.text.markedRange) && NSEqualRanges(selectedBeforeRelease,editor.text.selectedRange) && [editor.text.string isEqual:composingText] && revision==beforeCompositionRevision,@"lease loss does not rewrite text, selection, composition or revision");
    [editor.text insertText:@"你好" replacementRange:NSMakeRange(NSNotFound,0)];
    require([body isEqual:[before stringByReplacingCharactersInRange:NSMakeRange(insertion,0) withString:@"你好"]],@"one complete native commit without raw pinyin");
    require([editor.text.selectedTextAttributes isEqual:ordinarySelection],@"normal selection styling restored after commit");
    require(!editor.scroll.hasVerticalScroller,@"scrollbar absent while native scroll remains available");
    require(!window.visible,@"probe stays offscreen");sumi_editor_detach(handle);
    printf("PASS %lu native host candidate checks\n",(unsigned long)checks);return 0;
}return 77;}}
