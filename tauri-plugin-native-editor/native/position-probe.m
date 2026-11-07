// Real AppKit/TextKit 2 selection and viewport restore; no synthetic user events.
#import "editor.m"
static void require(BOOL ok,NSString *why){if(!ok){fprintf(stderr,"FAIL: %s\n",why.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **projection){(void)context;(void)json;(void)projection;return 0;}
static void releaseReply(char *reply){free(reply);}
static NSString *json(id value){return [[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] encoding:NSUTF8StringEncoding];}
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
    printf("PASS: actual TextKit 2 viewport and selection survive independent mount/remount\n");
}}
