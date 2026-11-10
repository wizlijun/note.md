#import "candidates-view.h"
static NSUInteger assertions;
static void require(BOOL value,NSString *message){assertions++;if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static NSDictionary *candidate(NSInteger index,NSString *text){return @{@"index":@(index),@"text":text,@"label":[NSString stringWithFormat:@"%ld",(long)(index+1)],@"comment":@""};}
static NSDictionary *snapshot(NSArray *candidates,NSInteger cursor,BOOL previous,BOOL next){return @{@"candidates":candidates,@"cursor":@(cursor),@"hasPrev":@(previous),@"hasNext":@(next)};}
static NSArray *candidateItems(SumiCandidatesView *view){return [view.items filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(SumiCandidateItem *item,NSDictionary *bindings){(void)bindings;return !item.action;}]];}
static SumiCandidateItem *navigation(SumiCandidatesView *view,NSInteger direction){for(SumiCandidateItem *item in view.items)if(item.action==direction)return item;return nil;}
static void geometry(SumiCandidatesView *view,CGFloat width,CGFloat maxHeight){
    require(view.rowCount<=4 && view.contentHeight<=maxHeight,@"four row and available-height limits");
    for(SumiCandidateItem *item in view.items){
        require(item.frame.origin.x>=0 && NSMaxX(item.frame)<=width+.001 && item.frame.origin.y>=0 && NSMaxY(item.frame)<=view.contentHeight+.001,@"every candidate and navigation target fits");
        require(SumiCandidateWidth(item.text)<=item.frame.size.width+.001,@"measured glyphs fit target");
        for(SumiCandidateItem *other in view.items)if(item!=other)require(!NSIntersectsRect(item.frame,other.frame),@"no candidate/navigation overlap");
    }
}
int main(void){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];pid_t front=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSFont *font=[NSFont monospacedSystemFontOfSize:22 weight:NSFontWeightLight];
    NSDictionary *attributes=@{NSFontAttributeName:font,NSForegroundColorAttributeName:NSColor.darkGrayColor};
    SumiCandidatesView *view=[[SumiCandidatesView alloc]initWithFrame:NSMakeRect(0,0,400,160)];view.backgroundColor=[NSColor colorWithSRGBRed:.95 green:.92 blue:.85 alpha:1];
    NSDictionary *one=snapshot(@[candidate(7,@"你好")],7,NO,NO);
    require([view prepareSnapshot:one attributes:attributes lineHeight:35.5 width:400 maxHeight:142],@"single item prepares");
    require(view.contentHeight==35.5 && view.rowCount==1 && view.localPageCount==1,@"single row exact fractional height");
    require(view.items.firstObject.frame.origin.x==0,@"first candidate starts at left edge");
    SumiCandidateItem *first=view.items.firstObject;
    require([first.text attribute:NSUnderlineStyleAttributeName atIndex:first.text.length-1 effectiveRange:NULL]!=nil,@"highlight uses underline");
    require([first.text attribute:NSBackgroundColorAttributeName atIndex:0 effectiveRange:NULL]==nil,@"no text fill highlight");
    __block NSInteger selected=-1;view.selectCandidate=^(NSInteger index){selected=index;};[view activateItem:first];require(selected==7,@"selection uses original candidate index");
    require(!view.acceptsFirstResponder,@"view never takes text focus");geometry(view,400,142);
    SumiCandidateAccessibilityElement *accessible=view.accessibilityChildren.firstObject;selected=-1;
    require([accessible accessibilityPerformPress] && selected==7,@"accessible action selects original candidate");
    require([accessible.accessibilityLabel isEqualToString:@"你好"],@"accessibility exposes full candidate text");

    NSMutableArray *many=[NSMutableArray new];for(NSInteger i=0;i<81;i++)[many addObject:candidate(100+i,i%3==0?@"较长中文候选词":i%3==1?@"writing":@"词")];
    NSDictionary *all=snapshot(many,-1,NO,NO);
    for(NSNumber *width in @[@90,@150,@250,@400,@801.5])for(NSNumber *rows in @[@1,@2,@3,@4]){
        [view clear];CGFloat height=rows.doubleValue*35.5;
        require([view prepareSnapshot:all attributes:attributes lineHeight:35.5 width:width.doubleValue maxHeight:height],@"narrow and partial-height layouts prepare");
        NSMutableSet *seen=[NSMutableSet new];NSUInteger visited=0;
        for(;;){
            geometry(view,width.doubleValue,height);for(SumiCandidateItem *item in candidateItems(view))[seen addObject:@(item.candidateIndex)];visited++;
            if(view.localPage+1==view.localPageCount)break;
            SumiCandidateItem *next=navigation(view,1);require(next!=nil,@"every overflow page has next navigation");[view activateItem:next];
            require(visited<=many.count,@"local pages always advance");
        }
        require(seen.count==many.count,@"all original candidates remain reachable");
        require(view.localPageCount==visited,@"stable page count");
        NSUInteger page=view.localPage;
        require([view prepareSnapshot:all attributes:attributes lineHeight:35.5 width:width.doubleValue maxHeight:height] && view.localPage==page,@"identical reflow preserves manual local page");
    }
    [view clear];require([view prepareSnapshot:snapshot(many,178,NO,NO) attributes:attributes lineHeight:35.5 width:150 maxHeight:142],@"cursor in later local page prepares");
    require([[candidateItems(view) valueForKey:@"candidateIndex"]containsObject:@178],@"keyboard-selected item is visible after snapshot");
    SumiCandidateItem *stale=view.items.firstObject;
    SumiCandidateAccessibilityElement *staleAccessible=view.accessibilityChildren.firstObject;
    [view prepareSnapshot:one attributes:attributes lineHeight:35.5 width:400 maxHeight:142];selected=-1;[view activateItem:stale];require(selected==-1,@"old hit targets cannot select a later snapshot");
    require(![staleAccessible accessibilityPerformPress],@"stale accessibility action cannot select a later snapshot");

    __block NSInteger pageRequests=0;view.pageCandidates=^(BOOL next){pageRequests+=next?1:-1;};
    require([view prepareSnapshot:snapshot(@[candidate(0,@"词")],0,YES,YES) attributes:attributes lineHeight:35.5 width:200 maxHeight:142],@"engine page navigation prepares");
    [view activateItem:navigation(view,1)];require(pageRequests==1,@"last local next delegates to engine");[view activateItem:navigation(view,-1)];require(pageRequests==0,@"first local previous delegates to engine");

    NSString *longWord=[@"👩🏽‍💻é𠀀" stringByPaddingToLength:180 withString:@"👩🏽‍💻é𠀀" startingAtIndex:0];
    NSAttributedString *original=[[NSAttributedString alloc]initWithString:longWord attributes:attributes];
    for(NSNumber *width in @[@25,@70,@150,@220]){
        NSAttributedString *shortened=SumiCandidateTruncate(original,width.doubleValue);require(shortened!=nil,@"long complex glyph sequence can shorten");
        require([shortened.string hasSuffix:@"…"] && SumiCandidateWidth(shortened)<=width.doubleValue,@"truncation stays within width");
        NSString *prefix=[shortened.string substringToIndex:shortened.length-1];require([[longWord substringToIndex:prefix.length]isEqualToString:prefix],@"display keeps original prefix");
        require(!prefix.length || NSMaxRange([longWord rangeOfComposedCharacterSequenceAtIndex:prefix.length-1])==prefix.length,@"never split a composed character sequence");
    }
    NSDictionary *longHint=@{@"index":@777,@"label":@"123456789",@"text":@"文字候选",@"comment":@""};
    require([view prepareSnapshot:snapshot(@[longHint],-1,NO,NO) attributes:attributes lineHeight:35.5 width:50 maxHeight:142],@"long optional label can be omitted in narrow row");
    require(![view.items.firstObject.text.string hasPrefix:@"1"],@"never display a clipped numeric shortcut");
    require(![view prepareSnapshot:all attributes:attributes lineHeight:35.5 width:10 maxHeight:142] && view.contentHeight==0,@"unusable width explicitly returns failure");
    require(![view prepareSnapshot:all attributes:attributes lineHeight:35.5 width:200 maxHeight:20],@"insufficient row height explicitly returns failure");
    require([view prepareSnapshot:snapshot(@[],-1,NO,NO) attributes:attributes lineHeight:35.5 width:200 maxHeight:142] && !view.contentHeight && !view.items.count,@"clear snapshot leaves no candidates or navigation");

    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,400,142) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.contentView=view;[view prepareSnapshot:snapshot([many subarrayWithRange:NSMakeRange(0,12)],103,YES,YES) attributes:attributes lineHeight:35.5 width:400 maxHeight:142];
    [view setFrameSize:NSMakeSize(400,view.contentHeight)];
    NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    require(bitmap!=nil,@"native CoreText candidate view renders offscreen");
    NSString *directory=@"tasks/sumi-macos-ime-candidates";[NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    require([[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]writeToFile:[directory stringByAppendingPathComponent:@"candidates.png"] atomically:YES],@"write real native raster");
    require(!window.visible && !window.isKeyWindow,@"probe never displays or activates a window");
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==front,@"foreground application unchanged");
    printf("PASS: %lu candidate layout assertions\n",(unsigned long)assertions);
}}
