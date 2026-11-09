// Real TextKit paragraph edits with canonical host projections. Synthetic text only.
#import "editor.m"
#import <objc/runtime.h>
@interface ReturnProbeText : SumiTextView
@end
@implementation ReturnProbeText
- (BOOL)caretSurfaceActive {return self.window.firstResponder==self && !self.isHiddenOrHasHiddenAncestor;}
@end
static NSUInteger checks,projectionReplies,events,bitmapRows;
static SumiEditor *probeEditor;
static BOOL mixedStyles;
static void require(BOOL value,NSString *message){checks++;if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static NSArray *styles(NSString *body){
    if(!mixedStyles)return @[];
    NSMutableArray *runs=[NSMutableArray new];NSUInteger pos=0,paragraph=0;
    while(pos<body.length){
        NSRange range=[body paragraphRangeForRange:NSMakeRange(pos,0)];NSUInteger end=NSMaxRange(range),length=range.length;
        while(length && [NSCharacterSet.newlineCharacterSet characterIsMember:[body characterAtIndex:range.location+length-1]])length--;
        if(length){
            NSMutableDictionary *run=[@{@"range":SumiRange(NSMakeRange(range.location,length))} mutableCopy];
            if(paragraph%4==0)run[@"heading"]=@1;
            else if(paragraph%4==1)run[@"bold"]=@YES;
            else if(paragraph%4==2)run[@"quote"]=@YES;
            else run[@"heading"]=@6;
            [runs addObject:run];
        }
        paragraph++;if(end<=pos)break;pos=end;
    }
    return runs;
}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;NSDictionary *event=SumiJSON(json);events++;
    if([event[@"kind"] isEqual:@"edit"]){
        NSString *next=[probeEditor.committed stringByReplacingCharactersInRange:SumiReadRange(event[@"range"]) withString:event[@"replacement"]];
        require([next isEqualToString:probeEditor.text.string],@"canonical host applies exactly the emitted delta");
        NSDictionary *projection=@{@"document":@{@"text":next,@"runs":styles(next)},@"selection":SumiRange(probeEditor.text.selectedRange)};
        NSData *data=[NSJSONSerialization dataWithJSONObject:projection options:0 error:nil];
        *reply=strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);projectionReplies++;
        return [event[@"base_revision"] longLongValue]+1;
    }
    return [event[@"revision"] longLongValue];
}
static void freeReply(char *reply){free(reply);}
static NSEvent *key(NSWindow *window,NSString *characters,unsigned short code){return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:CACurrentMediaTime() windowNumber:window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:code];}
static void checkRenderedRows(SumiTextView *text){
    if(![text.owner.appearance[@"font_family"] isEqual:@"Sumi Zhaohua"] || [text.owner.appearance[@"font_size"] doubleValue]!=50 || text.focusView.bounds.size.height!=620 || mixedStyles)return;
    NSView *container=text.owner.container;[container layoutSubtreeIfNeeded];
    NSBitmapImageRep *bitmap=[container bitmapImageRepForCachingDisplayInRect:container.bounds];[container cacheDisplayInRect:container.bounds toBitmapImageRep:bitmap];
    CGFloat scale=bitmap.pixelsHigh/container.bounds.size.height;
    for(SumiFocusRow *row in text.focusView.rows){
        if(row==text.focusView.rows.firstObject || row.alpha<.1 || !row.range.length || NSMaxRange(row.range)>text.string.length)continue;
        NSString *content=[[text.string substringWithRange:row.range] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];if(!content.length)continue;
        NSAttributedString *reference=[text.textStorage attributedSubstringFromRange:row.range];CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)reference);CGRect glyphs=CTLineGetBoundsWithOptions(line,kCTLineBoundsUseGlyphPathBounds);CFRelease(line);
        if(glyphs.size.height<2)continue;
        NSInteger top=MAX(0,(NSInteger)floor(row.origin.y*scale)),bottom=MIN(bitmap.pixelsHigh,(NSInteger)ceil((row.origin.y+row.height)*scale));NSInteger first=bottom,last=top;
        for(NSInteger y=top;y<bottom;y+=2)for(NSInteger x=0;x<bitmap.pixelsWide;x+=2){NSColor *color=[[bitmap colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];if(color.greenComponent>.02 || color.redComponent>.02 || color.blueComponent>.02){first=MIN(first,y);last=MAX(last,y);}}
        require(first<=last && (last-first+2)/scale>=glyphs.size.height*.55,@"rendered upper glyphs retain their vertical ink span instead of a clipped horizontal strip");bitmapRows++;
    }
}
static void checkRows(SumiTextView *text){
    SumiFocusView *view=text.focusView;require(view && view.rows.count>1,@"paragraph fixture retains a real focus surface and context");
    SumiFocusRow *active=view.rows.firstObject;
    require(fabs(active.origin.y+active.height/2-NSMidY(view.bounds))<.01 && active.alpha==1,@"active visual line remains centered and fully opaque");
    NSArray *ordered=[view.rows sortedArrayUsingComparator:^NSComparisonResult(SumiFocusRow *a,SumiFocusRow *b){return a.range.location<b.range.location?NSOrderedAscending:a.range.location>b.range.location?NSOrderedDescending:NSOrderedSame;}];
    SumiFocusRow *previous=nil,*nearestAbove=nil;CGFloat previousDistance=CGFLOAT_MAX,previousAlpha=0;
    for(SumiFocusRow *row in ordered){
        require(row.height>0 && isfinite(row.rawOrigin.y) && isfinite(row.alpha),@"native rows have valid laid-out geometry");
        require(fabs((row.origin.y-active.origin.y)-(row.rawOrigin.y-active.rawOrigin.y))<.01 && fabs(row.origin.x-row.rawOrigin.x)<.01,@"all rows retain native line spacing and horizontal placement");
        if(previous){if(!(row.range.location>previous.range.location && row.rawOrigin.y+row.height/2>previous.rawOrigin.y+previous.height/2+.1))fprintf(stderr,"GEOMETRY font=%s size=%g height=%g styles=%d selection=%lu previous=%lu:%lu y=%g h=%g row=%lu:%lu y=%g h=%g active=%lu:%lu\n",[text.owner.appearance[@"font_family"] UTF8String],[text.owner.appearance[@"font_size"] doubleValue],view.bounds.size.height,mixedStyles,(unsigned long)text.selectedRange.location,(unsigned long)previous.range.location,(unsigned long)previous.range.length,previous.rawOrigin.y,previous.height,(unsigned long)row.range.location,(unsigned long)row.range.length,row.rawOrigin.y,row.height,(unsigned long)active.range.location,(unsigned long)active.range.length);require(row.range.location>previous.range.location && row.rawOrigin.y+row.height/2>previous.rawOrigin.y+previous.height/2+.1,@"distinct document rows never overlap or reverse after paragraph reflow");}
        previous=row;
        if(row.range.location<active.range.location){
            CGFloat distance=active.rawOrigin.y+active.height/2-row.rawOrigin.y-row.height/2;
            require(distance<previousDistance && row.alpha>=previousAlpha,@"visible upper context fades monotonically by actual native distance");previousDistance=distance;previousAlpha=row.alpha;nearestAbove=row;
        }
        require(row.alpha>=0 && row.alpha<=1,@"context opacity remains bounded");
    }
    if(nearestAbove && nearestAbove.origin.y>0)require(nearestAbove.alpha>.25,@"adjacent upper line does not become nearly invisible after Return");
    checkRenderedRows(text);
    NSRange actual;NSRect candidate=[text firstRectForCharacterRange:text.selectedRange actualRange:&actual];require(!NSIsEmptyRect(candidate),@"native candidate geometry remains available after canonical restyling");
    NSAttributedString *body=[text.textStorage copy];NSRange selection=text.selectedRange;uint64_t revision=text.owner.revision;NSUInteger oldEvents=events;
    for(int n=0;n<3;n++)[text updateFocusRows];
    require([body isEqualToAttributedString:text.textStorage] && NSEqualRanges(selection,text.selectedRange) && revision==text.owner.revision && oldEvents==events,@"repeat focus layout neither edits data nor emits internal viewport changes");
}
static void capture(NSView *view,NSString *path){[view layoutSubtreeIfNeeded];NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];[[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];}
int main(int argc,const char **argv){@autoreleasepool{if(@available(macOS 13.0,*)){
    [NSApplication sharedApplication];setvbuf(stdout,NULL,_IONBF,0);
    NSString *fontRoot=argc>1?[NSString stringWithUTF8String:argv[1]]:nil;
    NSMutableArray *families=[NSMutableArray arrayWithObject:@"Sumi System"];
    if(fontRoot){
        NSDictionary *manifest=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@"plugins-src/write/resources/sumi/manifest.json"] options:0 error:nil];require(manifest!=nil,@"uses production font manifest");
        for(NSDictionary *asset in manifest[@"assets"]){if(!asset[@"postscript"])continue;char *error=NULL;NSString *path=[fontRoot stringByAppendingPathComponent:asset[@"file"]];require(sumi_editor_register_font(path.UTF8String,[asset[@"postscript"] UTF8String],&error)==0,@"registers exact writing font");free(error);}
        for(NSString *alias in [manifest[@"cascades"] allKeys]){NSString *encoded=[[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:@{@"alias":alias,@"families":manifest[@"cascades"][alias]} options:0 error:nil] encoding:NSUTF8StringEncoding];char *error=NULL;require(sumi_editor_register_cascade(encoded.UTF8String,&error)==0,@"registers production font cascade");free(error);[families addObject:alias];}
    }
    NSString *sentence=@"雨停以后，我把窗推开了一些，街道上的灯光映在湿润的石板上，像一封还没有写完的信。我坐回桌前，听见远处偶尔传来车轮经过的声音。白天那些纷乱的念头终于慢了下来，不再催促我立刻找到答案。";
    NSMutableString *body=[NSMutableString new];for(int n=0;n<8;n++)[body appendFormat:@"%@\n\nshort row %d\n下一行文字 %d\n",sentence,n,n];
    for(NSString *family in families)for(NSNumber *size in @[@22,@50])for(NSNumber *height in @[@620,@1080])for(NSNumber *styled in @[@NO,@YES]){
        mixedStyles=styled.boolValue;
        NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,960,height.doubleValue) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
        NSDictionary *config=@{@"surface_id":@"return",@"generation":@1,@"revision":@0,@"bounds":@{@"x":@0,@"y":@0,@"width":@960,@"height":height},@"appearance":@{@"font_family":family,@"font_size":size,@"line_height":@1.2,@"foreground":@"#0ccc68",@"background":@"#000000",@"max_columns":@80,@"bottom_inset":@0,@"caret_motion":@"steady",@"focus_typing":@YES},@"document":@{@"text":body,@"runs":styles(body)}};
        NSString *json=[[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:config options:0 error:nil] encoding:NSUTF8StringEncoding];
        void *handle=sumi_editor_mount((__bridge void*)window.contentView,0,json.UTF8String,receive,freeReply,NULL);require(handle!=NULL,@"mounts native paragraph fixture");
        probeEditor=(__bridge SumiEditor*)handle;SumiTextView *text=probeEditor.text;object_setClass(text,ReturnProbeText.class);[window makeFirstResponder:text];
        for(NSNumber *middle in @[@NO,@YES]){
            [text stopFocusTyping];NSUInteger location=middle.boolValue?body.length/2:body.length;
            [probeEditor applyProjection:@{@"document":@{@"text":body,@"runs":styles(body)},@"selection":SumiRange(NSMakeRange(location,0))} revision:probeEditor.revision+1];
            for(int n=0;n<4;n++)[text recordFocusInputAt:CACurrentMediaTime()+n*.01];text.focusView.progress=1;text.focusView.strength=1;[text.focusView.timer invalidate];text.focusView.timer=nil;checkRows(text);
            for(int n=0;n<3;n++){
                NSString *before=text.string.copy;NSRange selection=text.selectedRange;uint64_t revision=probeEditor.revision;NSUInteger replies=projectionReplies;
                [text keyDown:key(window,@"\r",36)];
                require([text.string isEqualToString:[before stringByReplacingCharactersInRange:selection withString:@"\n"]] && probeEditor.revision==revision+1 && projectionReplies==replies+1,@"Return commits one exact paragraph split through the canonical host projection");checkRows(text);
            }
            [text setMarkedText:@"pin" selectedRange:NSMakeRange(3,0) replacementRange:NSMakeRange(NSNotFound,0)];checkRows(text);
            [text insertText:@"拼音" replacementRange:NSMakeRange(NSNotFound,0)];require(!text.hasMarkedText && !probeEditor.composing,@"real marked-text commit finishes before Return");
            [text keyDown:key(window,@"\r",36)];checkRows(text);
            if(argc>2 && [family isEqual:@"Sumi Zhaohua"] && size.intValue==50 && height.intValue==620 && !mixedStyles && middle.boolValue)capture(probeEditor.container,[NSString stringWithUTF8String:argv[2]]);
        }
        sumi_editor_detach(handle);[window close];probeEditor=nil;
    }
    printf("PASS: %lu checks; production-projection Return/blank/middle/IME/style/actual-50pt-native geometry; %lu canonical edit replies; %lu bitmap ink-span checks\n",(unsigned long)checks,(unsigned long)projectionReplies,(unsigned long)bitmapRows);
}}return 0;}
