#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#import <QuartzCore/QuartzCore.h>
#import "editor.h"
#import "shortcuts.h"
#import "candidates-bridge.h"
#import "candidates-view.h"

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

// App UI language is independent from the keyboard/input source and document text.
static NSString *SumiLocale(id value) {
    if(![value isKindOfClass:NSString.class])return @"en";
    NSString *language=[[[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString] componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"-_"]].firstObject;
    return [language isEqualToString:@"zh"] || [language isEqualToString:@"ja"] ? language : @"en";
}
static NSString *SumiLabel(NSString *locale,NSString *english) {
    NSString *language=SumiLocale(locale);
    if([language isEqualToString:@"en"]){
        if([english isEqualToString:@"Sumi…"])return @"Sumi Typewriter…";
        if([english isEqualToString:@"Sumi writing editor"])return @"Sumi Typewriter writing editor";
        return english;
    }
    static NSDictionary<NSString *,NSArray<NSString *> *> *labels;static dispatch_once_t once;
    dispatch_once(&once, ^{labels=@{
        @"Undo":@[@"撤销",@"取り消す"], @"Redo":@[@"重做",@"やり直す"],
        @"Cut":@[@"剪切",@"カット"], @"Copy":@[@"复制",@"コピー"], @"Paste":@[@"粘贴",@"ペースト"],
        @"Original paste as plain text":@[@"恢复原始粘贴为纯文本",@"元の貼り付けを標準テキストで復元"],
        @"Recover original paste":@[@"恢复原始粘贴",@"元の貼り付けを復元"],
        @"Select All":@[@"全选",@"すべてを選択"], @"Bold":@[@"粗体",@"太字"],
        @"Italic":@[@"斜体",@"斜体"], @"Strikethrough":@[@"删除线",@"取り消し線"],
        @"Sumi…":@[@"玄霜打字机…",@"すみ…"], @"Paragraph":@[@"正文",@"本文"],
        @"Heading 1":@[@"一级标题",@"見出し1"], @"Heading 2":@[@"二级标题",@"見出し2"],
        @"Heading 3":@[@"三级标题",@"見出し3"], @"Heading 4":@[@"四级标题",@"見出し4"],
        @"Heading 5":@[@"五级标题",@"見出し5"], @"Heading 6":@[@"六级标题",@"見出し6"],
        @"Quote":@[@"引用",@"引用"], @"Bullet List":@[@"无序列表",@"箇条書き"],
        @"Ordered List":@[@"有序列表",@"番号付きリスト"], @"Indent":@[@"增加缩进",@"インデントを増やす"],
        @"Outdent":@[@"减少缩进",@"インデントを減らす"], @"Link…":@[@"链接…",@"リンク…"],
        @"Find…":@[@"查找…",@"検索…"], @"Find Next":@[@"查找下一个",@"次を検索"],
        @"Find Previous":@[@"查找上一个",@"前を検索"], @"Replace…":@[@"替换…",@"置換…"],
        @"Link":@[@"链接",@"リンク"], @"Apply":@[@"应用",@"適用"], @"Cancel":@[@"取消",@"キャンセル"],
        @"Link URL":@[@"链接地址",@"リンク先URL"],
        @"Sumi writing editor":@[@"玄霜打字机写作编辑器",@"すみの執筆エディタ"]
    };});
    NSArray *translated=labels[english];return translated ? translated[[language isEqualToString:@"zh"]?0:1] : english;
}
static NSAlert *SumiLinkAlert(NSString *locale) {
    NSAlert *alert=[NSAlert new];alert.messageText=SumiLabel(locale,@"Link");
    [alert addButtonWithTitle:SumiLabel(locale,@"Apply")];[alert addButtonWithTitle:SumiLabel(locale,@"Cancel")];
    NSTextField *url=[[NSTextField alloc]initWithFrame:NSMakeRect(0,0,360,24)];url.placeholderString=@"https://";
    url.accessibilityLabel=SumiLabel(locale,@"Link URL");alert.accessoryView=url;return alert;
}

@class SumiEditor, SumiFocusView, SumiFocusRow;
@interface SumiCaretView : NSView
@property(nonatomic, strong) NSColor *color;
@end
@implementation SumiCaretView
- (NSView *)hitTest:(NSPoint)point { (void)point;return nil; }
- (BOOL)isAccessibilityElement { return NO; }
- (void)drawRect:(NSRect)dirty { (void)dirty;[self.color setFill];NSRectFill(self.bounds); }
@end
@interface SumiTextView : NSTextView
@property(nonatomic, weak) SumiEditor *owner;
@property(nonatomic, strong) SumiCaretView *typewriterCaret;
@property(nonatomic) CFTimeInterval caretBreathingEpoch;
@property(nonatomic) BOOL refreshingCaret;
@property(nonatomic) NSUInteger caretInputDepth;
@property(nonatomic) NSUInteger compositionMutationDepth;
@property(nonatomic) BOOL caretRefreshQueued;
@property(nonatomic,strong) SumiFocusView *focusView;
@property(nonatomic) BOOL focusUpdating, focusInputChanged, focusTracking;
@property(nonatomic) BOOL focusResumeOnInput;
@property(nonatomic) NSUInteger focusInputCount, focusKeyDepth;
@property(nonatomic) CFTimeInterval focusLastInput, focusFirstInput, focusLastEvent;
@property(nonatomic,strong) SumiCandidatesBridge *candidateBridge;
@property(nonatomic,strong) SumiCandidatesView *candidateView;
@property(nonatomic,copy) NSDictionary *candidateSnapshot, *candidateNormalSelection;
@property(nonatomic,copy) NSArray *candidateLayoutKey;
@property(nonatomic) BOOL candidatePresented, candidateUpdating;
@property(nonatomic) CGFloat candidateGap;
- (NSRect)typewriterCaretRect;
- (BOOL)usesTypewriterCaret;
- (BOOL)typewriterCaretEligible;
- (BOOL)caretSurfaceActive;
- (void)refreshTypewriterCaret:(BOOL)restart;
- (void)updateCaretMotion;
- (void)syncSystemCaretColor;
- (void)queueCaretRefresh;
- (BOOL)sumiCommand:(NSString *)command;
- (BOOL)prepareForPanel;
- (void)finishFocusInputMutation:(BOOL)imeActivity;
- (void)prepareFocusResumeAfterReading;
@end
@interface SumiTextView (Candidates)
- (void)ensureCandidateBridge;
- (NSString *)candidateGeneration;
- (BOOL)updateCandidateLayout;
- (CGFloat)candidateOffsetForRow:(SumiFocusRow *)row;
@end
@interface SumiTextView (FocusTyping)
- (BOOL)focusEnabled;
- (void)ensureEmptyFocus;
- (void)stopFocusTyping;
- (void)recordFocusInputAt:(CFTimeInterval)time;
- (void)animateFocusStrength:(CGFloat)strength duration:(NSTimeInterval)duration;
- (void)scheduleFocusIdle;
- (void)updateFocusRows;
- (NSRect)focusRect:(NSRect)rect;
- (NSPoint)focusOriginalPoint:(NSPoint)point;
- (NSUInteger)focusCharacterIndexAtPoint:(NSPoint)point;
- (void)recordFocusEvent:(NSEvent *)event;
- (void)focusMutationFinished;
- (void)focusScrollNotification:(NSNotification *)notification;
@end
@interface SumiContainer : NSView
@end
@implementation SumiContainer
- (BOOL)isFlipped { return YES; }
@end

@interface SumiScrollView : NSScrollView
@property(nonatomic,weak) SumiTextView *focusText;
@end
@implementation SumiScrollView
- (void)scrollWheel:(NSEvent *)event { [self.focusText stopFocusTyping];[super scrollWheel:event];[self.focusText prepareFocusResumeAfterReading]; }
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
@property(nonatomic) BOOL focusDocumentReady;
@property(nonatomic) BOOL composing;
@property(nonatomic) BOOL detached;
@property(nonatomic) BOOL reportingViewport;
@property(nonatomic, copy) NSString *committed;
@property(nonatomic, copy) NSString *draftError;
@property(nonatomic, copy) NSString *compositionBase;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *pending;
@property(nonatomic, copy) NSDictionary *appearance;
@property(nonatomic, copy) NSString *locale;
@property(nonatomic, copy) NSArray *runs;
@property(nonatomic, copy) NSString *styledText;
@property(nonatomic) NSUInteger lastRestyled;
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields;
- (int64_t)emit:(NSString *)kind fields:(NSDictionary *)fields projection:(NSDictionary **)projection;
- (void)transaction:(NSString *)kind fields:(NSDictionary *)fields;
- (void)applyProjection:(NSDictionary *)projection revision:(uint64_t)revision;
- (void)retainDraft:(NSDictionary *)projection error:(NSString *)error;
- (void)beginComposition;
- (void)finishComposition;
- (void)acceptChanges;
- (BOOL)acceptChangesPreservingRejectedText:(BOOL)preserve;
- (void)action:(NSString *)action;
- (void)layoutEditor;
- (void)setBounds:(NSDictionary *)bounds;
- (void)applyStyles;
- (void)refreshRuns:(NSArray *)runs;
- (NSDictionary *)viewport;
- (void)restoreViewport:(NSDictionary *)viewport;
- (void)viewportChanged:(NSNotification *)notification;
- (NSFont *)baseFont;
- (NSDictionary *)baseAttributes;
- (NSRect)rectForInsertion:(NSUInteger)index;
@end

#import "typing-monitor.h"

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

#import "focus.h"
#import "candidates-host.h"

@implementation SumiTextView
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText {
    [self ensureCandidateBridge];
    NSArray *attributes=[super validAttributesForMarkedText] ?: @[];
    return self.candidateBridge.marker?[attributes arrayByAddingObject:self.candidateBridge.marker]:attributes;
}
- (BOOL)usesTypewriterCaret { return self.owner && !self.owner.detached; }
- (BOOL)shouldDrawInsertionPoint { return [self usesTypewriterCaret]?NO:[super shouldDrawInsertionPoint]; }
- (void)drawInsertionPointInRect:(NSRect)rect color:(NSColor *)color turnedOn:(BOOL)flag {
    if(![self usesTypewriterCaret])[super drawInsertionPointInRect:rect color:color turnedOn:flag];
}
- (BOOL)caretSurfaceActive {
    return [self usesTypewriterCaret] && self.isEditable && !self.isHiddenOrHasHiddenAncestor
        && self.window.isKeyWindow && NSApp.isActive && self.window.firstResponder==self;
}
- (BOOL)typewriterCaretEligible {
    BOOL preserving=(self.caretInputDepth || self.owner.applying) && self.typewriterCaret && !self.typewriterCaret.hidden;
    return [self caretSurfaceActive] && (preserving || self.hasMarkedText
        || (self.selectedRanges.count==1 && self.selectedRange.length==0));
}
- (void)syncSystemCaretColor {
    if(!self.owner)return;
    // Modern TextKit can retain its NSTextInsertionIndicator after IME even
    // when shouldDrawInsertionPoint becomes NO. Keep it transparent during
    // marked text too; IME geometry and selection still belong to NSTextView.
    if([super insertionPointColor].alphaComponent!=0)[super setInsertionPointColor:NSColor.clearColor];
}
- (NSRect)typewriterCaretRect {
    NSUInteger index=MIN(self.selectedRange.location,self.string.length);
    NSFont *font=[self.owner baseFont];
    // The overall font metrics exclude paragraph line spacing and nearby
    // heading sizes. A subtly heavier vertical stroke replaces the OS caret.
    CGFloat width=MAX(2,MIN(3,font.pointSize/11.0)),height=font.ascender-font.descender;
    __block NSRect caret=NSZeroRect;__block BOOL found=NO;
    if(@available(macOS 13.0,*)){
        NSTextLayoutManager *layout=self.textLayoutManager;NSTextContentManager *content=layout.textContentManager;
        id<NSTextLocation> location=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)index];
        if(location){
            NSTextRange *range=[[NSTextRange alloc]initWithLocation:location];[layout ensureLayoutForRange:range];
            [layout enumerateTextSegmentsInRange:range type:NSTextLayoutManagerSegmentTypeStandard options:NSTextLayoutManagerSegmentOptionsRangeNotRequired usingBlock:^BOOL(NSTextRange *segment,CGRect frame,CGFloat baseline,NSTextContainer *container){
                (void)segment;(void)container;
                caret=NSMakeRect(frame.origin.x+self.textContainerOrigin.x,frame.origin.y+baseline+self.textContainerOrigin.y-font.ascender,width,height);found=YES;return NO;
            }];
        }
    }
    if(!found)return NSZeroRect;
    CGFloat scale=self.window.backingScaleFactor ?: 1;
    caret.origin.x=round(caret.origin.x*scale)/scale;caret.origin.y=round(caret.origin.y*scale)/scale;
    caret.size.width=ceil(caret.size.width*scale)/scale;caret.size.height=ceil(caret.size.height*scale)/scale;
    return caret;
}
- (void)updateCaretMotion {
    CALayer *layer=self.typewriterCaret.layer;
    [CATransaction begin];[CATransaction setDisableActions:YES];layer.opacity=1;[CATransaction commit];
    // The explicit Sumi preference is authoritative; do not silently replace
    // breathing with steady when macOS Reduce Motion is enabled.
    if([self.owner.appearance[@"caret_motion"] isEqualToString:@"steady"]){
        [layer removeAnimationForKey:@"sumi-caret-breathing"];self.caretBreathingEpoch=0;return;
    }
    if([layer animationForKey:@"sumi-caret-breathing"])return;
    if(self.caretBreathingEpoch==0)self.caretBreathingEpoch=CACurrentMediaTime();
    CABasicAnimation *breathing=[CABasicAnimation animationWithKeyPath:@"opacity"];
    breathing.fromValue=@1;breathing.toValue=@0.25;breathing.duration=2;breathing.autoreverses=YES;breathing.repeatCount=HUGE_VALF;
    breathing.timingFunction=[CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    breathing.beginTime=[layer convertTime:self.caretBreathingEpoch fromLayer:nil];
    if(@available(macOS 12.0,*))breathing.preferredFrameRateRange=CAFrameRateRangeMake(15,30,30);
    [layer addAnimation:breathing forKey:@"sumi-caret-breathing"];
}
- (void)refreshTypewriterCaret:(BOOL)restart {
    (void)restart; // Input/selection updates never restart the breathing phase.
    if(self.refreshingCaret)return;self.refreshingCaret=YES;
    [self updateCandidateLayout];
    [self syncSystemCaretColor];
    if(![self typewriterCaretEligible]){
        self.typewriterCaret.hidden=YES;[self.typewriterCaret.layer removeAnimationForKey:@"sumi-caret-breathing"];
    }else{
        // Native input and host projections transiently replace the selection
        // and invalidate layout. Keep the last valid caret until they finish.
        if((self.caretInputDepth || self.owner.applying) && self.typewriterCaret && !self.typewriterCaret.hidden){
            self.refreshingCaret=NO;return;
        }
        NSRect frame=[self typewriterCaretRect];
        if(self.focusView)frame=[self focusRect:frame];
        if(NSIsEmptyRect(frame)){
            [self queueCaretRefresh];self.refreshingCaret=NO;return;
        }
        if(!self.typewriterCaret){self.typewriterCaret=[[SumiCaretView alloc]initWithFrame:NSZeroRect];self.typewriterCaret.wantsLayer=YES;[self addSubview:self.typewriterCaret];}
        [CATransaction begin];[CATransaction setDisableActions:YES];
        NSView *caretParent=self.focusView ?: self;
        if(self.typewriterCaret.superview!=caretParent){[self.typewriterCaret removeFromSuperview];[caretParent addSubview:self.typewriterCaret];}
        self.typewriterCaret.frame=frame;self.typewriterCaret.color=SumiColor(self.owner.appearance[@"foreground"]);
        [CATransaction commit];
        self.typewriterCaret.needsDisplay=YES;
        NSRect overlayCaret=[self.owner.container convertRect:frame fromView:caretParent];
        BOOL covered=self.candidatePresented && !self.candidateView.hidden && NSIntersectsRect(overlayCaret,self.candidateView.frame);
        if(covered || !NSIntersectsRect(self.typewriterCaret.frame,self.focusView?self.focusView.bounds:self.visibleRect)){
            self.typewriterCaret.hidden=YES;[self.typewriterCaret.layer removeAnimationForKey:@"sumi-caret-breathing"];
        }else{self.typewriterCaret.hidden=NO;[self updateCaretMotion];}
    }
    self.refreshingCaret=NO;
}
- (void)queueCaretRefresh {
    if(self.caretRefreshQueued)return;self.caretRefreshQueued=YES;
    __weak SumiTextView *weakSelf=self;
    dispatch_async(dispatch_get_main_queue(), ^{
        SumiTextView *view=weakSelf;if(!view)return;
        [view updateFocusRows];[view refreshTypewriterCaret:NO];view.caretRefreshQueued=NO;
    });
}
- (void)layout {
    [super layout];
    // AppKit is still committing fragment rendering state during layout.
    // Resolve focus/caret geometry after that transaction, not reentrantly.
    [self queueCaretRefresh];
}
- (void)updateInsertionPointStateAndRestartTimer:(BOOL)restart {
    [self syncSystemCaretColor];
    [super updateInsertionPointStateAndRestartTimer:restart];[self refreshTypewriterCaret:restart];
}
- (BOOL)becomeFirstResponder { BOOL accepted=[super becomeFirstResponder];if(accepted){[self ensureEmptyFocus];[self updateFocusRows];}[self refreshTypewriterCaret:YES];return accepted; }
- (BOOL)resignFirstResponder {
    BOOL accepted=[super resignFirstResponder];
    if(accepted){[self.candidateBridge releaseLease];[self stopFocusTyping];if(SumiTypingOwner==self.owner)SumiTypingClear();self.typewriterCaret.hidden=YES;[self.typewriterCaret.layer removeAnimationForKey:@"sumi-caret-breathing"];}
    return accepted;
}
- (void)caretWindowChanged:(NSNotification *)notification { (void)notification;[self.candidateBridge checkLease];if(!self.window.isKeyWindow || !NSApp.isActive)[self stopFocusTyping];SumiTypingRefresh();[self refreshTypewriterCaret:YES]; }
- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    NSArray *names=@[NSWindowDidBecomeKeyNotification,NSWindowDidResignKeyNotification,NSApplicationDidBecomeActiveNotification,NSApplicationDidResignActiveNotification];
    for(NSString *name in names){
        [NSNotificationCenter.defaultCenter removeObserver:self name:name object:nil];
        if(self.window)[NSNotificationCenter.defaultCenter addObserver:self selector:@selector(caretWindowChanged:) name:name object:nil];
    }
    [self refreshTypewriterCaret:YES];
}
- (void)viewDidHide { [self.candidateBridge releaseLease];[self stopFocusTyping];[super viewDidHide];[self refreshTypewriterCaret:NO]; }
- (void)viewDidUnhide { [super viewDidUnhide];[self refreshTypewriterCaret:YES]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)prepareFocusResumeAfterReading {
    if([self focusEnabled] && self.isEditable && self.owner && !self.owner.applying && !self.owner.draftError
        && !self.owner.detached && !self.owner.container.hidden && !self.isHiddenOrHasHiddenAncestor)self.focusResumeOnInput=YES;
}
- (void)finishFocusInputMutation:(BOOL)imeActivity {
    if(!self.caretInputDepth && !self.focusKeyDepth && !self.owner.applying){
        // An input method may deliver preedit/commit after the key event has
        // returned. Its actual text callback is activity; unmark/panel cleanup
        // is not. Nested keyDown owns its one activity record at the outer end.
        if(imeActivity)[self recordFocusInputAt:CACurrentMediaTime()];
        else{
            NSEvent *event=NSApp.currentEvent;
            if(event && fabs(NSProcessInfo.processInfo.systemUptime-event.timestamp)<.5)[self recordFocusEvent:event];
        }
    }
    [self focusMutationFinished];
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
    if(self.owner.draftError)return;
    BOOL imeActivity=([value isKindOfClass:NSString.class] || [value isKindOfClass:NSAttributedString.class]) && [value length]>0;
    self.focusInputChanged=YES;
    self.caretInputDepth++;
    self.compositionMutationDepth++;
    [self.owner beginComposition];
    [self syncSystemCaretColor];
    // Body composition styling does not wait for the asynchronous candidate
    // lease: the first preedit may arrive before hello/ready completes.
    NSString *string=[value isKindOfClass:NSAttributedString.class]?[value string]:value;
    if([string isKindOfClass:NSString.class]){
        NSMutableDictionary *attributes=[[self.owner baseAttributes] mutableCopy];attributes[NSUnderlineStyleAttributeName]=@(NSUnderlineStyleSingle);
        value=[[NSAttributedString alloc]initWithString:string attributes:attributes];
    }
    if(!self.candidateNormalSelection)self.candidateNormalSelection=[self.selectedTextAttributes copy];
    self.selectedTextAttributes=@{NSBackgroundColorAttributeName:NSColor.clearColor,NSUnderlineStyleAttributeName:@(NSUnderlineStyleSingle)};
    [super setMarkedText:value selectedRange:selected replacementRange:replacement];
    self.compositionMutationDepth--;
    if(!self.compositionMutationDepth && !self.hasMarkedText)[self.owner finishComposition];
    if(!self.hasMarkedText && self.candidateNormalSelection){self.selectedTextAttributes=self.candidateNormalSelection;self.candidateNormalSelection=nil;}
    self.caretInputDepth--;if(imeActivity)[self finishFocusInputMutation:YES];else [self focusMutationFinished];[self updateInsertionPointStateAndRestartTimer:YES];[self queueCaretRefresh];
}
- (void)unmarkText {
    self.caretInputDepth++;self.compositionMutationDepth++;
    [super unmarkText];
    if(self.candidateNormalSelection){self.selectedTextAttributes=self.candidateNormalSelection;self.candidateNormalSelection=nil;}
    self.compositionMutationDepth--;
    if(!self.compositionMutationDepth)[self.owner finishComposition];
    self.caretInputDepth--;[self focusMutationFinished];[self updateInsertionPointStateAndRestartTimer:YES];[self queueCaretRefresh];
}
// Only an explicit panel request commits preedit. Background visibility and
// remote updates must keep their composition barrier.
- (BOOL)prepareForPanel {
    if(self.owner.draftError)return NO;
    [self stopFocusTyping];
    if(!self.owner.composing && !self.hasMarkedText)return YES;
    NSRange marked=self.markedRange,selection=self.selectedRange;
    NSAttributedString *preedit=self.hasMarkedText?[self.textStorage attributedSubstringFromRange:marked]:nil;
    self.caretInputDepth++;
    // AppKit may invoke insertText/unmarkText recursively while clearing marks.
    // Keep that entire change inside the frozen composition until acceptance.
    self.compositionMutationDepth++;
    [super unmarkText];
    self.compositionMutationDepth--;
    BOOL accepted=[self.owner acceptChangesPreservingRejectedText:YES];
    if(!accepted){
        if(self.owner.draftError){[self.owner finishComposition];}
        else if(preedit){
            NSUInteger start=MIN(MAX(selection.location,marked.location),NSMaxRange(marked));
            NSRange clause=NSMakeRange(start-marked.location,MIN(selection.length,NSMaxRange(marked)-start));
            self.compositionMutationDepth++;
            [super setMarkedText:preedit selectedRange:clause replacementRange:marked];
            self.compositionMutationDepth--;
        }
    }else{
        [self.owner finishComposition];
        [self.inputContext discardMarkedText];
    }
    self.caretInputDepth--;[self focusMutationFinished];[self updateInsertionPointStateAndRestartTimer:YES];[self queueCaretRefresh];
    return accepted && !self.hasMarkedText && !self.owner.composing;
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
    if(self.owner.draftError)return;
    BOOL imeActivity=(self.hasMarkedText || self.owner.composing)
        && ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSAttributedString.class]) && [value length]>0;
    self.focusInputChanged=YES;
    self.caretInputDepth++;self.compositionMutationDepth++;
    [super insertText:value replacementRange:replacement];
    if(!self.hasMarkedText && self.candidateNormalSelection){self.selectedTextAttributes=self.candidateNormalSelection;self.candidateNormalSelection=nil;}
    self.compositionMutationDepth--;
    if(!self.compositionMutationDepth && !self.hasMarkedText)[self.owner finishComposition];
    self.caretInputDepth--;[self finishFocusInputMutation:imeActivity];[self updateInsertionPointStateAndRestartTimer:YES];[self queueCaretRefresh];
}
- (void)keyDown:(NSEvent *)event {
    BOOL controlNavigation=(event.modifierFlags&NSEventModifierFlagControl)
        && !(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagOption))
        && [@[@"a",@"b",@"e",@"f",@"n",@"p"] containsObject:event.charactersIgnoringModifiers.lowercaseString];
    BOOL navigation=controlNavigation || event.keyCode==123 || event.keyCode==124 || event.keyCode==125 || event.keyCode==126 || event.keyCode==115 || event.keyCode==119 || event.keyCode==116 || event.keyCode==121 || event.keyCode==53;
    BOOL focusLineNavigation=self.focusView && !self.hasMarkedText && !self.owner.composing && !self.selectedRange.length
        && (event.keyCode==125 || event.keyCode==126)
        && !(event.modifierFlags&(NSEventModifierFlagShift|NSEventModifierFlagCommand|NSEventModifierFlagControl|NSEventModifierFlagOption));
    BOOL typing=!navigation && !(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl)) && (!event.isARepeat || self.focusView!=nil);
    BOOL resumeOnInput=typing && self.focusResumeOnInput;
    BOOL readingNavigation=navigation && event.keyCode!=53 && !self.hasMarkedText && !self.owner.composing;
    if((navigation && !self.hasMarkedText && !focusLineNavigation) || (event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl)) || (!self.hasMarkedText && self.selectedRange.length))[self stopFocusTyping];
    if(resumeOnInput)self.focusResumeOnInput=YES;
    if(focusLineNavigation){
        // AppKit owns visual-line movement and its preferred column. Recenter
        // the same presentation without restarting typing or its idle clock.
        self.focusView.progress=1;self.focusView.fromProgress=1;
    }
    self.focusInputChanged=NO;self.focusKeyDepth++;self.caretInputDepth++;[super keyDown:event];self.caretInputDepth--;self.focusKeyDepth--;
    if(readingNavigation && !self.focusView)[self prepareFocusResumeAfterReading];
    BOOL editIntent=event.keyCode==51 || event.keyCode==117 || event.keyCode==36 || event.keyCode==76;
    if(typing && (self.focusInputChanged || (self.focusResumeOnInput && editIntent)))[self recordFocusEvent:event];
    [self updateFocusRows];[self refreshTypewriterCaret:NO];[self queueCaretRefresh];
}
- (void)scrollWheel:(NSEvent *)event { [self stopFocusTyping];[super scrollWheel:event];[self prepareFocusResumeAfterReading]; }
- (void)mouseDown:(NSEvent *)event {
    if(!self.focusView){self.focusInputCount=0;[super mouseDown:event];[self prepareFocusResumeAfterReading];return;}
    if(self.hasMarkedText || self.owner.composing){
        SumiFocusView *view=self.focusView;
        // Use the existing safe commit barrier. A rejected composition retains
        // its preedit/draft and must never hand selection to another line.
        if(![self prepareForPanel])return;
        if(self.owner.draftError || self.owner.detached || self.owner.container.hidden)return;
        self.focusView=view;view.rows=nil;
        [self.owner.container addSubview:view positioned:NSWindowAbove relativeTo:self.owner.scroll];
        [self updateFocusRows];if(!self.focusView)return;
    }
    NSPoint displayed=[self.focusView convertPoint:event.locationInWindow fromView:nil];
    NSUInteger index=[self focusCharacterIndexAtPoint:displayed];
    NSRange previous=self.selectedRange;
    NSSelectionGranularity granularity=event.clickCount>=3?NSSelectByParagraph:(event.clickCount==2?NSSelectByWord:NSSelectByCharacter);
    NSRange hit=[self selectionRangeForProposedRange:NSMakeRange(index,0) granularity:granularity];
    BOOL extending=(event.modifierFlags&NSEventModifierFlagShift)!=0;
    NSUInteger anchor=extending?(index<previous.location?NSMaxRange(previous):previous.location):hit.location;
    // Keep both the paper and its hit coordinates fixed for the entire gesture.
    // Exiting on mouseDown would interpret the next dragged event in a different
    // layout and can select whole paragraphs instead of the visible few letters.
    self.focusTracking=YES;[self.focusView.timer invalidate];self.focusView.timer=nil;[self.focusView.idleTimer invalidate];self.focusView.idleTimer=nil;
    NSRange selection=extending?NSMakeRange(MIN(anchor,index),MAX(anchor,index)-MIN(anchor,index)):hit;
    [self setSelectedRange:selection affinity:NSSelectionAffinityDownstream stillSelecting:YES];
    self.focusView.needsDisplay=YES;
    while(self.focusView && !self.owner.detached && !self.isHiddenOrHasHiddenAncestor){
        NSEvent *next=[NSApp nextEventMatchingMask:NSEventMaskLeftMouseDragged|NSEventMaskLeftMouseUp untilDate:[NSDate dateWithTimeIntervalSinceNow:.05] inMode:NSEventTrackingRunLoopMode dequeue:YES];
        if(!next)continue;
        if(next.type==NSEventTypeLeftMouseUp || !self.focusView)break;
        if(hypot(next.locationInWindow.x-event.locationInWindow.x,next.locationInWindow.y-event.locationInWindow.y)<3)continue;
        NSPoint point=[self.focusView convertPoint:next.locationInWindow fromView:nil];
        NSUInteger cursor=[self focusCharacterIndexAtPoint:point];
        NSRange target=[self selectionRangeForProposedRange:NSMakeRange(cursor,0) granularity:granularity];
        NSUInteger start=MIN(anchor,target.location),end=MAX(extending?anchor:NSMaxRange(hit),NSMaxRange(target));
        [self setSelectedRange:NSMakeRange(start,end-start) affinity:NSSelectionAffinityDownstream stillSelecting:YES];
        [self.focusView setNeedsDisplay:YES];[self.focusView displayIfNeeded];
    }
    self.focusTracking=NO;[self stopFocusTyping];
    [self setSelectedRange:self.selectedRange affinity:NSSelectionAffinityDownstream stillSelecting:NO];
    [self scrollRangeToVisible:self.selectedRange];
    [self prepareFocusResumeAfterReading];
}
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    NSRect result=[super firstRectForCharacterRange:range actualRange:actual];
    if(self.focusView && range.location<=self.string.length){
        NSRect raw=[self.owner rectForInsertion:range.location];
        raw.size.width=MAX(1,raw.size.width);NSRect projected=[self focusRect:raw];
        return [self.window convertRectToScreen:[self.focusView convertRect:projected toView:nil]];
    }
    return result;
}
- (void)undo:(id)sender { [self stopFocusTyping];[self.owner action:@"undo"]; }
- (void)redo:(id)sender { [self stopFocusTyping];[self.owner action:@"redo"]; }
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    NSString *command=SumiShortcut(event.charactersIgnoringModifiers,event.keyCode,event.modifierFlags);
    if(self.window.firstResponder!=self){
        NSResponder *responder=self.window.firstResponder;
        BOOL findCommand=[@[@"find",@"find_next",@"find_previous",@"replace"] containsObject:command ?: @""];
        if(!findCommand || !self.owner.scroll.findBarVisible || ![responder isKindOfClass:NSView.class]
           || ![(NSView *)responder isDescendantOf:self.owner.scroll.findBarView])return NO;
        if([responder isKindOfClass:NSTextView.class] && [(NSTextView *)responder hasMarkedText])return NO;
        return [self sumiCommand:command];
    }
    // Never consume IME cancellation / marked-text editing as a paper action.
    if(self.hasMarkedText || self.owner.composing)return [super performKeyEquivalent:event];
    if([command isEqualToString:@"fullscreen"] && event.isARepeat)return YES;
    if(command)return [self sumiCommand:command];
    return [super performKeyEquivalent:event];
}
- (BOOL)sumiCommand:(NSString *)command {
    [self stopFocusTyping];
    if(!self.owner || self.owner.detached || self.owner.container.hidden)return NO;
    if(self.hasMarkedText || self.owner.composing)return YES;
    if(self.owner.draftError && ![@[@"select_all",@"copy",@"save",@"find",@"find_next",@"find_previous",@"escape"] containsObject:command])return YES;
    if([command isEqualToString:@"select_all"]){[self selectAll:nil];return YES;}
    if([command isEqualToString:@"copy"]){[self copy:nil];return YES;}
    if([command isEqualToString:@"cut"]){[self cut:nil];return YES;}
    if([command isEqualToString:@"paste"]){[self paste:nil];return YES;}
    if([command isEqualToString:@"paste_plain"]){[self pasteAsPlainText:nil];return YES;}
    NSDictionary *find=@{@"find":@(NSTextFinderActionShowFindInterface),@"find_next":@(NSTextFinderActionNextMatch),
      @"find_previous":@(NSTextFinderActionPreviousMatch),@"replace":@(NSTextFinderActionShowReplaceInterface)};
    if(find[command]){
        NSMenuItem *sender=[NSMenuItem new];sender.tag=[find[command] integerValue];
        [self performTextFinderAction:sender];return YES;
    }
    if([command isEqualToString:@"escape"]){
        if(self.owner.scroll.findBarVisible){self.owner.scroll.findBarVisible=NO;return YES;}
        [self.owner action:@"menu"];return YES;
    }
    if([command isEqualToString:@"link"]){
        if(!self.window)return YES;
        NSDictionary *projection=nil;
        int64_t revision=[self.owner emit:@"action" fields:@{@"revision":@(self.owner.revision),@"action":@"link_begin",@"range":SumiRange(self.selectedRange)} projection:&projection];
        if(revision<0)return YES;
        if(projection)[self.owner applyProjection:projection revision:(uint64_t)revision];
        NSAlert *alert=SumiLinkAlert(self.owner.locale);
        NSTextField *url=(NSTextField *)alert.accessoryView;
        for(NSDictionary *run in self.owner.runs){NSRange range=SumiReadRange(run[@"range"]);if(range.location<=self.selectedRange.location && NSMaxRange(range)>self.selectedRange.location && [run[@"link"] isKindOfClass:NSString.class]){url.stringValue=run[@"link"];break;}}
        alert.accessoryView=url;
        __weak SumiTextView *weakSelf=self;
        [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response){
            SumiTextView *view=weakSelf;if(!view || view.owner.detached)return;
            [view.owner action:response==NSAlertFirstButtonReturn?[@"link_set:" stringByAppendingString:url.stringValue]:@"link_cancel"];
            [view.window makeFirstResponder:view];
        }];
        [alert.window makeFirstResponder:url];return YES;
    }
    [self.owner action:command];return YES;
}
- (void)insertTab:(id)sender { (void)sender;[self sumiCommand:@"indent"]; }
- (void)insertBacktab:(id)sender { (void)sender;[self sumiCommand:@"outdent"]; }
- (void)insertLineBreak:(id)sender { (void)sender;[self sumiCommand:@"hard_break"]; }
- (void)cancelOperation:(id)sender {
    if(self.hasMarkedText || self.owner.composing){[super cancelOperation:sender];return;}
    [self sumiCommand:@"escape"];
}
- (void)toggleBoldface:(id)sender { (void)sender;[self sumiCommand:@"bold"]; }
- (void)toggleItalics:(id)sender { (void)sender;[self sumiCommand:@"italic"]; }
// Display typography belongs to Sumi preferences. Unsupported rich attributes
// must not mutate NSTextStorage behind the Markdown/source-map transaction.
- (void)underline:(id)sender { (void)sender;NSBeep(); }
- (void)changeFont:(id)sender { (void)sender;NSBeep(); }
- (void)changeAttributes:(id)sender { (void)sender;NSBeep(); }
- (void)changeColor:(id)sender { (void)sender;NSBeep(); }
- (void)pasteFont:(id)sender { (void)sender;NSBeep(); }
- (void)pasteRuler:(id)sender { (void)sender;NSBeep(); }
- (void)alignLeft:(id)sender { (void)sender;NSBeep(); }
- (void)alignCenter:(id)sender { (void)sender;NSBeep(); }
- (void)alignRight:(id)sender { (void)sender;NSBeep(); }
- (void)alignJustified:(id)sender { (void)sender;NSBeep(); }
- (void)subscript:(id)sender { (void)sender;NSBeep(); }
- (void)superscript:(id)sender { (void)sender;NSBeep(); }
- (BOOL)writeMarkdownToPasteboard:(NSPasteboard *)pasteboard cut:(BOOL)cut {
    if(self.owner.composing || self.hasMarkedText || self.owner.detached || (cut && self.owner.draftError))return NO;
    NSMutableArray *ranges=[NSMutableArray new];
    for(NSValue *value in self.selectedRanges)if(value.rangeValue.length)[ranges addObject:SumiRange(value.rangeValue)];
    if(ranges.count==0)return NO;
    uint64_t revision=self.owner.revision;
    NSDictionary *fields=@{@"revision":@(revision),@"ranges":ranges,@"cut":@NO};
    NSDictionary *reply=nil;
    if([self.owner emit:@"clipboard" fields:fields projection:&reply]<0)return NO;
    NSString *markdown=reply[@"clipboard_text"];if(![markdown isKindOfClass:NSString.class])return NO;
    [pasteboard clearContents];
    if(![pasteboard setString:markdown forType:NSPasteboardTypeString])return NO;
    if(cut)[self.owner transaction:@"clipboard" fields:@{@"revision":@(revision),@"ranges":ranges,@"cut":@YES}];
    return YES;
}
- (void)copy:(id)sender { (void)sender;[self writeMarkdownToPasteboard:NSPasteboard.generalPasteboard cut:NO]; }
- (void)cut:(id)sender { (void)sender;[self writeMarkdownToPasteboard:NSPasteboard.generalPasteboard cut:YES]; }
- (void)pasteFromPasteboard:(NSPasteboard *)pasteboard literal:(BOOL)literal {
    if(self.owner.composing || self.hasMarkedText || self.owner.detached || self.owner.draftError)return;
    [self stopFocusTyping];
    // Prefer public plain text, including Markdown emitted by our own copy.
    // Only input formats are decoded; no attributed string enters the editor.
    NSString *text=[pasteboard stringForType:NSPasteboardTypeString];
    NSString *html=nil;NSData *rtf=nil;
    if(!text)html=[pasteboard stringForType:NSPasteboardTypeHTML];
    if(!text && !html){
        rtf=[pasteboard dataForType:NSPasteboardTypeRTF];
        if(rtf.length<=2*1024*1024 && rtf){
            @try {
                NSAttributedString *value=[[NSAttributedString alloc]initWithRTF:rtf documentAttributes:NULL];
                text=[value.string stringByReplacingOccurrencesOfString:@"\uFFFC" withString:@"[附件]"];
            } @catch(NSException *exception) { (void)exception; }
        }
    }
    if(!text && !html && !rtf){
        NSMutableArray *files=[NSMutableArray new];
        for(NSPasteboardItem *item in pasteboard.pasteboardItems){
            NSString *url=[item stringForType:NSPasteboardTypeFileURL];
            if(url)[files addObject:[@"[文件: " stringByAppendingFormat:@"%@]",url]];
        }
        if(files.count)text=[files componentsJoinedByString:@"\n"];
        else if([pasteboard availableTypeFromArray:@[NSPasteboardTypePNG,NSPasteboardTypeTIFF]])text=@"[图片]";
        else text=[pasteboard stringForType:NSPasteboardTypeURL];
    }
    if(text || html || rtf){
        [self.owner transaction:@"paste" fields:@{@"base_revision":@(self.owner.revision),@"range":SumiRange(self.selectedRange),@"text":text ?: NSNull.null,@"html":html ?: NSNull.null,@"rtf":rtf ? [rtf base64EncodedStringWithOptions:0] : NSNull.null,@"literal":@(literal)}];
    }else [self.owner action:@"unsupported_paste"];
}
- (void)pasteFromPasteboard:(NSPasteboard *)pasteboard { [self pasteFromPasteboard:pasteboard literal:NO]; }
- (void)paste:(id)sender { (void)sender;[self pasteFromPasteboard:NSPasteboard.generalPasteboard]; }
- (void)pastePlainFromPasteboard:(NSPasteboard *)pasteboard { [self pasteFromPasteboard:pasteboard literal:YES]; }
- (void)pasteAsPlainText:(id)sender { (void)sender;[self pastePlainFromPasteboard:NSPasteboard.generalPasteboard]; }
- (void)pasteAsRichText:(id)sender { [self paste:sender]; }
- (void)sumiBold:(id)sender { [self.owner action:@"bold"]; }
- (void)sumiItalic:(id)sender { [self.owner action:@"italic"]; }
- (void)sumiStrike:(id)sender { [self.owner action:@"strike"]; }
- (void)sumiRecoverPlain:(id)sender { [self.owner action:@"recover_paste_plain"]; }
- (void)sumiRecoverOriginal:(id)sender { [self.owner action:@"recover_paste_original"]; }
- (void)sumiMenu:(id)sender { [self.owner action:@"menu"]; }
- (void)sumiMenuCommand:(NSMenuItem *)sender { [self sumiCommand:sender.representedObject]; }
- (NSMenu *)menuForEvent:(NSEvent *)event {
    // The system rich-text font menu mutates attributes without a Markdown edit.
    // Expose only operations routed through the canonical owner.
    NSMenu *menu=[NSMenu new];
    NSArray *entries=@[@[@"Undo",@"undo:"],@[@"Redo",@"redo:"],@[@"Cut",@"cut:"],@[@"Copy",@"copy:"],@[@"Paste",@"paste:"],@[@"Original paste as plain text",@"sumiRecoverPlain:"],@[@"Recover original paste",@"sumiRecoverOriginal:"],@[@"Select All",@"selectAll:"],@[@"Bold",@"sumiBold:"],@[@"Italic",@"sumiItalic:"],@[@"Strikethrough",@"sumiStrike:"],@[@"Sumi…",@"sumiMenu:"]];
    for(NSArray *entry in entries){
        NSMenuItem *item=[[NSMenuItem alloc]initWithTitle:SumiLabel(self.owner.locale,entry[0]) action:NSSelectorFromString(entry[1]) keyEquivalent:@""];
        item.target=self;[menu addItem:item];
    }
    [menu addItem:NSMenuItem.separatorItem];
    for(NSArray *entry in @[@[@"Paragraph",@"paragraph"],@[@"Heading 1",@"heading1"],@[@"Heading 2",@"heading2"],@[@"Heading 3",@"heading3"],@[@"Heading 4",@"heading4"],@[@"Heading 5",@"heading5"],@[@"Heading 6",@"heading6"],@[@"Quote",@"quote"],@[@"Bullet List",@"bullet_list"],@[@"Ordered List",@"ordered_list"],@[@"Indent",@"indent"],@[@"Outdent",@"outdent"],@[@"Link…",@"link"],@[@"Find…",@"find"],@[@"Find Next",@"find_next"],@[@"Find Previous",@"find_previous"],@[@"Replace…",@"replace"]]){
        NSMenuItem *item=[[NSMenuItem alloc]initWithTitle:SumiLabel(self.owner.locale,entry[0]) action:@selector(sumiMenuCommand:) keyEquivalent:@""];
        item.target=self;item.representedObject=entry[1];[menu addItem:item];
    }
    return menu;
}
- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    if(item.action==@selector(undo:) || item.action==@selector(redo:) || item.action==@selector(sumiMenuCommand:))return !self.owner.composing;
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
    if(reply){
        NSDictionary *value=SumiJSON(reply);
        if(revision==-2){
            NSDictionary *draft=[value[@"projection"] isKindOfClass:NSDictionary.class]?value[@"projection"]:nil;
            [self retainDraft:draft error:[value[@"draft_error"] isKindOfClass:NSString.class]?value[@"draft_error"]:@"本机保存失败，草稿尚未安全保存"];
        }else if(projection)*projection=value;
        if(self.freeReply)self.freeReply(reply);
    }
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
    [self.text refreshTypewriterCaret:NO];
    if(self.applying || self.composing || self.detached || self.reportingViewport || self.draftError)return;
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
    if(!self.draftError)[self acceptChanges];self.composing=NO;self.compositionBase=nil;
    [self emit:@"composition" fields:@{@"revision":@(self.revision),@"active":@NO}];
    if(!self.draftError)[self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
}
- (void)acceptChanges { [self acceptChangesPreservingRejectedText:NO]; }
- (BOOL)acceptChangesPreservingRejectedText:(BOOL)preserve {
    if(self.draftError)return NO;
    NSString *after=[self.text.string copy];
    if([self.committed isEqualToString:after]){[self.pending removeAllObjects];return YES;}
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
    BOOL didAccept=accepted>=0 && (uint64_t)accepted>self.revision;
    if(didAccept){
        if(projection)[self applyProjection:projection revision:(uint64_t)accepted];
        else {self.revision=(uint64_t)accepted;self.committed=after;}
    }
    else{
        if(preserve || self.draftError)return NO;
        self.applying=YES;
        self.text.string=self.committed;
        NSUInteger position=MIN([delta[@"range"][@"start"] unsignedIntegerValue],self.committed.length);
        self.text.selectedRange=NSMakeRange(position,0);
        [self applyStyles];self.applying=NO;
    }
    [self.pending removeAllObjects];
    if(!self.composing)[self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
    return didAccept;
}
- (BOOL)textView:(NSTextView *)view shouldChangeTextInRange:(NSRange)range replacementString:(NSString *)replacement {
    if(self.applying)return YES;
    if(self.draftError)return NO;
    if(!replacement)return NO; // Formatting must be a canonical document transaction.
    [self.pending addObject:@{@"range":SumiRange(range),@"replacement":replacement}];
    return YES;
}
- (void)textDidChange:(NSNotification *)notification {
    [self.text refreshTypewriterCaret:YES];
    if(self.applying || self.composing || self.text.hasMarkedText)return;
    [self acceptChanges];
}
- (void)textViewDidChangeSelection:(NSNotification *)notification {
    if(!self.applying && !self.composing && !self.text.caretInputDepth && !self.text.focusKeyDepth && !self.text.focusTracking && self.pending.count==0)[self.text stopFocusTyping];
    [self.text refreshTypewriterCaret:YES];
    if(self.applying || self.composing || self.pending.count>0 || self.draftError)return;
    [self emit:@"selection" fields:@{@"revision":@(self.revision),@"range":SumiRange(self.text.selectedRange)}];
}
- (void)action:(NSString *)action {
    if(self.composing || self.detached)return;
    if(self.draftError && ![action isEqualToString:@"save"])return;
    [self transaction:@"action" fields:@{@"revision":@(self.revision),@"action":action,@"range":SumiRange(self.text.selectedRange)}];
}
- (void)transaction:(NSString *)kind fields:(NSDictionary *)fields {
    NSDictionary *projection=nil;
    int64_t accepted=[self emit:kind fields:fields projection:&projection];
    if(accepted>=0 && (uint64_t)accepted>=self.revision && projection)
        [self applyProjection:projection revision:(uint64_t)accepted];
}
- (void)retainDraft:(NSDictionary *)projection error:(NSString *)error {
    [self.text stopFocusTyping];
    BOOL applying=self.applying;self.applying=YES;
    // This is a display-only draft, never a committed revision or undo edit.
    if([projection[@"document"][@"text"] isKindOfClass:NSString.class]){
        NSString *next=projection[@"document"][@"text"];
        NSDictionary *delta=SumiDifference(self.text.string,next);
        if([delta[@"range"][@"length"] unsignedIntegerValue] || [delta[@"replacement"] length])
            [self.text.textStorage replaceCharactersInRange:SumiReadRange(delta[@"range"]) withString:delta[@"replacement"]];
        [self refreshRuns:projection[@"document"][@"runs"] ?: @[]];
        NSRange selection=SumiReadRange(projection[@"selection"]);
        if(NSMaxRange(selection)<=self.text.string.length)self.text.selectedRange=selection;
    }
    self.draftError=error;self.text.editable=NO;self.text.selectable=YES;
    self.applying=applying;[self.text refreshTypewriterCaret:NO];
}
- (void)applyProjection:(NSDictionary *)projection revision:(uint64_t)revision {
    if(self.text.focusTracking)[self.text stopFocusTyping];
    BOOL applying=self.applying;self.applying=YES;
    NSString *next=projection[@"document"][@"text"] ?: @"";
    self.focusDocumentReady=[projection[@"document"][@"text"] isKindOfClass:NSString.class];
    NSDictionary *delta=SumiDifference(self.text.string,next);
    if([delta[@"range"][@"length"] unsignedIntegerValue] || [delta[@"replacement"] length])
        [self.text.textStorage replaceCharactersInRange:SumiReadRange(delta[@"range"]) withString:delta[@"replacement"]];
    self.revision=revision;self.committed=[next copy];
    self.draftError=nil;self.text.editable=YES;[self.pending removeAllObjects];
    [self refreshRuns:projection[@"document"][@"runs"] ?: @[]];
    NSRange selection=SumiReadRange(projection[@"selection"]);
    if(NSMaxRange(selection)<=self.text.string.length)self.text.selectedRange=selection;
    self.applying=applying;
    [self.text ensureEmptyFocus];[self.text updateFocusRows];
    [self.text refreshTypewriterCaret:YES];
}
- (NSFont *)baseFont {
    CGFloat size=[self.appearance[@"font_size"] doubleValue];
    NSString *family=self.appearance[@"font_family"];
    if([family isEqualToString:@"Sumi System"])return [NSFont monospacedSystemFontOfSize:size weight:NSFontWeightLight];
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
    CGFloat w=self.container.bounds.size.width,h=self.container.bounds.size.height;
    NSFont *font=[self baseFont];
    CGFloat cell=[@"0" sizeWithAttributes:@{NSFontAttributeName:font}].width;
    CGFloat scale=font.pointSize/22.0;
    CGFloat horizontal=MIN(MAX(16,24*scale),MAX(0,w)/4);
    CGFloat vertical=MIN(MAX(20,32*scale),MAX(0,h)/4);
    CGFloat content=MIN(MAX(0,w-2*horizontal),cell*[self.appearance[@"max_columns"] doubleValue]);
    CGFloat margin=MAX(horizontal,(w-content)/2);
    self.scroll.frame=self.container.bounds;
    self.text.frame=NSMakeRect(0,0,w,MAX(self.scroll.contentSize.height,self.text.frame.size.height));
    self.text.textContainerInset=NSMakeSize(margin,vertical);
    self.text.textContainer.containerSize=NSMakeSize(MAX(0,w-2*margin),CGFLOAT_MAX);
    self.scroll.contentInsets=NSEdgeInsetsMake(0,0,[self.appearance[@"bottom_inset"] doubleValue],0);
    [self.text updateFocusRows];
    [self.text refreshTypewriterCaret:NO];
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
    self.text.accessibilityLabel=SumiLabel(self.locale,@"Sumi writing editor");
    self.text.backgroundColor=SumiColor(self.appearance[@"background"]);
    [self.text syncSystemCaretColor];self.scroll.backgroundColor=self.text.backgroundColor;
    self.container.wantsLayer=YES;self.container.layer.backgroundColor=self.text.backgroundColor.CGColor;
    self.text.selectedTextAttributes=@{NSBackgroundColorAttributeName:[foreground colorWithAlphaComponent:0.22],NSForegroundColorAttributeName:foreground};
    [self.text refreshTypewriterCaret:NO];
}
@end

static SumiTextView *SumiFindBarOwner(NSView *view) {
    if([view isKindOfClass:SumiTextView.class]) {
        SumiTextView *text=(SumiTextView *)view;
        if(text.owner && !text.owner.detached && !text.isHiddenOrHasHiddenAncestor && text.owner.scroll.findBarVisible)return text;
    }
    for(NSView *child in view.subviews){SumiTextView *found=SumiFindBarOwner(child);if(found)return found;}
    return nil;
}
int sumi_editor_menu_command(const char *command){
    if(!NSThread.isMainThread || !command)return 0;
    NSResponder *responder=NSApp.keyWindow.firstResponder;
    NSString *name=[NSString stringWithUTF8String:command];
    if([name hasPrefix:@"input:"]){
        NSDictionary *selectors=@{@"input:select_all":@"selectAll:",@"input:undo":@"undo:",@"input:redo":@"redo:"};
        NSString *selector=selectors[name];
        if(selector)[NSApp sendAction:NSSelectorFromString(selector) to:responder from:nil];
        return selector?1:0;
    }
    if(![responder isKindOfClass:SumiTextView.class]){
        // Find-bar fields are ordinary AppKit controls. Search and document
        // menu items still address their visible editor, while Cut/Copy/Select
        // All/Undo keep operating on the field itself.
        if(![@[@"find",@"find_next",@"find_previous",@"replace",@"new_page",@"menu",@"save",@"export",@"settings",@"close",@"zoom_in",@"zoom_out",@"zoom_reset"] containsObject:name])return 0;
        SumiTextView *text=SumiFindBarOwner(NSApp.keyWindow.contentView);
        return text?[text sumiCommand:name]:0;
    }
    return [(SumiTextView *)responder sumiCommand:[NSString stringWithUTF8String:command]]?1:0;
}
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
    editor.scroll=[[SumiScrollView alloc] initWithFrame:NSZeroRect];editor.scroll.hasVerticalScroller=NO;editor.scroll.autohidesScrollers=YES;editor.scroll.borderType=NSNoBorder;editor.scroll.drawsBackground=YES;
    if(@available(macOS 13.0,*)){
        editor.text=[[SumiTextView alloc] initUsingTextLayoutManager:YES];
        if(!editor.text.textLayoutManager)return NULL;
    } else return NULL;
    editor.locale=SumiLocale(editor.appearance[@"locale"]);
    editor.text.accessibilityIdentifier=@"sumi-native-editor";
    editor.text.owner=editor;((SumiScrollView *)editor.scroll).focusText=editor.text;editor.text.delegate=editor;editor.text.richText=YES;editor.text.importsGraphics=NO;editor.text.allowsUndo=NO;editor.text.usesFindBar=YES;editor.text.incrementalSearchingEnabled=YES;
    [editor.text ensureCandidateBridge];
    editor.text.verticallyResizable=YES;editor.text.horizontallyResizable=NO;editor.text.minSize=NSZeroSize;editor.text.maxSize=NSMakeSize(CGFLOAT_MAX,CGFLOAT_MAX);
    editor.text.textContainer.widthTracksTextView=NO;editor.text.textContainer.lineFragmentPadding=0;
    editor.text.automaticQuoteSubstitutionEnabled=NO;editor.text.automaticDashSubstitutionEnabled=NO;editor.text.automaticTextReplacementEnabled=NO;editor.text.automaticLinkDetectionEnabled=NO;
    editor.applying=YES;editor.text.string=config[@"document"][@"text"] ?: @"";editor.committed=[editor.text.string copy];
    editor.focusDocumentReady=[config[@"document"][@"text"] isKindOfClass:NSString.class];
    editor.scroll.documentView=editor.text;[editor.container addSubview:editor.scroll];
    [parent addSubview:editor.container positioned:NSWindowAbove relativeTo:webview_sibling?reference:nil];
    [editor applyStyles];[editor setBounds:config[@"bounds"]];
    NSRange selection=SumiReadRange(config[@"selection"] ?: @{});
    if(NSMaxRange(selection)<=editor.text.string.length)editor.text.selectedRange=selection;
    if(config[@"viewport"])[editor restoreViewport:config[@"viewport"]];
    editor.applying=NO;[editor.text ensureEmptyFocus];[editor.text updateFocusRows];
    editor.scroll.contentView.postsBoundsChangedNotifications=YES;
    [NSNotificationCenter.defaultCenter addObserver:editor.text selector:@selector(focusScrollNotification:) name:NSScrollViewWillStartLiveScrollNotification object:editor.scroll];
    [NSNotificationCenter.defaultCenter addObserver:editor selector:@selector(viewportChanged:) name:NSViewBoundsDidChangeNotification object:editor.scroll.contentView];
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
        [editor setBounds:value[@"bounds"]];editor.applying=applying;[editor.text ensureEmptyFocus];[editor.text updateFocusRows];[editor.text refreshTypewriterCaret:NO];return 0;
    }
    if([command isEqualToString:@"set_locale"]){
        editor.locale=SumiLocale(value[@"locale"]);
        editor.text.accessibilityLabel=SumiLabel(editor.locale,@"Sumi writing editor");return 0;
    }
    if([command isEqualToString:@"set_appearance"]){
        if(editor.composing)return 1;
        editor.applying=YES;editor.appearance=value[@"appearance"];[editor applyStyles];[editor layoutEditor];editor.applying=NO;[editor.text ensureEmptyFocus];[editor.text updateFocusRows];[editor.text refreshTypewriterCaret:NO];return 0;
    }
    if([command isEqualToString:@"focus"]){BOOL applying=editor.applying;editor.applying=YES;[editor.text.window makeFirstResponder:editor.text];editor.applying=applying;[editor.text ensureEmptyFocus];[editor.text updateFocusRows];return 0;}
    if([command isEqualToString:@"prepare_panel"]){
        if(editor.draftError)return 5;
        if(![editor.text prepareForPanel])return 5;
        if(editor.text.window.firstResponder==editor.text && ![editor.text.window makeFirstResponder:nil])return 5;
        editor.container.hidden=YES;SumiTypingRefresh();return 0;
    }
    if([command isEqualToString:@"set_visible"]){
        BOOL visible=[value[@"visible"] boolValue];if(!visible && editor.draftError)return 5;
        if(visible==!editor.container.hidden)return 0;
        if(editor.composing)return 1;
        editor.container.hidden=!visible;SumiTypingRefresh();
        if(visible){[editor.text ensureEmptyFocus];[editor.text updateFocusRows];}
        if(!visible && editor.text.window.firstResponder==editor.text)[editor.text.window makeFirstResponder:nil];return 0;
    }
    return 3;
}
char *sumi_editor_inspect(void *handle){
    if(!NSThread.isMainThread || !handle)return NULL;
    SumiEditor *editor=(__bridge SumiEditor *)handle;
    BOOL textkit2=NO; if(@available(macOS 12.0,*))textkit2=editor.text.textLayoutManager!=nil;
    BOOL applying=editor.applying;editor.applying=YES;NSDictionary *viewport=[editor viewport];editor.applying=applying;
    NSDictionary *state=@{@"surface_id":editor.surfaceID,@"generation":@(editor.generation),@"revision":@(editor.revision),@"text":editor.text.string,@"selection":SumiRange(editor.text.selectedRange),@"composing":editor.composing?@YES:@NO,@"textkit2":textkit2?@YES:@NO,@"visible":editor.container.hidden?@NO:@YES,@"viewport":viewport,@"draft_error":editor.draftError ?: NSNull.null};
    NSData *data=[NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];return strdup(json.UTF8String);
}
void sumi_editor_free_string(char *value){free(value);}
void sumi_editor_detach(void *handle){
    if(!handle || !NSThread.isMainThread)return;
    SumiEditor *editor=(__bridge_transfer SumiEditor *)handle;
    [editor.text.candidateBridge releaseLease];
    if(SumiTypingOwner==editor)SumiTypingClear();
    [editor.text stopFocusTyping];
    editor.detached=YES;editor.callback=NULL;editor.text.delegate=nil;editor.text.owner=nil;
    [editor.text refreshTypewriterCaret:NO];
    [NSNotificationCenter.defaultCenter removeObserver:editor];
    if(editor.text.window.firstResponder==editor.text)[editor.text.window makeFirstResponder:nil];
    [editor.container removeFromSuperview];
}
