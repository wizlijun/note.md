// Real AppKit isolated failure handling, no ordered window or production Vault.
#import "editor.m"
static SumiEditor *probeEditor;
static NSString *rejectKind,*nextDraft;
static NSUInteger mutations,saveRequests;
static BOOL rejectWithoutProjection;
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static void replyJSON(char **reply,NSDictionary *value){NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];*reply=strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;NSDictionary *event=SumiJSON(json);NSString *kind=event[@"kind"];
    if([kind isEqualToString:@"action"] && [event[@"action"] isEqualToString:@"save"]){saveRequests++;return probeEditor.revision;}
    if([kind isEqualToString:@"clipboard"] && ![event[@"cut"] boolValue]){
        replyJSON(reply,@{@"clipboard_text":[@"**" stringByAppendingFormat:@"%@**",probeEditor.text.string]});return probeEditor.revision;
    }
    if([kind isEqualToString:rejectKind]){
        mutations++;
        NSMutableDictionary *value=[@{@"draft_error":@"测试：本机磁盘无法提交"} mutableCopy];
        if(!rejectWithoutProjection)value[@"projection"]=@{@"document":@{@"text":nextDraft,@"runs":@[]},@"selection":SumiRange(NSMakeRange(nextDraft.length,0))};
        replyJSON(reply,value);return -2;
    }
    return probeEditor.revision;
}
static void freeReply(char *reply){free(reply);}
static void recover(void *handle){
    NSDictionary *command=@{@"command":@"apply_document",@"base_revision":@(probeEditor.revision),@"revision":@(probeEditor.revision+1),@"document":@{@"text":probeEditor.text.string,@"runs":@[]},@"selection":SumiRange(probeEditor.text.selectedRange)};
    NSData *data=[NSJSONSerialization dataWithJSONObject:command options:0 error:nil];
    require(sumi_editor_command(handle,[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String)==0,@"successful retry explicitly installs committed document");
    require(!probeEditor.draftError && probeEditor.text.editable && [probeEditor.committed isEqualToString:probeEditor.text.string],@"only successful apply restores editing and accepted text");
}
static void frozen(NSString *committed,uint64_t revision,NSString *draft){
    require([probeEditor.text.string isEqualToString:draft],@"unpersisted draft remains visible");
    require(probeEditor.revision==revision && [probeEditor.committed isEqualToString:committed],@"rejection never advances accepted revision or committed text");
    require(probeEditor.draftError && !probeEditor.text.editable && probeEditor.text.selectable,@"draft is read-only but selectable");
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"draft-probe\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":760,\"height\":540},\"appearance\":{\"font_family\":\"Menlo\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#44413c\",\"background\":\"#f3ead7\",\"max_columns\":80,\"bottom_inset\":80},\"document\":{\"text\":\"原稿\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,config,receive,freeReply,NULL);require(handle!=NULL,@"mount");probeEditor=(__bridge SumiEditor *)handle;
    rejectKind=@"edit";nextDraft=@"原稿新输入";probeEditor.text.selectedRange=NSMakeRange(2,0);
    [probeEditor.text insertText:@"新输入" replacementRange:NSMakeRange(NSNotFound,0)];
    frozen(@"原稿",0,nextDraft);require(mutations==1,@"one rejected edit");
    [probeEditor.text insertText:@"不能继续" replacementRange:NSMakeRange(NSNotFound,0)];
    [probeEditor.text setMarkedText:@"bu" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(NSNotFound,0)];
    [probeEditor.text undo:nil];[probeEditor.text cut:nil];
    frozen(@"原稿",0,nextDraft);require(mutations==1,@"frozen draft rejects typing, IME, undo and cut");
    NSPasteboard *board=[NSPasteboard pasteboardWithUniqueName];[probeEditor.text selectAll:nil];
    require([probeEditor.text writeMarkdownToPasteboard:board cut:NO],@"read-only draft can still be copied as Markdown");
    require([[board stringForType:NSPasteboardTypeString] isEqualToString:@"**原稿新输入**"],@"copy reads current retained draft");
    require(sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":false}")==5 && !probeEditor.container.hidden,@"unsafe close cannot hide draft");
    require(sumi_editor_command(handle,"{\"command\":\"prepare_panel\"}")==5,@"unsafe panel handoff preserves draft");
    require(sumi_editor_command(handle,"{\"command\":\"apply_document\",\"base_revision\":999,\"revision\":1000,\"document\":{\"text\":\"wrong\",\"runs\":[]},\"selection\":{\"start\":0,\"length\":0}}") == 2,@"failed apply cannot clear native draft protection");
    frozen(@"原稿",0,nextDraft);
    [probeEditor.text sumiCommand:@"save"];require(saveRequests==1 && probeEditor.draftError,@"save retry remains routable without falsely acknowledging draft");
    recover(handle);
    NSString *committed=[probeEditor.committed copy];uint64_t revision=probeEditor.revision;
    rejectKind=@"paste";nextDraft=[committed stringByAppendingString:@"粘贴内容"];
    [board clearContents];[board setString:@"粘贴内容" forType:NSPasteboardTypeString];
    [probeEditor.text pasteFromPasteboard:board literal:NO];frozen(committed,revision,nextDraft);recover(handle);
    committed=[probeEditor.committed copy];revision=probeEditor.revision;
    rejectKind=@"clipboard";nextDraft=@"剪切后仍可恢复的正文";[probeEditor.text selectAll:nil];
    require([probeEditor.text writeMarkdownToPasteboard:board cut:YES],@"cut copies before trying canonical mutation");
    frozen(committed,revision,nextDraft);recover(handle);
    committed=[probeEditor.committed copy];revision=probeEditor.revision;
    rejectKind=@"action";nextDraft=@"格式操作生成的草稿";[probeEditor action:@"bold"];
    frozen(committed,revision,nextDraft);recover(handle);
    committed=[probeEditor.committed copy];revision=probeEditor.revision;rejectKind=@"edit";
    nextDraft=[committed stringByAppendingString:@"你好"];
    probeEditor.text.selectedRange=NSMakeRange(committed.length,0);
    [probeEditor.text setMarkedText:@"nihao" selectedRange:NSMakeRange(5,0) replacementRange:NSMakeRange(NSNotFound,0)];
    [probeEditor.text insertText:@"你好" replacementRange:NSMakeRange(NSNotFound,0)];
    frozen(committed,revision,nextDraft);require(!probeEditor.composing && !probeEditor.text.hasMarkedText,@"IME finishes into a protected draft without stale composition");recover(handle);
    committed=[probeEditor.committed copy];revision=probeEditor.revision;
    nextDraft=[committed stringByAppendingString:@"预编辑"];
    probeEditor.text.selectedRange=NSMakeRange(committed.length,0);
    [probeEditor.text setMarkedText:@"预编辑" selectedRange:NSMakeRange(3,0) replacementRange:NSMakeRange(NSNotFound,0)];
    require(sumi_editor_command(handle,"{\"command\":\"prepare_panel\"}")==5,@"panel failure keeps preedit-derived draft visible");
    frozen(committed,revision,nextDraft);require(!probeEditor.composing && !probeEditor.text.hasMarkedText,@"frozen panel draft can be retried without composition deadlock");recover(handle);
    committed=[probeEditor.committed copy];revision=probeEditor.revision;rejectWithoutProjection=YES;
    probeEditor.text.selectedRange=NSMakeRange(committed.length,0);nextDraft=[committed stringByAppendingString:@"末字"];
    [probeEditor.text insertText:@"末字" replacementRange:NSMakeRange(NSNotFound,0)];frozen(committed,revision,nextDraft);
    [board releaseGlobally];sumi_editor_detach(handle);
    puts("PASS: rejected edit/paste/cut/action/IME/panel drafts stay visible, no positive ACK, read-only Markdown copy, hide blocked, explicit recovery unlocks; no UI activation");
}}
