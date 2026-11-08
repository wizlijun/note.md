// Real AppKit/TextKit 2 selection and viewport restore; no synthetic user events.
#import "editor.m"
static void require(BOOL ok,NSString *why){if(!ok){fprintf(stderr,"FAIL: %s\n",why.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **projection){(void)context;(void)json;(void)projection;return 0;}
static void releaseReply(char *reply){free(reply);}
static NSString *json(id value){return [[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] encoding:NSUTF8StringEncoding];}
static void settle(void){[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.15]];}
static void showPosition(SumiEditor *editor,NSString *stage){printf("%s viewport=%s clip=%s text=%s\n",stage.UTF8String,json([editor viewport]).UTF8String,NSStringFromRect(editor.scroll.contentView.bounds).UTF8String,NSStringFromRect(editor.text.frame).UTF8String);fflush(stdout);}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(20,20,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    NSView *view=[[SumiContainer alloc]initWithFrame:NSMakeRect(0,0,800,600)];[window.contentView addSubview:view];
    NSMutableString *body=[NSMutableString new];NSUInteger top=0,caret=0;
    for(NSUInteger line=0;line<500;line++){if(line==200)top=body.length;if(line==300)caret=body.length;[body appendFormat:@"行 %03lu — reading 😀 position\n",(unsigned long)line];}
    NSMutableDictionary *config=[@{@"surface_id":@"position-probe",@"generation":@1,@"revision":@0,@"bounds":@{@"x":@0,@"y":@0,@"width":@800,@"height":@600},@"appearance":@{@"font_family":@"Helvetica",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#cccccc",@"background":@"#111111",@"max_columns":@80,@"bottom_inset":@0},@"document":@{@"text":body,@"runs":@[]},@"selection":@{@"start":@(caret),@"length":@1},@"viewport":@{@"start":@(top),@"offset":@3}} mutableCopy];
    void *handle=sumi_editor_mount((__bridge void *)view,1,json(config).UTF8String,receive,releaseReply,NULL);require(handle!=NULL,@"mount");
    SumiEditor *editor=(__bridge SumiEditor *)handle;
    require(editor.text.selectedRange.location==caret && editor.text.selectedRange.length==1,@"initial selection restored independently from reading viewport");
    require(sumi_editor_command(handle,"{\"command\":\"focus\"}")==0,@"focus restored surface");
    NSDictionary *position=[editor viewport];
    printf("expected top=%lu, actual=%s scrollY=%.2f\n",(unsigned long)top,json(position).UTF8String,editor.scroll.contentView.bounds.origin.y);
    require([position[@"start"] unsignedIntegerValue]>=top && [position[@"start"] unsignedIntegerValue]<top+32,@"viewport restores the requested paragraph, not the caret");
    require(fabs([position[@"offset"] doubleValue]-3)<1,@"partial-line offset restored");
    require(editor.text.textLayoutManager!=nil,@"position APIs preserve TextKit 2");
    config[@"viewport"]=position;config[@"selection"]=SumiRange(editor.text.selectedRange);
    sumi_editor_detach(handle);
    handle=sumi_editor_mount((__bridge void *)view,1,json(config).UTF8String,receive,releaseReply,NULL);require(handle!=NULL,@"remount");editor=(__bridge SumiEditor *)handle;
    NSDictionary *again=[editor viewport];
    require([again[@"start"] isEqual:position[@"start"]],@"remount preserves visible anchor");
    require(fabs([again[@"offset"] doubleValue]-[position[@"offset"] doubleValue])<1,@"remount preserves paragraph offset");
    require(editor.text.selectedRange.location==caret,@"remount preserves selection");
    sumi_editor_detach(handle);
    // Match the production typewriter cascade and large-font wrapped paragraphs.
    NSString *fonts=[NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:@"src-tauri/resources/sumi"];
    NSArray *files=@[@"IBMPlexMono-Light.ttf",@"IBMPlexSansSC-Light.otf"];
    NSArray *families=@[@"IBMPlexMono-Light",@"IBMPlexSansSC-Light"];
    for(NSUInteger i=0;i<files.count;i++){char *error=NULL;require(sumi_editor_register_font([fonts stringByAppendingPathComponent:files[i]].UTF8String,[families[i] UTF8String],&error)==0,@"production font registers");}
    require(sumi_editor_register_cascade(json(@{@"alias":@"Sumi Plex",@"families":families}).UTF8String,NULL)==0,@"production cascade registers");
    for(NSValue *sizeValue in @[[NSValue valueWithSize:NSMakeSize(800,500)],[NSValue valueWithSize:NSMakeSize(800,600)],[NSValue valueWithSize:NSMakeSize(960,720)]]){
    NSSize size=sizeValue.sizeValue;
    [window setContentSize:size];view.frame=window.contentView.bounds;
    NSString *wrapped=@"SYNTHETIC · Sumi page 13 acceptance\n这是明确的合成验收页，仅用于验证超过八页后的远端下载与实时订阅。【restart-anchor】x\nSynthetic acceptance fixture — no personal writing.\nUI-ACCEPT first-open 20261108\n\n";
    config[@"appearance"]=@{@"font_family":@"Sumi Plex",@"font_size":@50,@"line_height":@1.6,@"foreground":@"#cccccc",@"background":@"#111111",@"max_columns":@80,@"bottom_inset":@0};
    config[@"bounds"]=@{@"x":@0,@"y":@0,@"width":@(size.width),@"height":@(size.height)};
    config[@"document"]=@{@"text":wrapped,@"runs":@[]};config[@"selection"]=@{@"start":@100,@"length":@0};config[@"viewport"]=@{@"start":@0,@"offset":@0};
    handle=sumi_editor_mount((__bridge void *)view,1,json(config).UTF8String,receive,releaseReply,NULL);require(handle!=NULL,@"large font mount");editor=(__bridge SumiEditor *)handle;
    [window orderFront:nil];settle();
    [editor.text scrollRangeToVisible:NSMakeRange(wrapped.length-1,0)];settle();
    [editor.scroll.contentView scrollToPoint:NSMakePoint(0,(editor.text.frame.size.height-editor.scroll.contentSize.height)*0.3914)];[editor.scroll reflectScrolledClipView:editor.scroll.contentView];settle();
    NSDictionary *saved=[editor viewport];showPosition(editor,@"before hide");
    sumi_editor_command(handle,"{\"command\":\"set_visible\",\"visible\":false}");showPosition(editor,@"after hide");
    require([[editor viewport] isEqual:saved],@"hide preserves captured viewport");
    config[@"viewport"]=saved;config[@"selection"]=SumiRange(editor.text.selectedRange);sumi_editor_detach(handle);
    handle=sumi_editor_mount((__bridge void *)view,1,json(config).UTF8String,receive,releaseReply,NULL);require(handle!=NULL,@"wrapped remount");editor=(__bridge SumiEditor *)handle;
    CGFloat restoredY=editor.scroll.contentView.bounds.origin.y;showPosition(editor,@"immediate remount");
    require(fabs(editor.scroll.contentView.bounds.origin.y-restoredY)<1,@"reading viewport does not reset scroll during initial hit-test");
    sumi_editor_command(handle,"{\"command\":\"focus\"}");showPosition(editor,@"after focus");settle();showPosition(editor,@"after runloop");
    sumi_editor_command(handle,json(@{@"command":@"set_bounds",@"bounds":config[@"bounds"]}).UTF8String);settle();showPosition(editor,@"after delayed bounds");
    NSDictionary *restored=[editor viewport];
    require([restored[@"start"] isEqual:saved[@"start"]] && fabs([restored[@"offset"] doubleValue]-[saved[@"offset"] doubleValue])<1,@"wrapped typewriter reading viewport survives delayed layout");
    require(editor.text.selectedRange.location==[config[@"selection"][@"start"] unsignedIntegerValue],@"viewport restore does not move caret");
    sumi_editor_detach(handle);[window orderOut:nil];
    }
    printf("PASS: actual TextKit 2 viewport and selection survive independent mount/remount\n");
}}
