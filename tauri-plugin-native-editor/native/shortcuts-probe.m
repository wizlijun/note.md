// Hidden-window AppKit probe. Does not activate or order a window on screen.
#import "editor.m"
static NSMutableArray *events;
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);@throw [NSException exceptionWithName:@"ProbeFailure" reason:message userInfo:nil];}}
static void freeReply(char *p){free(p);}
static int64_t receive(void *ctx,const char *json,char **reply){
    (void)ctx;(void)reply;NSDictionary *event=SumiJSON(json);[events addObject:event];
    return [event[@"kind"] isEqual:@"edit"]?[event[@"base_revision"] longLongValue]+1:[event[@"revision"] longLongValue];
}
static NSTextField *field(NSView *view,NSString *placeholder){
    if([view isKindOfClass:NSTextField.class] && [[(NSTextField*)view placeholderString] isEqual:placeholder])return (NSTextField*)view;
    for(NSView *child in view.subviews){NSTextField *result=field(child,placeholder);if(result)return result;}return nil;
}
static void change(NSTextField *field,NSString *value){
    field.stringValue=value;
    NSNotification *note=[NSNotification notificationWithName:NSControlTextDidChangeNotification object:field];
    if([field.delegate respondsToSelector:@selector(controlTextDidChange:)])[field.delegate controlTextDidChange:note];
    if(field.action)[field sendAction:field.action to:field.target];
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];events=[NSMutableArray new];
    NSPasteboard *findPasteboard=[NSPasteboard pasteboardWithName:NSPasteboardNameFind];NSMutableArray *savedFind=[NSMutableArray new];
    for(NSPasteboardItem *old in findPasteboard.pasteboardItems){NSPasteboardItem *copy=[NSPasteboardItem new];for(NSPasteboardType type in old.types){NSData *data=[old dataForType:type];if(data)[copy setData:data forType:type];}[savedFind addObject:copy];}
    @try {
    NSEventModifierFlags cmd=NSEventModifierFlagCommand,shift=NSEventModifierFlagShift,alt=NSEventModifierFlagOption,ctrl=NSEventModifierFlagControl;
    require([SumiShortcut(@"b",11,cmd) isEqual:@"bold"],@"Command B");
    require(SumiShortcut(@"b",11,cmd|shift)==nil && SumiShortcut(@"b",11,cmd|alt)==nil && SumiShortcut(@"n",45,cmd|ctrl)==nil,@"extra modifiers not swallowed");
    require([SumiShortcut(@"f",3,cmd|ctrl) isEqual:@"fullscreen"] && [SumiShortcut(@"f",3,cmd|alt) isEqual:@"replace"],@"exact fullscreen and replace");
    require([SumiShortcut(@"8",28,cmd|shift) isEqual:@"bullet_list"] && [SumiShortcut(@"*",28,cmd|shift) isEqual:@"bullet_list"],@"shifted key spellings");
    require([SumiShortcut(@"1",18,cmd|alt) isEqual:@"heading1"] && [SumiShortcut(@"v",9,cmd|alt|shift) isEqual:@"paste_plain"],@"heading and plain paste");
    require([SumiShortcut(@"",123,cmd|alt) isEqual:@"previous_page"] && SumiShortcut(@"",123,cmd|alt|shift)==nil,@"page navigation does not steal selection");
    require(SumiShortcut(@"a",0,ctrl)==nil && SumiShortcut(@"",123,alt)==nil,@"AppKit text movement inherited");
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,700,500) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"keys\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":700,\"height\":500},\"appearance\":{\"font_family\":\"Helvetica\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#cccccc\",\"background\":\"#111111\",\"max_columns\":80,\"bottom_inset\":20},\"document\":{\"text\":\"alpha 中文😀 beta alpha\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void*)window.contentView,0,config,receive,freeReply,NULL);require(handle!=NULL,@"mount");
    SumiEditor *owner=(__bridge SumiEditor*)handle;SumiTextView *text=owner.text;
    NSTextField *ordinary=[[NSTextField alloc]initWithFrame:NSMakeRect(0,0,100,24)];[window.contentView addSubview:ordinary];
    [window makeFirstResponder:ordinary];NSUInteger unselectedCount=events.count;
    NSEvent *newKey=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:cmd timestamp:0 windowNumber:window.windowNumber context:nil characters:@"n" charactersIgnoringModifiers:@"n" isARepeat:NO keyCode:45];
    require(![text performKeyEquivalent:newKey] && events.count==unselectedCount,@"ordinary text field does not invoke hidden body shortcut");
    [window makeFirstResponder:text];require([text performKeyEquivalent:newKey] && [events.lastObject[@"action"] isEqual:@"new_page"],@"actual native responder consumes its shortcut");
    [ordinary removeFromSuperview];
    [text setSelectedRange:NSMakeRange(6,4)];[text sumiCommand:@"bold"];
    require([events.lastObject[@"action"] isEqual:@"bold"] && [events.lastObject[@"range"][@"length"] intValue]==4,@"format carries actual selection");
    [text insertTab:nil];require([events.lastObject[@"action"] isEqual:@"indent"],@"Tab routes through canonical core");
    [text insertBacktab:nil];require([events.lastObject[@"action"] isEqual:@"outdent"],@"Backtab routes through canonical core");
    [text insertLineBreak:nil];require([events.lastObject[@"action"] isEqual:@"hard_break"],@"Shift Return is explicit Markdown break");
    owner.composing=YES;NSUInteger count=events.count;[text sumiCommand:@"new_page"];require(events.count==count,@"composition blocks page mutation");owner.composing=NO;
    [text sumiCommand:@"find"];require(owner.scroll.findBarVisible,@"native find bar is available");
    [text sumiCommand:@"replace"];require(owner.scroll.findBarVisible,@"native replace bar is available");
    NSTextField *search=field(owner.scroll.findBarView,@"Find"),*replacement=field(owner.scroll.findBarView,@"Replace");
    require(search && replacement,@"find and replacement fields");
    [text setSelectedRange:NSMakeRange(0,5)];NSMenuItem *setSearch=[NSMenuItem new];setSearch.tag=NSTextFinderActionSetSearchString;[text performTextFinderAction:setSearch];
    change(replacement,@"BETA");
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.15]];

    [text setSelectedRange:NSMakeRange(0,0)];[text sumiCommand:@"find_next"];

    require(text.selectedRange.length==5,@"find next selects current page match");
    NSMenuItem *replace=[NSMenuItem new];replace.tag=NSTextFinderActionReplace;
    NSUInteger beforeEdits=events.count;[text performTextFinderAction:replace];

    require([text.string containsString:@"BETA"],@"native finder replaces selected match");
    BOOL edited=NO;for(NSUInteger i=beforeEdits;i<events.count;i++)if([events[i][@"kind"] isEqual:@"edit"])edited=YES;
    require(edited,@"finder replacement reaches canonical edit transaction");
    replace.tag=NSTextFinderActionReplaceAll;[text performTextFinderAction:replace];
    require(![text.string containsString:@"alpha"],@"native Replace All changes all matches");
    [text sumiCommand:@"escape"];require(!owner.scroll.findBarVisible,@"Escape dismisses find first");
    require(SumiFindBarOwner(window.contentView)==nil,@"hidden find bar cannot steal field commands");
    NSRange emoji=[text.string rangeOfString:@"😀"];[text setSelectedRange:NSMakeRange(emoji.location,0)];
    [text moveRight:nil];require(text.selectedRange.location==NSMaxRange(emoji),@"right arrow preserves emoji");
    [text moveLeftAndModifySelection:nil];require(NSEqualRanges(text.selectedRange,emoji),@"shift movement selects whole emoji");
    beforeEdits=events.count;[text deleteBackward:nil];BOOL deleted=NO;
    for(NSUInteger i=beforeEdits;i<events.count;i++)if([events[i][@"kind"] isEqual:@"edit"])deleted=YES;
    require(deleted && ![text.string containsString:@"😀"],@"native deletion is canonical Edit");
    require(!window.visible,@"probe did not display a window");
    sumi_editor_detach(handle);printf("PASS: exact shortcuts, native selection/actions, IME gate, Find/Replace/Replace All -> Edit, Escape, emoji movement/deletion\n");
    } @catch(NSException *error){fprintf(stderr,"%s\n",error.reason.UTF8String);return 1;}
    @finally{[findPasteboard clearContents];if(savedFind.count)[findPasteboard writeObjects:savedFind];}
}}
