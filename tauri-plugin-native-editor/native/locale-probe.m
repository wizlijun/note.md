// Real unordered AppKit controls; no visible window, real input-source switch or Vault.
#import "editor.m"
static NSUInteger eventCount;
static NSEvent *menuEvent(void){return [NSEvent mouseEventWithType:NSEventTypeRightMouseDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil eventNumber:0 clickCount:1 pressure:1];}
static void require(BOOL ok,NSString *message){if(!ok){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;(void)reply;eventCount++;NSDictionary *event=SumiJSON(json);
    return [event[@"kind"] isEqualToString:@"edit"] ? [event[@"base_revision"] longLongValue]+1 : 0;
}
static void freeReply(char *reply){free(reply);}
static NSMenuItem *menuAction(NSMenu *menu,SEL selector,NSString *command){
    for(NSMenuItem *item in menu.itemArray)if(item.action==selector && (!command || [item.representedObject isEqual:command]))return item;
    return nil;
}
static void checkControls(SumiEditor *editor,NSString *locale,NSString *copy,NSString *brand,NSString *link,NSString *apply,NSString *cancel,NSString *accessibility){
    NSMenu *menu=[editor.text menuForEvent:menuEvent()];
    require([menuAction(menu,@selector(copy:),nil).title isEqual:copy],@"native Copy menu localized");
    require([menuAction(menu,@selector(sumiMenu:),nil).title isEqual:brand],@"localized product name");
    require([menuAction(menu,@selector(sumiMenuCommand:),@"link").title isEqual:[link stringByAppendingString:@"…"]],@"link action identity and title");
    require([editor.text.accessibilityLabel isEqual:accessibility],@"native accessibility label localized");
    NSAlert *alert=SumiLinkAlert(locale);
    require([alert.messageText isEqual:link] && [alert.buttons[0].title isEqual:apply] && [alert.buttons[1].title isEqual:cancel],@"actual link dialog title and buttons localized");
    require([((NSTextField *)alert.accessoryView).placeholderString isEqual:@"https://"],@"URL field content is language independent");
    require(!alert.window.visible,@"link dialog probe remains unordered");
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"locale-probe\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":760,\"height\":540},\"appearance\":{\"font_family\":\"Menlo\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#00BFFF\",\"background\":\"#000000\",\"max_columns\":80,\"bottom_inset\":80,\"caret_motion\":\"steady\"},\"document\":{\"text\":\"原文 日本語 English\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,config,receive,freeReply,NULL);
    require(handle!=NULL,@"mount with legacy appearance lacking locale");SumiEditor *editor=(__bridge SumiEditor *)handle;
    checkControls(editor,@"en",@"Copy",@"Sumi Typewriter…",@"Link",@"Apply",@"Cancel",@"Sumi Typewriter writing editor");
    NSMenu *originalMenu=[editor.text menuForEvent:menuEvent()];
    [editor.text setMarkedText:@"zhong" selectedRange:NSMakeRange(2,1) replacementRange:NSMakeRange(0,0)];
    require(editor.composing && editor.text.hasMarkedText,@"actual preedit active");
    NSString *text=[editor.text.string copy];NSRange selected=editor.text.selectedRange,marked=editor.text.markedRange;
    NSDictionary *appearance=editor.appearance;uint64_t revision=editor.revision;NSUInteger events=eventCount,lastRestyled=editor.lastRestyled;
    CFTimeInterval epoch=editor.text.caretBreathingEpoch;BOOL caretHidden=editor.text.typewriterCaret.hidden;
    require(sumi_editor_command(handle,"{\"command\":\"set_bounds\",\"bounds\":{\"x\":0,\"y\":0,\"width\":720,\"height\":500}}") == 0,@"same-owner reload can refresh geometry while composing");
    require(sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":true}") == 0,@"already-visible recovery is an IME-safe no-op");
    require(sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":false}") == 1,@"actual hiding still rejects active composition");
    require([editor.text.string isEqual:text] && NSEqualRanges(editor.text.selectedRange,selected) && NSEqualRanges(editor.text.markedRange,marked) && editor.composing && editor.text.hasMarkedText && editor.revision==revision && !editor.container.hidden,@"handle recovery preserves preedit, selection, revision and visibility");
    events=eventCount;
    NSArray *cases=@[
        @[@"zh-CN",@"复制",@"玄霜打字机…",@"链接",@"应用",@"取消",@"玄霜打字机写作编辑器"],
        @[@"ja_JP",@"コピー",@"すみ…",@"リンク",@"適用",@"キャンセル",@"すみの執筆エディタ"],
        @[@"ZH_Hant_TW",@"复制",@"玄霜打字机…",@"链接",@"应用",@"取消",@"玄霜打字机写作编辑器"],
        @[@"en-GB",@"Copy",@"Sumi Typewriter…",@"Link",@"Apply",@"Cancel",@"Sumi Typewriter writing editor"],
        @[@"unsupported",@"Copy",@"Sumi Typewriter…",@"Link",@"Apply",@"Cancel",@"Sumi Typewriter writing editor"]
    ];
    for(NSArray *row in cases){
        NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"command":@"set_locale",@"locale":row[0]} options:0 error:nil];
        NSString *command=[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding];
        require(sumi_editor_command(handle,command.UTF8String)==0,@"locale update accepted during composition");
        checkControls(editor,row[0],row[1],row[2],row[3],row[4],row[5],row[6]);
        require([editor.text.string isEqual:text] && NSEqualRanges(editor.text.selectedRange,selected) && NSEqualRanges(editor.text.markedRange,marked) && editor.composing && editor.text.hasMarkedText,@"locale never changes text/selection/marked text");
        require(editor.appearance==appearance && [editor.appearance[@"caret_motion"] isEqual:@"steady"] && editor.text.caretBreathingEpoch==epoch && editor.text.typewriterCaret.hidden==caretHidden && editor.lastRestyled==lastRestyled,@"locale never changes appearance/caret/rendering");
        require(editor.revision==revision && eventCount==events,@"locale emits no edit or revision change");
        NSMenu *menu=[editor.text menuForEvent:menuEvent()];require(menu.numberOfItems==originalMenu.numberOfItems,@"same menu operations");
        for(NSInteger i=0;i<menu.numberOfItems;i++){
            NSMenuItem *before=[originalMenu itemAtIndex:i],*after=[menu itemAtIndex:i];
            require(before.action==after.action && [before.keyEquivalent isEqual:after.keyEquivalent] && (before.representedObject==after.representedObject || [before.representedObject isEqual:after.representedObject]),@"menu command and shortcut identities unchanged");
        }
    }
    require(!NSApp.isActive && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"foreground untouched");
    for(NSWindow *opened in NSApp.windows)require(!opened.visible,@"all probe windows remain hidden");
    [editor.text unmarkText];sumi_editor_detach(handle);
    printf("PASS: native zh/ja/en region fallback, actual menus/link dialog/a11y, legacy default, live language during markedText preserves content/selection/steady caret and command identities\n");
}}
