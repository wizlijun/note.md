#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#import "editor.h"

static NSMutableDictionary<NSString *,NSFontDescriptor *> *SumiRegisteredFonts;
static NSMutableDictionary<NSString *,NSString *> *SumiRegisteredFontPaths;
int sumi_editor_register_font(const char *path,const char *expected_family,char **error) {
    NSCAssert(NSThread.isMainThread,@"font registration must run on main thread");
    if(error)*error=NULL;
    NSString *family=expected_family?[NSString stringWithUTF8String:expected_family]:nil;
    NSString *filename=path?[NSString stringWithUTF8String:path]:nil;
    NSString *failure=nil;
    if(!family.length || !filename.isAbsolutePath || ![NSFileManager.defaultManager isReadableFileAtPath:filename])
        failure=@"Bundled writing font is missing or unreadable";
    NSURL *url=filename?[NSURL fileURLWithPath:filename]:nil;
    if(!failure && [SumiRegisteredFontPaths[family] isEqualToString:filename])return 0;
    NSFontDescriptor *selected=nil;
    if(!failure) {
        NSArray *descriptors=CFBridgingRelease(CTFontManagerCreateFontDescriptorsFromURL((__bridge CFURLRef)url));
        for(NSFontDescriptor *descriptor in descriptors) {
            NSFont *font=[NSFont fontWithDescriptor:descriptor size:22];
            // New presets use exact PostScript names to retain Light faces;
            // family keys remain supported for existing saved preferences.
            if([font.fontName isEqualToString:family] || [font.familyName isEqualToString:family]){selected=descriptor;break;}
        }
        if(!selected)failure=@"Bundled writing font does not match the expected family or PostScript name";
    }
    if(!failure) {
        CFErrorRef registrationError=NULL;
        BOOL registered=CTFontManagerRegisterFontsForURL((__bridge CFURLRef)url,kCTFontManagerScopeProcess,&registrationError);
        if(!registered && (!registrationError || !CFEqual(CFErrorGetDomain(registrationError),kCTFontManagerErrorDomain) || CFErrorGetCode(registrationError)!=kCTFontManagerErrorAlreadyRegistered))
            failure=registrationError?[(__bridge NSError *)registrationError localizedDescription]:@"Writing font registration failed";
        if(registrationError)CFRelease(registrationError);
    }
    if(failure){if(error)*error=strdup(failure.UTF8String);return 1;}
    if(!SumiRegisteredFonts){SumiRegisteredFonts=[NSMutableDictionary new];SumiRegisteredFontPaths=[NSMutableDictionary new];}
    // Keep the actual bundled descriptor instead of resolving a colliding system
    // family name to an unrelated installed version of the same typeface.
    SumiRegisteredFonts[family]=selected;SumiRegisteredFontPaths[family]=filename;
    return 0;
}

int sumi_editor_register_cascade(const char *json,char **error) {
    NSCAssert(NSThread.isMainThread,@"font cascade registration must run on main thread");
    if(error)*error=NULL;
    NSData *data=json?[NSData dataWithBytes:json length:strlen(json)]:nil;
    id value=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
    NSDictionary *config=[value isKindOfClass:NSDictionary.class]?value:nil;
    NSString *alias=[config[@"alias"] isKindOfClass:NSString.class]?config[@"alias"]:nil;
    NSArray *families=[config[@"families"] isKindOfClass:NSArray.class]?config[@"families"]:nil;
    NSString *failure=nil;
    if(!alias.length || families.count<1 || families.count>8)failure=@"Invalid bundled font cascade";
    NSMutableArray<NSFontDescriptor *> *descriptors=[NSMutableArray new];
    if(!failure){for(id family in families){
        NSFontDescriptor *descriptor=[family isKindOfClass:NSString.class]?SumiRegisteredFonts[family]:nil;
        if(!descriptor){failure=@"A writing fallback font has not been registered";break;}
        [descriptors addObject:descriptor];
    }}
    if(failure){if(error)*error=strdup(failure.UTF8String);return 1;}
    NSFontDescriptor *primary=descriptors.firstObject;
    NSArray *fallbacks=[descriptors subarrayWithRange:NSMakeRange(1,descriptors.count-1)];
    // A one-face preset keeps the normal system fallback; do not install an
    // empty explicit cascade that could change missing-glyph resolution.
    NSFontDescriptor *cascade=fallbacks.count?[primary fontDescriptorByAddingAttributes:@{NSFontCascadeListAttribute:fallbacks}]:primary;
    NSFont *font=[NSFont fontWithDescriptor:cascade size:22];
    NSFont *expected=[NSFont fontWithDescriptor:primary size:22];
    if(!font || ![font.fontName isEqualToString:expected.fontName]){
        if(error)*error=strdup("Writing font cascade changed its primary face");return 1;
    }
    SumiRegisteredFonts[alias]=cascade;
    return 0;
}

@class SumiEditor;
@interface SumiTextView : NSTextView
@property(nonatomic, weak) SumiEditor *owner;
@end
@interface SumiContainer : NSView
@end
@implementation SumiContainer
- (BOOL)isFlipped { return YES; }
@end

@interface SumiEditor : NSObject <NSTextViewDelegate>
@property(nonatomic, strong) SumiContainer *container;
@property(nonatomic, weak) NSView *coordinateView;
@property(nonatomic, strong) NSScrollView *scroll;
@property(nonatomic, strong) SumiTextView *text;
@property(nonatomic, copy) NSString *surfaceID;
@property(nonatomic) uint64_t generation;
@property(nonatomic) uint64_t revision;
@property(nonatomic) SumiEventCallback callback;
@property(nonatomic) SumiReplyFree freeReply;
@property(nonatomic) void *context;
@property(nonatomic) BOOL applying;
@property(nonatomic) BOOL composing;
@property(nonatomic) BOOL detached;
@property(nonatomic) BOOL reportingViewport;
@property(nonatomic, copy) NSString *committed;
@property(nonatomic, copy) NSString *compositionBase;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *pending;
@property(nonatomic, copy) NSDictionary *appearance;
@property(nonatomic, copy) NSArray *runs;
@property(nonatomic, copy) NSString *styledText;
@property(nonatomic) NSUInteger lastRestyled;
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields;
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields projection:(NSDictionary **)projection;
- (void)transaction:(NSString *)kind fields:(NSDictionary *)fields;
- (void)applyProjection:(NSDictionary *)projection revision:(uint64_t)revision;
- (void)beginComposition;
- (void)finishComposition;
- (void)acceptChanges;
- (void)action:(NSString *)action;
- (void)layoutEditor;
- (void)setBounds:(NSDictionary *)bounds;
- (void)applyStyles;
- (void)refreshRuns:(NSArray *)runs;
- (NSDictionary *)viewport;
- (void)restoreViewport:(NSDictionary *)viewport;
- (void)viewportChanged:(NSNotification *)notification;
@end

static NSDictionary *SumiJSON(const char *json) {
    if (!json) return nil;
    NSData *data=[NSData dataWithBytes:json length:strlen(json)];
    id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
static NSDictionary *SumiRange(NSRange range) { return @{ @"start": @(range.location), @"length": @(range.length) }; }
static NSRange SumiReadRange(NSDictionary *range) { return NSMakeRange([range[@"start"] unsignedIntegerValue],[range[@"length"] unsignedIntegerValue]); }
static NSColor *SumiColor(NSString *hex) {
    unsigned value=0; [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&value];
    return [NSColor colorWithSRGBRed:((value>>16)&255)/255.0 green:((value>>8)&255)/255.0 blue:(value&255)/255.0 alpha:1];
}
// Compute a UTF-16 replacement on composed-character boundaries. Used only for IME
// finalization or multi-edit native transactions; ordinary keystrokes use delegate ranges.
static NSDictionary *SumiDifference(NSString *before, NSString *after) {
    NSUInteger prefix=0, oldEnd=before.length, newEnd=after.length;
    while(prefix<oldEnd && prefix<newEnd && [before characterAtIndex:prefix]==[after characterAtIndex:prefix])prefix++;
    NSUInteger previous;
    do {
        previous=prefix;
        if(prefix<before.length)prefix=MIN(prefix,[before rangeOfComposedCharacterSequenceAtIndex:prefix].location);
        if(prefix<after.length)prefix=MIN(prefix,[after rangeOfComposedCharacterSequenceAtIndex:prefix].location);
    } while(prefix!=previous);
    while(oldEnd>prefix && newEnd>prefix && [before characterAtIndex:oldEnd-1]==[after characterAtIndex:newEnd-1]){oldEnd--;newEnd--;}
    NSUInteger extra;
    do {
        extra=0;
        if(oldEnd<before.length){NSRange r=[before rangeOfComposedCharacterSequenceAtIndex:oldEnd];if(r.location<oldEnd)extra=MAX(extra,NSMaxRange(r)-oldEnd);}
        if(newEnd<after.length){NSRange r=[after rangeOfComposedCharacterSequenceAtIndex:newEnd];if(r.location<newEnd)extra=MAX(extra,NSMaxRange(r)-newEnd);}
        oldEnd+=extra;newEnd+=extra;
    } while(extra);
    return @{ @"range":SumiRange(NSMakeRange(prefix,oldEnd-prefix)), @"replacement":[after substringWithRange:NSMakeRange(prefix,newEnd-prefix)] };
}

@implementation SumiTextView
- (void)setMarkedText:(id)value selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
    [self.owner beginComposition];
    [super setMarkedText:value selectedRange:selected replacementRange:replacement];
}
- (void)unmarkText {
    [super unmarkText];
    [self.owner finishComposition];
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
    [super insertText:value replacementRange:replacement];
    if(!self.hasMarkedText)[self.owner finishComposition];
}
- (void)undo:(id)sender { [self.owner action:@"undo"]; }
- (void)redo:(id)sender { [self.owner action:@"redo"]; }
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    NSEventModifierFlags flags=event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
    if(flags & NSEventModifierFlagCommand){
        NSString *key=event.charactersIgnoringModifiers.lowercaseString;
        if([key isEqualToString:@"f"] && (flags & NSEventModifierFlagControl)){[self.owner action:@"fullscreen"];return YES;}
        if([key isEqualToString:@"z"]){[self.owner action:(flags & NSEventModifierFlagShift)?@"redo":@"undo"];return YES;}
        if([key isEqualToString:@"b"]){[self.owner action:@"bold"];return YES;}
        if([key isEqualToString:@"i"]){[self.owner action:@"italic"];return YES;}
        if([key isEqualToString:@"x"] && (flags & NSEventModifierFlagShift)){[self.owner action:@"strike"];return YES;}
        if([key isEqualToString:@"n"]){[self.owner action:@"new_page"];return YES;}
        if((flags & NSEventModifierFlagOption) && event.keyCode==123){[self.owner action:@"previous_page"];return YES;}
        if((flags & NSEventModifierFlagOption) && event.keyCode==124){[self.owner action:@"next_page"];return YES;}
    }
    if(event.keyCode==53 && !self.owner.composing){[self.owner action:@"menu"];return YES;}
    return [super performKeyEquivalent:event];
}
- (void)paste:(id)sender {
    // Native attributed runs are derived from the canonical Markdown document.
    // Do not let AppKit introduce untracked RTF-only attributes.
    NSString *value=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
    if(self.owner.composing)return;
    NSString *html=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeHTML];
    NSData *rtf=[NSPasteboard.generalPasteboard dataForType:NSPasteboardTypeRTF];
    if(html || rtf){
        [self.owner transaction:@"paste" fields:@{@"base_revision":@(self.owner.revision),@"range":SumiRange(self.selectedRange),@"text":value ?: @"",@"html":html ?: NSNull.null,@"rtf":rtf ? [rtf base64EncodedStringWithOptions:0] : NSNull.null}];
    } else if(value) [self insertText:value replacementRange:self.selectedRange];
    else [self.owner action:@"unsupported_paste"];
}
- (void)sumiBold:(id)sender { [self.owner action:@"bold"]; }
- (void)sumiItalic:(id)sender { [self.owner action:@"italic"]; }
- (void)sumiStrike:(id)sender { [self.owner action:@"strike"]; }
- (void)sumiRecoverPlain:(id)sender { [self.owner action:@"recover_paste_plain"]; }
- (void)sumiRecoverOriginal:(id)sender { [self.owner action:@"recover_paste_original"]; }
- (void)sumiMenu:(id)sender { [self.owner action:@"menu"]; }
- (NSMenu *)menuForEvent:(NSEvent *)event {
    // The system rich-text font menu mutates attributes without a Markdown edit.
    // Expose only operations routed through the canonical owner.
    NSMenu *menu=[NSMenu new];
    NSArray *entries=@[@[@"Undo",@"undo:"],@[@"Redo",@"redo:"],@[@"Cut",@"cut:"],@[@"Copy",@"copy:"],@[@"Paste",@"paste:"],@[@"Original paste as plain text",@"sumiRecoverPlain:"],@[@"Recover original paste",@"sumiRecoverOriginal:"],@[@"Select All",@"selectAll:"],@[@"Bold",@"sumiBold:"],@[@"Italic",@"sumiItalic:"],@[@"Strikethrough",@"sumiStrike:"],@[@"Sumi…",@"sumiMenu:"]];
    for(NSArray *entry in entries){
        NSMenuItem *item=[[NSMenuItem alloc]initWithTitle:entry[0] action:NSSelectorFromString(entry[1]) keyEquivalent:@""];
        item.target=self;[menu addItem:item];
    }
    return menu;
}
- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    if(item.action==@selector(undo:) || item.action==@selector(redo:))return !self.owner.composing;
    return [super validateUserInterfaceItem:item];
}
@end

@implementation SumiEditor
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields {
    return [self emit:kind fields:fields projection:NULL];
}
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields projection:(NSDictionary **)projection {
    if(self.detached || !self.callback)return -1;
    NSMutableDictionary *event=[@{@"kind":kind,@"surface_id":self.surfaceID,@"generation":@(self.generation)} mutableCopy];
    [event addEntriesFromDictionary:fields];
    NSData *data=[NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    char *reply=NULL;
    int64_t revision=self.callback(self.context,json.UTF8String,&reply);
    if(reply){if(projection)*projection=SumiJSON(reply);if(self.freeReply)self.freeReply(reply);}
    return revision;
}
- (NSRect)rectForInsertion:(NSUInteger)index {
    // TextKit 2 segment geometry is not clipped to the visible screen like
    // NSTextInputClient's IME firstRect API; retain partial-line scroll offsets.
    if(@available(macOS 13.0,*)){
    NSTextLayoutManager *layout=self.text.textLayoutManager;
    NSTextContentManager *content=layout.textContentManager;
    id<NSTextLocation> location=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)index];
    if(location){
        NSTextRange *range=[[NSTextRange alloc]initWithLocation:location];
        [layout ensureLayoutForRange:range];
        __block NSRect result=NSZeroRect;__block BOOL found=NO;
        [layout enumerateTextSegmentsInRange:range type:NSTextLayoutManagerSegmentTypeStandard options:NSTextLayoutManagerSegmentOptionsRangeNotRequired usingBlock:^BOOL(NSTextRange *segment,CGRect frame,CGFloat baseline,NSTextContainer *container){
            (void)segment;(void)baseline;(void)container;result=NSOffsetRect(frame,self.text.textContainerOrigin.x,self.text.textContainerOrigin.y);found=YES;return NO;
        }];
        if(found)return result;
    }
    }
    return NSMakeRect(self.text.textContainerOrigin.x,self.text.textContainerOrigin.y,0,0);
}
- (NSDictionary *)viewport {
    NSPoint origin=self.scroll.contentView.bounds.origin;
    NSUInteger index=[self.text characterIndexForInsertionAtPoint:NSMakePoint(self.text.textContainerOrigin.x+1,origin.y+1)];
    index=MIN(index,self.text.string.length);
    NSRect rect=[self rectForInsertion:index];
    double offset=origin.y-NSMinY(rect);
    if(!isfinite(offset) || fabs(offset)>10000)offset=0;
    return @{@"start":@(index),@"offset":@(offset)};
}
- (void)restoreViewport:(NSDictionary *)viewport {
    NSUInteger index=MIN([viewport[@"start"] unsignedIntegerValue],self.text.string.length);
    double offset=[viewport[@"offset"] doubleValue];if(!isfinite(offset)||fabs(offset)>10000)offset=0;
    // Resolve TextKit's initial viewport geometry before moving its clip view.
    // Otherwise the first hit-test/layout can reset the restored origin to zero
    // for short wrapped documents, even though the selection was restored.
    // This lays out the viewport, not the entire document.
    if(@available(macOS 13.0,*)){[self.text.textLayoutManager.textViewportLayoutController layoutViewport];}
    [self.text scrollRangeToVisible:NSMakeRange(index,0)];
    NSRect rect=[self rectForInsertion:index];
    NSPoint origin=self.scroll.contentView.bounds.origin;
    origin.y=MAX(0,NSMinY(rect)+offset);
    [self.scroll.contentView scrollToPoint:origin];[self.scroll reflectScrolledClipView:self.scroll.contentView];
}
- (void)viewportChanged:(NSNotification *)notification {
    (void)notification;
    if(self.applying || self.composing || self.detached || self.reportingViewport)return;
    self.reportingViewport=YES;
    [self emit:@"viewport" fields:@{@"revision":@(self.revision),@"viewport":[self viewport]}];
    self.reportingViewport=NO;
}
- (void)beginComposition {
    if(self.composing || self.applying)return;
    self.composing=YES; self.compositionBase=self.committed;
    [self emit:@"composition" fields:@{@"revision":@(self.revision),@"active":@YES}];
}
- (void)finishComposition {
    if(!self.composing || self.text.hasMarkedText)return;
    // Emit the single committed replacement before releasing remote updates.
    [self acceptChanges];self.composing=NO;self.compositionBase=nil;
    [self emit:@"composition" fields:@{@"revision":@(self.revision),@"active":@NO}];
    [self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
}
- (void)acceptChanges {
    NSString *after=[self.text.string copy];
    if([self.committed isEqualToString:after]){[self.pending removeAllObjects];return;}
    NSDictionary *delta;
    if(!self.composing && self.pending.count==1){
        NSDictionary *candidate=self.pending.firstObject;
        NSRange r=SumiReadRange(candidate[@"range"]);
        if(NSMaxRange(r)<=self.committed.length && [[self.committed stringByReplacingCharactersInRange:r withString:candidate[@"replacement"]] isEqualToString:after])delta=candidate;
    }
    if(!delta)delta=SumiDifference(self.committed,after);
    NSMutableDictionary *fields=[delta mutableCopy];fields[@"base_revision"]=@(self.revision);
    NSDictionary *projection=nil;
    int64_t accepted=[self emit:@"edit" fields:fields projection:&projection];
    if(accepted>=0 && (uint64_t)accepted>self.revision){
        if(projection)[self applyProjection:projection revision:(uint64_t)accepted];
        else {self.revision=(uint64_t)accepted;self.committed=after;}
    }
    else{
        self.applying=YES;
        self.text.string=self.committed;
        NSUInteger position=MIN([delta[@"range"][@"start"] unsignedIntegerValue],self.committed.length);
        self.text.selectedRange=NSMakeRange(position,0);
        [self applyStyles];self.applying=NO;
    }
    [self.pending removeAllObjects];
    if(!self.composing)[self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
}
- (BOOL)textView:(NSTextView *)view shouldChangeTextInRange:(NSRange)range replacementString:(NSString *)replacement {
    if(self.applying)return YES;
    if(!replacement)return NO; // Formatting must be a canonical document transaction.
    [self.pending addObject:@{@"range":SumiRange(range),@"replacement":replacement}];
    return YES;
}
- (void)textDidChange:(NSNotification *)notification {
    if(self.applying || self.composing || self.text.hasMarkedText)return;
    [self acceptChanges];
}
- (void)textViewDidChangeSelection:(NSNotification *)notification {
    if(self.applying || self.composing || self.pending.count>0)return;
    [self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
}
- (void)action:(NSString *)action {
    if(self.composing || self.detached)return;
    [self transaction:@"action" fields:@{@"revision":@(self.revision),@"action":action,@"range":SumiRange(self.text.selectedRange)}];
}
- (void)transaction:(NSString *)kind fields:(NSDictionary *)fields {
    NSDictionary *projection=nil;
    int64_t accepted=[self emit:kind fields:fields projection:&projection];
    if(accepted>=0 && (uint64_t)accepted>=self.revision && projection)
        [self applyProjection:projection revision:(uint64_t)accepted];
}
- (void)applyProjection:(NSDictionary *)projection revision:(uint64_t)revision {
    BOOL applying=self.applying;self.applying=YES;
    NSString *next=projection[@"document"][@"text"] ?: @"";
    NSDictionary *delta=SumiDifference(self.text.string,next);
    if([delta[@"range"][@"length"] unsignedIntegerValue] || [delta[@"replacement"] length])
        [self.text.textStorage replaceCharactersInRange:SumiReadRange(delta[@"range"]) withString:delta[@"replacement"]];
    self.revision=revision;self.committed=[next copy];
    [self refreshRuns:projection[@"document"][@"runs"] ?: @[]];
    NSRange selection=SumiReadRange(projection[@"selection"]);
    if(NSMaxRange(selection)<=self.text.string.length)self.text.selectedRange=selection;
    self.applying=applying;
}
- (NSFont *)baseFont {
    CGFloat size=[self.appearance[@"font_size"] doubleValue];
    NSString *family=self.appearance[@"font_family"];
    NSFontDescriptor *descriptor=SumiRegisteredFonts[family];
    if(descriptor)return [NSFont fontWithDescriptor:descriptor size:size];
    return [NSFont fontWithName:family size:size] ?: [NSFont systemFontOfSize:size];
}
- (void)setBounds:(NSDictionary *)bounds {
    NSView *reference=self.coordinateView,*parent=self.container.superview;
    CGFloat x=[bounds[@"x"] doubleValue],y=[bounds[@"y"] doubleValue],w=[bounds[@"width"] doubleValue],h=[bounds[@"height"] doubleValue];
    NSRect rect=NSMakeRect(x,reference.isFlipped?y:reference.bounds.size.height-y-h,w,h);
    self.container.frame=[parent convertRect:rect fromView:reference];
    [self layoutEditor];
}
- (void)layoutEditor {
    CGFloat w=self.container.bounds.size.width;
    NSFont *font=[self baseFont];
    CGFloat cell=[@"0" sizeWithAttributes:@{NSFontAttributeName:font}].width;
    CGFloat content=MIN(MAX(0,w-48),cell*[self.appearance[@"max_columns"] doubleValue]);
    CGFloat margin=MAX(24,(w-content)/2);
    self.scroll.frame=self.container.bounds;
    self.text.frame=NSMakeRect(0,0,w,MAX(self.scroll.contentSize.height,self.text.frame.size.height));
    self.text.textContainerInset=NSMakeSize(margin,32);
    self.text.textContainer.containerSize=NSMakeSize(MAX(0,w-2*margin),CGFLOAT_MAX);
    self.scroll.contentInsets=NSEdgeInsetsMake(0,0,[self.appearance[@"bottom_inset"] doubleValue],0);
}
- (NSDictionary *)baseAttributes {
    NSMutableParagraphStyle *paragraph=[NSMutableParagraphStyle new];
    paragraph.lineHeightMultiple=[self.appearance[@"line_height"] doubleValue];
    return @{NSFontAttributeName:[self baseFont],NSForegroundColorAttributeName:SumiColor(self.appearance[@"foreground"]),NSParagraphStyleAttributeName:paragraph};
}
- (void)styleRanges:(NSIndexSet *)dirty {
    self.lastRestyled=dirty.count;
    if(dirty.count==0)return;
    NSDictionary *base=[self baseAttributes];NSFont *font=base[NSFontAttributeName];
    NSTextStorage *storage=self.text.textStorage;
    [storage beginEditing];
    [dirty enumerateRangesUsingBlock:^(NSRange changed,BOOL *stop){
        (void)stop;
        [storage setAttributes:base range:changed];
        for(NSDictionary *run in self.runs){
            NSRange range=NSIntersectionRange(SumiReadRange(run[@"range"]),changed);if(range.length==0)continue;
            NSFont *runFont=font;NSUInteger heading=[run[@"heading"] unsignedIntegerValue];
            if(heading)runFont=[NSFont fontWithDescriptor:font.fontDescriptor size:font.pointSize*(1.0+(7-MIN(6,heading))*0.10)] ?: font;
            if([run[@"bold"] boolValue] || heading){
                NSFont *bold=[NSFontManager.sharedFontManager convertFont:runFont toHaveTrait:NSBoldFontMask];
                if([bold.familyName isEqualToString:font.familyName] && ([NSFontManager.sharedFontManager traitsOfFont:bold]&NSBoldFontMask))runFont=bold;
                else [storage addAttribute:NSStrokeWidthAttributeName value:@(-2.0) range:range];
            }
            if([run[@"italic"] boolValue]){
                NSFont *italic=[NSFontManager.sharedFontManager convertFont:runFont toHaveTrait:NSItalicFontMask];
                if([italic.familyName isEqualToString:font.familyName] && ([NSFontManager.sharedFontManager traitsOfFont:italic]&NSItalicFontMask))runFont=italic;
                else [storage addAttribute:NSObliquenessAttributeName value:@0.2 range:range];
            }
            [storage addAttribute:NSFontAttributeName value:runFont range:range];
            if([run[@"strike"] boolValue])[storage addAttribute:NSStrikethroughStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
            if([run[@"link"] isKindOfClass:NSString.class])[storage addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
            if([run[@"quote"] boolValue]){
                NSMutableParagraphStyle *quote=[base[NSParagraphStyleAttributeName] mutableCopy];quote.headIndent=font.pointSize;quote.firstLineHeadIndent=font.pointSize;
                [storage addAttribute:NSParagraphStyleAttributeName value:quote range:range];
            }
        }
    }];
    [storage endEditing];
}
- (void)refreshRuns:(NSArray *)runs {
    NSString *next=self.text.string;
    if([self.styledText isEqualToString:next] && [self.runs isEqualToArray:runs]){self.lastRestyled=0;return;}
    NSDictionary *delta=SumiDifference(self.styledText ?: @"",next);
    NSRange replaced=SumiReadRange(delta[@"range"]);NSUInteger inserted=[delta[@"replacement"] length];
    NSMutableArray *mapped=[NSMutableArray new];
    for(NSDictionary *old in self.runs){
        NSRange range=SumiReadRange(old[@"range"]);NSUInteger start=range.location,end=NSMaxRange(range);
        if(start>NSMaxRange(replaced))start=start-replaced.length+inserted;else if(start>=replaced.location)start=replaced.location;
        if(end>=NSMaxRange(replaced))end=end-replaced.length+inserted;else if(end>replaced.location)end=replaced.location+inserted;
        NSMutableDictionary *updated=[old mutableCopy];updated[@"range"]=SumiRange(NSMakeRange(MIN(start,next.length),MIN(end,next.length)-MIN(start,next.length)));[mapped addObject:updated];
    }
    NSMutableIndexSet *dirty=[NSMutableIndexSet new];
    if(next.length && (replaced.length || inserted)){
        NSUInteger start=MIN(replaced.location,next.length-1),end=MIN(next.length,replaced.location+MAX((NSUInteger)1,inserted));
        [dirty addIndexesInRange:[next rangeOfComposedCharacterSequencesForRange:NSMakeRange(start,MAX((NSUInteger)1,end-start))]];
    }
    NSUInteger count=MAX(mapped.count,runs.count);
    for(NSUInteger i=0;i<count;i++){
        NSDictionary *old=i<mapped.count?mapped[i]:nil,*new=i<runs.count?runs[i]:nil;
        if([old isEqualToDictionary:new])continue;
        if(old)[dirty addIndexesInRange:NSIntersectionRange(SumiReadRange(old[@"range"]),NSMakeRange(0,next.length))];
        if(new)[dirty addIndexesInRange:NSIntersectionRange(SumiReadRange(new[@"range"]),NSMakeRange(0,next.length))];
    }
    self.runs=runs;[self styleRanges:dirty];self.styledText=[next copy];
}
- (void)applyStyles {
    NSDictionary *base=[self baseAttributes];NSColor *foreground=base[NSForegroundColorAttributeName];
    [self styleRanges:[NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0,self.text.string.length)]];
    self.styledText=[self.text.string copy];self.text.typingAttributes=base;
    self.text.backgroundColor=SumiColor(self.appearance[@"background"]);
    self.text.insertionPointColor=foreground;self.scroll.backgroundColor=self.text.backgroundColor;
    self.container.wantsLayer=YES;self.container.layer.backgroundColor=self.text.backgroundColor.CGColor;
    self.text.selectedTextAttributes=@{NSBackgroundColorAttributeName:[foreground colorWithAlphaComponent:0.22],NSForegroundColorAttributeName:foreground};
}
@end

int sumi_editor_supported(void){if(@available(macOS 13.0,*))return 1;return 0;}
void *sumi_editor_mount(void *reference_view,int webview_sibling,const char *json,SumiEventCallback callback,SumiReplyFree free_reply,void *context){
    if(!NSThread.isMainThread || !reference_view || !sumi_editor_supported())return NULL;
    NSView *reference=(__bridge NSView *)reference_view;
    NSView *parent=webview_sibling?reference.superview:reference;
    if(!parent)return NULL;
    NSDictionary *config=SumiJSON(json);if(!config)return NULL;
    SumiEditor *editor=[SumiEditor new];
    editor.surfaceID=config[@"surface_id"];editor.generation=[config[@"generation"] unsignedLongLongValue];editor.revision=[config[@"revision"] unsignedLongLongValue];
    editor.callback=callback;editor.freeReply=free_reply;editor.context=context;editor.pending=[NSMutableArray new];editor.appearance=config[@"appearance"];editor.runs=config[@"document"][@"runs"] ?: @[];
    editor.container=[[SumiContainer alloc] initWithFrame:NSZeroRect];editor.container.wantsLayer=YES;editor.container.layer.masksToBounds=YES;
    editor.coordinateView=reference;
    editor.scroll=[[NSScrollView alloc] initWithFrame:NSZeroRect];editor.scroll.hasVerticalScroller=YES;editor.scroll.autohidesScrollers=YES;editor.scroll.borderType=NSNoBorder;editor.scroll.drawsBackground=YES;
    if(@available(macOS 13.0,*)){
        editor.text=[[SumiTextView alloc] initUsingTextLayoutManager:YES];
        if(!editor.text.textLayoutManager)return NULL;
    } else return NULL;
    editor.text.accessibilityIdentifier=@"sumi-native-editor";editor.text.accessibilityLabel=@"Sumi writing editor";
    editor.text.owner=editor;editor.text.delegate=editor;editor.text.richText=YES;editor.text.importsGraphics=NO;editor.text.allowsUndo=NO;
    editor.text.verticallyResizable=YES;editor.text.horizontallyResizable=NO;editor.text.minSize=NSZeroSize;editor.text.maxSize=NSMakeSize(CGFLOAT_MAX,CGFLOAT_MAX);
    editor.text.textContainer.widthTracksTextView=NO;editor.text.textContainer.lineFragmentPadding=0;
    editor.text.automaticQuoteSubstitutionEnabled=NO;editor.text.automaticDashSubstitutionEnabled=NO;editor.text.automaticTextReplacementEnabled=NO;editor.text.automaticLinkDetectionEnabled=NO;
    editor.applying=YES;editor.text.string=config[@"document"][@"text"] ?: @"";editor.committed=[editor.text.string copy];
    editor.scroll.documentView=editor.text;[editor.container addSubview:editor.scroll];
    [parent addSubview:editor.container positioned:NSWindowAbove relativeTo:webview_sibling?reference:nil];
    [editor applyStyles];[editor setBounds:config[@"bounds"]];
    NSRange selection=SumiReadRange(config[@"selection"] ?: @{});
    if(NSMaxRange(selection)<=editor.text.string.length)editor.text.selectedRange=selection;
    if(config[@"viewport"])[editor restoreViewport:config[@"viewport"]];
    editor.scroll.contentView.postsBoundsChangedNotifications=YES;
    [NSNotificationCenter.defaultCenter addObserver:editor selector:@selector(viewportChanged:) name:NSViewBoundsDidChangeNotification object:editor.scroll.contentView];
    editor.applying=NO;
    return (__bridge_retained void *)editor;
}
int sumi_editor_command(void *handle,const char *json){
    if(!NSThread.isMainThread || !handle)return 4;
    SumiEditor *editor=(__bridge SumiEditor *)handle;if(editor.detached)return 4;
    NSDictionary *value=SumiJSON(json);NSString *command=value[@"command"];if(!command)return 3;
    if([command isEqualToString:@"apply_document"]){
        if(editor.composing || editor.text.hasMarkedText)return 1;
        if([value[@"base_revision"] unsignedLongLongValue]!=editor.revision)return 2;
        [editor applyProjection:value revision:[value[@"revision"] unsignedLongLongValue]];return 0;
    }
    if([command isEqualToString:@"set_bounds"]){
        BOOL applying=editor.applying;editor.applying=YES;
        [editor setBounds:value[@"bounds"]];editor.applying=applying;return 0;
    }
    if([command isEqualToString:@"set_appearance"]){
        if(editor.composing)return 1;
        editor.applying=YES;editor.appearance=value[@"appearance"];[editor applyStyles];[editor layoutEditor];editor.applying=NO;return 0;
    }
    if([command isEqualToString:@"focus"]){BOOL applying=editor.applying;editor.applying=YES;[editor.text.window makeFirstResponder:editor.text];editor.applying=applying;return 0;}
    if([command isEqualToString:@"set_visible"]){
        if(editor.composing)return 1;
        BOOL visible=[value[@"visible"] boolValue];editor.container.hidden=!visible;
        if(!visible && editor.text.window.firstResponder==editor.text)[editor.text.window makeFirstResponder:nil];return 0;
    }
    return 3;
}
char *sumi_editor_inspect(void *handle){
    if(!NSThread.isMainThread || !handle)return NULL;
    SumiEditor *editor=(__bridge SumiEditor *)handle;
    BOOL textkit2=NO; if(@available(macOS 12.0,*))textkit2=editor.text.textLayoutManager!=nil;
    BOOL applying=editor.applying;editor.applying=YES;NSDictionary *viewport=[editor viewport];editor.applying=applying;
    NSDictionary *state=@{@"surface_id":editor.surfaceID,@"generation":@(editor.generation),@"revision":@(editor.revision),@"text":editor.text.string,@"selection":SumiRange(editor.text.selectedRange),@"composing":editor.composing?@YES:@NO,@"textkit2":textkit2?@YES:@NO,@"visible":editor.container.hidden?@NO:@YES,@"viewport":viewport};
    NSData *data=[NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];return strdup(json.UTF8String);
}
void sumi_editor_free_string(char *value){free(value);}
void sumi_editor_detach(void *handle){
    if(!handle || !NSThread.isMainThread)return;
    SumiEditor *editor=(__bridge_transfer SumiEditor *)handle;
    editor.detached=YES;editor.callback=NULL;editor.text.delegate=nil;editor.text.owner=nil;
    [NSNotificationCenter.defaultCenter removeObserver:editor];
    if(editor.text.window.firstResponder==editor.text)[editor.text.window makeFirstResponder:nil];
    [editor.container removeFromSuperview];
}
