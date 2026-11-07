// A standalone AppKit integration probe. It does not replace real Tauri/IME UI acceptance.
#import "editor.m"
static NSMutableArray *events;
static BOOL rejectNext=NO;
static BOOL atomicUndo=NO;
static int64_t expectedEditRevision=-1;
static void freeReply(char *value){free(value);}
static int64_t callback(void *context,const char *json,char **projection){
    (void)context;
    NSDictionary *event=SumiJSON(json);[events addObject:event];
    if(atomicUndo && [event[@"action"] isEqualToString:@"undo"]){
        *projection=strdup("{\"document\":{\"text\":\"atomic 😀\",\"runs\":[]},\"selection\":{\"start\":9,\"length\":0}}");
        expectedEditRevision=[event[@"revision"] longLongValue]+1;
        return expectedEditRevision;
    }
    if([event[@"kind"] isEqualToString:@"edit"]){if(rejectNext){rejectNext=NO;return -1;}
        int64_t revision=[event[@"base_revision"] longLongValue];
        if(expectedEditRevision>=0 && revision!=expectedEditRevision)return -1;
        expectedEditRevision=-1;return revision+1;
    }
    return 0;
}
static void require(BOOL condition,NSString *message){if(!condition){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static NSDictionary *state(void *handle){
    char *json=sumi_editor_inspect(handle);NSDictionary *s=SumiJSON(json);sumi_editor_free_string(json);
    for(NSString *key in @[@"composing",@"textkit2",@"visible"])
        require(CFGetTypeID((__bridge CFTypeRef)s[key])==CFBooleanGetTypeID(),[NSString stringWithFormat:@"%@ is a JSON boolean, not an integer",key]);
    return s;
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSArray *samples=@[@"",@"a",@"😀",@"😃",@"a😀b",@"a😃b",@"你\n好",@"é",@"ẽ",@"👩‍💻",@"👩‍🔧",@"  "];
    for(NSString *before in samples)for(NSString *after in samples){
        NSDictionary *delta=SumiDifference(before,after);
        require([[before stringByReplacingCharactersInRange:SumiReadRange(delta[@"range"]) withString:delta[@"replacement"]] isEqualToString:after],@"Unicode replacement roundtrip");
    }
    events=[NSMutableArray new];
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"probe\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":10,\"y\":20,\"width\":700,\"height\":500},\"appearance\":{\"font_family\":\"Helvetica\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#cccccc\",\"background\":\"#111111\",\"max_columns\":80,\"bottom_inset\":80},\"document\":{\"text\":\"hello 😀\",\"runs\":[]}}";
    // Model a WebView with a nonzero inset inside the window. Native bounds
    // must use its local viewport, including after resize, not contentView.
    NSView *reference=[[SumiContainer alloc] initWithFrame:NSMakeRect(12,30,760,540)];
    [window.contentView addSubview:reference];
    void *handle=sumi_editor_mount((__bridge void *)reference,1,config,callback,freeReply,NULL);
    require(handle!=NULL,@"mount");SumiEditor *editor=(__bridge SumiEditor *)handle;
    require(NSEqualRects([reference convertRect:editor.container.frame fromView:window.contentView],NSMakeRect(10,20,700,500)),@"mount is relative to WebView viewport");
    require(sumi_editor_command(handle,"{\"command\":\"set_bounds\",\"bounds\":{\"x\":20,\"y\":40,\"width\":600,\"height\":400}}") == 0,@"bounds update");
    require(NSEqualRects([reference convertRect:editor.container.frame fromView:window.contentView],NSMakeRect(20,40,600,400)),@"resize is relative to WebView viewport");
    [window orderFront:nil];sumi_editor_command(handle,"{\"command\":\"focus\"}");
    require([state(handle)[@"textkit2"] boolValue],@"TextKit 2 at mount");
    [editor.text insertText:@"世界" replacementRange:NSMakeRange(0,5)];
    require([state(handle)[@"text"] isEqualToString:@"世界 😀"],@"local edit");
    require([state(handle)[@"revision"] intValue]==1,@"accepted revision");
    rejectNext=YES;[editor.text insertText:@"discard" replacementRange:NSMakeRange(0,2)];
    require([state(handle)[@"text"] isEqualToString:@"世界 😀"],@"rejected edit restores display");
    NSUInteger edits=0;for(NSDictionary *e in events)if([e[@"kind"] isEqualToString:@"edit"])edits++;
    [editor.text setMarkedText:@"ni" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(0,0)];
    NSUInteger markedEdits=0;for(NSDictionary *e in events)if([e[@"kind"] isEqualToString:@"edit"])markedEdits++;
    require(markedEdits==edits,@"marked text does not emit edit");
    require(sumi_editor_command(handle,"{\"command\":\"apply_document\",\"base_revision\":1,\"revision\":2,\"document\":{\"text\":\"remote\",\"runs\":[]},\"selection\":{\"start\":0,\"length\":0}}") == 1,@"remote blocked during composition");
    [editor.text insertText:@"你" replacementRange:NSMakeRange(NSNotFound,0)];
    require(![state(handle)[@"composing"] boolValue],@"composition ends");
    require([state(handle)[@"text"] isEqualToString:@"你世界 😀"],@"committed IME text");
    require([state(handle)[@"revision"] intValue]==2,@"one revision for IME commit");
    require(sumi_editor_command(handle,"{\"command\":\"apply_document\",\"base_revision\":1,\"revision\":3,\"document\":{\"text\":\"stale\",\"runs\":[]},\"selection\":{\"start\":0,\"length\":0}}") == 2,@"stale remote rejected");
    require(sumi_editor_command(handle,"{\"command\":\"apply_document\",\"base_revision\":2,\"revision\":3,\"document\":{\"text\":\"remote 😀\",\"runs\":[{\"range\":{\"start\":0,\"length\":6},\"bold\":true}]},\"selection\":{\"start\":6,\"length\":0}}") == 0,@"remote accepted");
    require([state(handle)[@"textkit2"] boolValue],@"TextKit 2 after styled remote edit");
    NSFont *font=[editor.text.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    require(([[NSFontManager sharedFontManager] traitsOfFont:font] & NSBoldFontMask)!=0,@"rich bold style applied");
    [editor.text undo:nil];require([events.lastObject[@"action"] isEqualToString:@"undo"],@"undo routes to CRDT");
    require(sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":false}")==0,@"overlay hides surface");
    require(![state(handle)[@"visible"] boolValue],@"hidden state");
    NSString *longText=[@"a" stringByPaddingToLength:100000 withString:@"a" startingAtIndex:0];
    NSDictionary *projection=@{@"command":@"apply_document",@"base_revision":@3,@"revision":@4,@"document":@{@"text":longText,@"runs":@[]},@"selection":@{@"start":@100000,@"length":@0}};
    NSData *encoded=[NSJSONSerialization dataWithJSONObject:projection options:0 error:nil];NSString *json=[[NSString alloc]initWithData:encoded encoding:NSUTF8StringEncoding];
    require(sumi_editor_command(handle,json.UTF8String)==0,@"100k projection");
    NSMutableDictionary *same=[projection mutableCopy];same[@"base_revision"]=@4;
    encoded=[NSJSONSerialization dataWithJSONObject:same options:0 error:nil];json=[[NSString alloc]initWithData:encoded encoding:NSUTF8StringEncoding];
    require(sumi_editor_command(handle,json.UTF8String)==0 && editor.lastRestyled==0,@"unchanged projection skips all attribute writes");
    [editor.text insertText:@"b" replacementRange:NSMakeRange(100000,0)];
    same[@"base_revision"]=@5;same[@"revision"]=@5;same[@"document"]=@{@"text":[longText stringByAppendingString:@"b"],@"runs":@[]};
    encoded=[NSJSONSerialization dataWithJSONObject:same options:0 error:nil];json=[[NSString alloc]initWithData:encoded encoding:NSUTF8StringEncoding];
    require(sumi_editor_command(handle,json.UTF8String)==0 && editor.lastRestyled<=2,@"single edit restyles only affected UTF16 range");
    atomicUndo=YES;[editor.text undo:nil];
    require([editor.text.string isEqualToString:@"atomic 😀"] && editor.revision==6,@"undo reply installs projection before returning");
    [editor.text insertText:@"X" replacementRange:editor.text.selectedRange];
    require([editor.text.string isEqualToString:@"atomic 😀X"] && editor.revision==7,@"immediate input after undo uses its accepted revision");
    NSEvent *fullscreen=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:(NSEventModifierFlagCommand|NSEventModifierFlagControl) timestamp:0 windowNumber:window.windowNumber context:nil characters:@"f" charactersIgnoringModifiers:@"f" isARepeat:NO keyCode:3];
    require([editor.text performKeyEquivalent:fullscreen],@"standard fullscreen shortcut consumed by native editor");
    require([events.lastObject[@"action"] isEqualToString:@"fullscreen"],@"fullscreen routes to its owner without inserting text");
    NSUInteger children=window.contentView.subviews.count;sumi_editor_detach(handle);
    require(window.contentView.subviews.count+1==children,@"detach removes view");
    NSData *eventJSON=[NSJSONSerialization dataWithJSONObject:events options:NSJSONWritingPrettyPrinted error:nil];
    [eventJSON writeToFile:@"tasks/sumi-native/appkit-events.json" atomically:YES];
    printf("PASS: native mount, TextKit2, local range, reject, IME commit gate, revision, rich style, undo, overlay, detach\n");
    [window orderOut:nil];
}}
