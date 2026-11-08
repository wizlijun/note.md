// Real AppKit/TextKit 2 padding and raster checks; no visible or active window.
#import "editor.m"
static NSUInteger edits;
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;(void)reply;NSDictionary *event=SumiJSON(json);if([event[@"kind"] isEqual:@"edit"])edits++;
    return [event[@"revision"] longLongValue];
}
static void freeReply(char *reply){free(reply);}
static int command(void *handle,NSDictionary *value){
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return sumi_editor_command(handle,[[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
}
static NSDictionary *check(CGFloat size,CGFloat gutter,CGFloat vertical,NSSize viewport,NSUInteger columns,CGFloat bottom,BOOL raster){
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,viewport.width,viewport.height) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    NSString *body=@"Sumi, a quiet page.\n中文写作，留一点呼吸的空间。\nA clear thought begins with a little space.\n字号改变，文字与四周留白保持协调。\nKeep the words; let the page breathe.";
    NSDictionary *appearance=@{@"font_family":@"Sumi Zhaohua",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#44413c",@"background":@"#f3ead7",@"max_columns":@(columns),@"bottom_inset":@(bottom),@"caret_motion":@"steady"};
    NSDictionary *config=@{@"surface_id":@"padding-probe",@"generation":@1,@"revision":@7,@"bounds":@{@"x":@0,@"y":@0,@"width":@(viewport.width),@"height":@(viewport.height)},@"appearance":appearance,@"document":@{@"text":body,@"runs":@[]},@"selection":@{@"start":@3,@"length":@0}};
    NSData *data=[NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,[[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding] UTF8String],receive,freeReply,NULL);
    require(handle!=NULL,@"mount real native editor");SumiEditor *editor=(__bridge SumiEditor *)handle;
    NSRange selection=editor.text.selectedRange;NSUInteger beforeEdits=edits;
    NSMutableDictionary *changed=[appearance mutableCopy];changed[@"font_size"]=@(size);
    require(command(handle,@{@"command":@"set_appearance",@"appearance":changed})==0,@"font change uses actual native appearance command");
    [editor.text.textLayoutManager ensureLayoutForRange:editor.text.textLayoutManager.textContentManager.documentRange];
    [editor.text.textLayoutManager.textViewportLayoutController layoutViewport];
    NSSize inset=editor.text.textContainerInset;CGFloat width=editor.text.textContainer.containerSize.width;
    CGFloat expectedGutter=MIN(gutter,viewport.width/4),expectedVertical=MIN(vertical,viewport.height/4);
    require(fabs(inset.height-expectedVertical)<0.01,@"top/bottom inset matches scaled padding or short-viewport cap");
    require(inset.width+0.01>=expectedGutter && width>0 && width+2*inset.width<=viewport.width+0.01,@"horizontal padding leaves nonempty centered body inside viewport");
    // AppKit floors fractional textContainerOrigin coordinates to whole points.
    require(fabs(editor.text.textContainerOrigin.x-floor(inset.width))<0.01 && fabs(editor.text.textContainerOrigin.y-floor(inset.height))<0.01,@"TextKit origin applies the real symmetric text insets");
    CGFloat maxWidth=[@"0" sizeWithAttributes:@{NSFontAttributeName:[editor baseFont]}].width*columns;
    require(width<=maxWidth+0.01,@"maxColumns remains a font-measured upper bound");
    if(maxWidth<viewport.width-2*expectedGutter)require(fabs(inset.width-(viewport.width-maxWidth)/2)<0.01,@"short column limit remains horizontally centered");
    else require(fabs(inset.width-expectedGutter)<0.01,@"expanded text keeps the selected font-scaled minimum gutter");
    require(editor.scroll.contentInsets.bottom==bottom && [editor.appearance[@"bottom_inset"] doubleValue]==bottom,@"user bottomInset stays an additional absolute reservation");
    __block NSUInteger lines=0;
    [editor.text.textLayoutManager enumerateTextLayoutFragmentsFromLocation:nil options:NSTextLayoutFragmentEnumerationOptionsEnsuresLayout usingBlock:^BOOL(NSTextLayoutFragment *fragment){
        for(NSTextLineFragment *line in fragment.textLineFragments){
            NSRect rect=NSOffsetRect(line.typographicBounds,fragment.layoutFragmentFrame.origin.x+editor.text.textContainerOrigin.x,fragment.layoutFragmentFrame.origin.y+editor.text.textContainerOrigin.y);
            require(NSMinX(rect)>=inset.width-1 && NSMaxX(rect)<=viewport.width-inset.width+1,@"actual TextKit line bounds stay inside horizontal gutters");
            require(NSMinY(rect)>=inset.height-1,@"actual TextKit line bounds respect top padding");lines++;
        }
        return YES;
    }];
    require(lines>=5,@"actual multiline layout was inspected");
    [editor.text scrollRangeToVisible:selection];[editor.text.textLayoutManager.textViewportLayoutController layoutViewport];
    NSRect caret=[editor.text typewriterCaretRect];
    require(!NSIsEmptyRect(caret) && NSMinX(caret)>=inset.width-1 && NSMaxX(caret)<=viewport.width-inset.width+3,@"actual caret stays within the laid-out text width");
    require(NSIntersectsRect(caret,editor.text.visibleRect),@"normal scrolling keeps the actual insertion caret reachable in a short viewport");
    require(NSEqualRanges(editor.text.selectedRange,selection) && [editor.text.string isEqualToString:body] && editor.revision==7 && edits==beforeEdits,@"padding/font changes preserve selection, body, revision and edit count");
    if(raster){
        [editor.scroll.contentView scrollToPoint:NSZeroPoint];[editor.scroll reflectScrolledClipView:editor.scroll.contentView];
        [editor.text.textLayoutManager.textViewportLayoutController layoutViewport];[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        NSBitmapImageRep *bitmap=[editor.container bitmapImageRepForCachingDisplayInRect:editor.container.bounds];[editor.container cacheDisplayInRect:editor.container.bounds toBitmapImageRep:bitmap];
        NSString *path=[NSString stringWithFormat:@"tasks/sumi-native/padding-%.0f.png",size];
        require([[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:path atomically:YES],@"save native raster without displaying a window");
    }
    NSDictionary *result=@{@"fontSize":@(size),@"viewportWidth":@(viewport.width),@"viewportHeight":@(viewport.height),@"columns":@(columns),@"bottomInset":@(bottom),@"horizontalInset":@(inset.width),@"verticalInset":@(inset.height),@"containerWidth":@(width),@"lineCount":@(lines),@"caret":NSStringFromRect(caret),@"visibleRect":NSStringFromRect(editor.text.visibleRect)};
    require(!window.visible && !window.isKeyWindow,@"probe window never shown or made key");sumi_editor_detach(handle);return result;
}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSString *fonts=[NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:@"src-tauri/resources/sumi"];
    require(sumi_editor_register_font([[fonts stringByAppendingPathComponent:@"ZhaohuaTypeWriter.ttf"] UTF8String],"ZhaohuaTypeWriter-Light",NULL)==0,@"register real Zhaohua typewriter font");
    require(sumi_editor_register_cascade("{\"alias\":\"Sumi Zhaohua\",\"families\":[\"ZhaohuaTypeWriter-Light\"]}",NULL)==0,@"register actual Zhaohua preset");
    // Golden padding values at selected user sizes, independent of the layout formula.
    const CGFloat sizes[][3]={{8,16,20},{22,24,32},{32,34.9090909,46.5454545},{50,54.5454545,72.7272727},{96,104.7272727,139.6363636}};
    const NSSize viewports[]={{960,720},{1800,900},{320,720},{960,180}};
    NSMutableArray *results=[NSMutableArray new];
    for(NSUInteger i=0;i<5;i++)for(NSUInteger v=0;v<4;v++)for(NSUInteger c=0;c<2;c++){
        CGFloat bottom=c?80:0;NSUInteger columns=c?20:80;
        BOOL raster=v==0 && c==0 && (sizes[i][0]==22 || sizes[i][0]==50);
        NSDictionary *r=check(sizes[i][0],sizes[i][1],sizes[i][2],viewports[v],columns,bottom,raster);[results addObject:r];
        printf("PADDING font=%.0f viewport=%.0fx%.0f columns=%lu x=%.3f y=%.3f body=%.3f bottom=%.0f\n",sizes[i][0],viewports[v].width,viewports[v].height,(unsigned long)columns,[r[@"horizontalInset"] doubleValue],[r[@"verticalInset"] doubleValue],[r[@"containerWidth"] doubleValue],bottom);
    }
    NSData *json=[NSJSONSerialization dataWithJSONObject:results options:NSJSONWritingPrettyPrinted error:nil];require([json writeToFile:@"tasks/sumi-native/padding-cases.json" atomically:YES],@"save actual geometry matrix");
    require(!NSApp.isActive && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"probe never activates or changes foreground");
    printf("PASS: 40 real TextKit padding cases, 8/22/32/50/96pt, large/narrow/short viewports, centered columns, unchanged bottom reservation and editor state; native 22/50 rasters, no UI activation\n");
}}
