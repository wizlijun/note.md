// AppKit-only presentation. Candidate identity and commits remain owned by the IME.
#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>

@interface SumiCandidateItem : NSObject
@property(nonatomic) NSRect frame;
@property(nonatomic,copy) NSAttributedString *text;
@property(nonatomic) NSInteger candidateIndex;
@property(nonatomic) NSInteger action; // 0 candidate, -1 previous page, 1 next page
@property(nonatomic,copy) NSString *accessibilityText;
@end
@implementation SumiCandidateItem
@end

@interface SumiCandidatesView : NSView
@property(nonatomic,strong) NSColor *backgroundColor;
@property(nonatomic,copy) void (^selectCandidate)(NSInteger index);
@property(nonatomic,copy) void (^pageCandidates)(BOOL next);
@property(nonatomic,copy) void (^layoutChanged)(void);
@property(nonatomic,readonly) CGFloat contentHeight;
@property(nonatomic,readonly) NSUInteger rowCount, localPage, localPageCount;
@property(nonatomic,copy,readonly) NSArray<SumiCandidateItem *> *items;
// Prepares only. The owner controls the view frame, visibility and protocol ACK.
- (BOOL)prepareSnapshot:(NSDictionary *)snapshot attributes:(NSDictionary *)attributes
            lineHeight:(CGFloat)lineHeight width:(CGFloat)width maxHeight:(CGFloat)maxHeight;
- (void)clear;
- (void)activateItem:(SumiCandidateItem *)item;
@end

static CGFloat SumiCandidateWidth(NSAttributedString *text) {
    CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)text);
    CGFloat width=(CGFloat)CTLineGetTypographicBounds(line,NULL,NULL,NULL);CFRelease(line);return ceil(width);
}
static NSString *SumiCandidateDisplayText(NSString *text) {
    return [[text componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]] componentsJoinedByString:@" "];
}
static NSAttributedString *SumiCandidateText(NSDictionary *candidate,NSDictionary *attributes,BOOL selected) {
    NSMutableDictionary *body=[attributes mutableCopy];
    [body removeObjectForKey:NSBackgroundColorAttributeName];[body removeObjectForKey:NSParagraphStyleAttributeName];
    [body removeObjectForKey:NSUnderlineStyleAttributeName];
    NSString *label=[candidate[@"label"] isKindOfClass:NSString.class]?candidate[@"label"]:@"";
    NSString *word=SumiCandidateDisplayText([candidate[@"text"] isKindOfClass:NSString.class]?candidate[@"text"]:@"");
    NSMutableAttributedString *result=[[NSMutableAttributedString alloc]initWithString:@""];
    if(label.length){
        NSMutableDictionary *hint=[body mutableCopy];NSColor *foreground=hint[NSForegroundColorAttributeName]?:NSColor.textColor;
        hint[NSForegroundColorAttributeName]=[foreground colorWithAlphaComponent:.65];
        [result appendAttributedString:[[NSAttributedString alloc]initWithString:[SumiCandidateDisplayText(label) stringByAppendingString:@" "] attributes:hint]];
    }
    if(selected)body[NSUnderlineStyleAttributeName]=@(NSUnderlineStyleSingle);
    [result appendAttributedString:[[NSAttributedString alloc]initWithString:word attributes:body]];
    return result;
}
static NSAttributedString *SumiCandidateTruncate(NSAttributedString *text,CGFloat width) {
    if(SumiCandidateWidth(text)<=width)return text;
    NSDictionary *attributes=text.length?[text attributesAtIndex:text.length-1 effectiveRange:NULL]:@{};
    NSAttributedString *ellipsis=[[NSAttributedString alloc]initWithString:@"…" attributes:attributes];
    if(SumiCandidateWidth(ellipsis)>width)return nil;
    NSMutableArray<NSNumber *> *ends=[NSMutableArray arrayWithObject:@0];
    [text.string enumerateSubstringsInRange:NSMakeRange(0,text.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString *substring,NSRange range,NSRange enclosing,BOOL *stop){(void)substring;(void)enclosing;(void)stop;[ends addObject:@(NSMaxRange(range))];}];
    NSUInteger low=0,high=ends.count-1;
    while(low<high){
        NSUInteger mid=(low+high+1)/2;
        NSMutableAttributedString *trial=[[text attributedSubstringFromRange:NSMakeRange(0,ends[mid].unsignedIntegerValue)]mutableCopy];[trial appendAttributedString:ellipsis];
        if(SumiCandidateWidth(trial)<=width)low=mid;else high=mid-1;
    }
    NSMutableAttributedString *result=[[text attributedSubstringFromRange:NSMakeRange(0,ends[low].unsignedIntegerValue)]mutableCopy];[result appendAttributedString:ellipsis];return result;
}

@interface SumiCandidateAccessibilityElement : NSAccessibilityElement
@property(nonatomic,weak) SumiCandidatesView *owner;
@property(nonatomic,strong) SumiCandidateItem *item;
@end
@implementation SumiCandidateAccessibilityElement
- (BOOL)accessibilityPerformPress {
    if(!self.owner || self.owner.hidden || ![self.owner.items containsObject:self.item])return NO;
    [self.owner activateItem:self.item];return YES;
}
@end

@implementation SumiCandidatesView {
    NSDictionary *_snapshot, *_attributes;
    NSArray<NSArray<SumiCandidateItem *> *> *_pages;
    NSArray<SumiCandidateItem *> *_items;
    CGFloat _lineHeight, _width, _contentHeight;
    NSUInteger _maxRows, _rowCount, _localPage;
    BOOL _navigation;
}
- (BOOL)isFlipped {return YES;}
- (BOOL)acceptsFirstResponder {return NO;}
- (BOOL)acceptsFirstMouse:(NSEvent *)event {(void)event;return YES;}
- (BOOL)isOpaque {return self.backgroundColor.alphaComponent>=1;}
- (BOOL)isAccessibilityElement {return NO;}
- (NSView *)hitTest:(NSPoint)point {return !self.hidden && NSPointInRect([self convertPoint:point fromView:self.superview],self.bounds)?self:nil;}
- (CGFloat)contentHeight {return _contentHeight;}
- (NSUInteger)rowCount {return _rowCount;}
- (NSUInteger)localPage {return _localPage;}
- (NSUInteger)localPageCount {return _pages.count;}
- (NSArray<SumiCandidateItem *> *)items {return _items?:@[];}
- (void)clear {_snapshot=nil;_pages=@[];_items=@[];_contentHeight=0;_rowCount=0;_localPage=0;self.needsDisplay=YES;}
- (CGFloat)navigationWidth {
    NSAttributedString *text=[[NSAttributedString alloc]initWithString:@"‹ ›" attributes:_attributes];
    return SumiCandidateWidth(text)+[self gap]/2;
}
- (CGFloat)gap {
    return MAX(2,SumiCandidateWidth([[NSAttributedString alloc]initWithString:@"  " attributes:_attributes]));
}
- (NSArray<NSArray<SumiCandidateItem *> *> *)makePages:(NSArray *)candidates navigation:(BOOL)navigation {
    NSMutableArray *pages=[NSMutableArray new];NSMutableArray *page=[NSMutableArray new];
    NSUInteger row=0;CGFloat x=0,gap=[self gap],navigationWidth=navigation?[self navigationWidth]:0;
    NSInteger selected=[_snapshot[@"cursor"] integerValue];
    for(NSDictionary *candidate in candidates){
        NSAttributedString *full=SumiCandidateText(candidate,_attributes,[candidate[@"index"]integerValue]==selected);
        CGFloat limit=_width-(row==_maxRows-1?navigationWidth:0);
        CGFloat natural=SumiCandidateWidth(full);
        // A whole candidate moves to a fresh row; only a candidate wider than
        // the whole available row is shortened, without changing its identity.
        if(x>0 && x+natural>limit){row++;x=0;}
        if(row>=_maxRows){[pages addObject:page];page=[NSMutableArray new];row=0;}
        limit=_width-(row==_maxRows-1?navigationWidth:0);
        if(SumiCandidateWidth(full)>limit && [candidate[@"label"]length]){
            NSAttributedString *hint=[[NSAttributedString alloc]initWithString:[candidate[@"label"]stringByAppendingString:@" …"] attributes:_attributes];
            if(SumiCandidateWidth(hint)>limit){
                // A clipped numeric hint can claim the wrong shortcut. Omit
                // the optional hint entirely when it cannot fit beside a word.
                NSMutableDictionary *withoutHint=[candidate mutableCopy];withoutHint[@"label"]=@"";
                full=SumiCandidateText(withoutHint,_attributes,[candidate[@"index"]integerValue]==selected);
            }
        }
        NSAttributedString *display=SumiCandidateTruncate(full,limit);
        if(!display)return nil;
        SumiCandidateItem *item=[SumiCandidateItem new];item.text=display;item.candidateIndex=[candidate[@"index"]integerValue];
        item.frame=NSMakeRect(x,row*_lineHeight,MIN(limit,SumiCandidateWidth(display)),_lineHeight);
        item.accessibilityText=candidate[@"text"]?:@"";[page addObject:item];x=NSMaxX(item.frame)+gap;
    }
    if(page.count)[pages addObject:page];return pages;
}
- (void)displayLocalPage {
    NSMutableArray *items=[_pages[_localPage]mutableCopy];
    _rowCount=0;for(SumiCandidateItem *item in items)_rowCount=MAX(_rowCount,(NSUInteger)llround(item.frame.origin.y/_lineHeight)+1);
    if(_navigation){
        // Navigation occupies the trailing part of the last visible row. The
        // candidate packer reserves it on a full page; a short last page may
        // need one additional row, always within the same four-row budget.
        CGFloat navWidth=[self navigationWidth],navX=MAX(0,_width-navWidth);
        SumiCandidateItem *last=items.lastObject;
        if(last && NSMaxX(last.frame)>navX && _rowCount<_maxRows)_rowCount++;
        CGFloat y=(_rowCount-1)*_lineHeight;
        BOOL previous=_localPage>0 || [_snapshot[@"hasPrev"]boolValue];
        BOOL next=_localPage+1<_pages.count || [_snapshot[@"hasNext"]boolValue];
        for(NSNumber *direction in @[@(-1),@1]){
            BOOL enabled=direction.integerValue<0?previous:next;if(!enabled)continue;
            SumiCandidateItem *item=[SumiCandidateItem new];item.action=direction.integerValue;
            item.text=[[NSAttributedString alloc]initWithString:item.action<0?@"‹":@"›" attributes:_attributes];
            item.frame=NSMakeRect(navX+(item.action>0?navWidth/2:0),y,navWidth/2,_lineHeight);
            item.accessibilityText=item.action<0?@"上一页":@"下一页";[items addObject:item];
        }
    }
    _items=items;_contentHeight=_rowCount*_lineHeight;self.needsDisplay=YES;
    NSAccessibilityPostNotification(self,NSAccessibilityLayoutChangedNotification);
}
- (BOOL)prepareSnapshot:(NSDictionary *)snapshot attributes:(NSDictionary *)attributes lineHeight:(CGFloat)lineHeight width:(CGFloat)width maxHeight:(CGFloat)maxHeight {
    NSArray *candidates=snapshot[@"candidates"];
    if(![candidates isKindOfClass:NSArray.class] || ![attributes[NSFontAttributeName] isKindOfClass:NSFont.class] || !isfinite(lineHeight) || lineHeight<=0 || !isfinite(width) || width<=0 || !isfinite(maxHeight)){[self clear];return NO;}
    BOOL same=[_snapshot[@"candidates"]isEqual:candidates] && [_snapshot[@"cursor"]isEqual:snapshot[@"cursor"]];
    _snapshot=[snapshot copy];_attributes=[attributes copy];_lineHeight=lineHeight;_width=width;
    _maxRows=(NSUInteger)MAX(0,MIN(4,floor(maxHeight/lineHeight)));
    if(!candidates.count){_pages=@[];_items=@[];_contentHeight=0;_rowCount=0;_localPage=0;self.needsDisplay=YES;return YES;}
    if(!_maxRows){[self clear];return NO;}
    NSArray *pages=[self makePages:candidates navigation:NO];
    _navigation=pages.count>1 || [snapshot[@"hasPrev"]boolValue] || [snapshot[@"hasNext"]boolValue];
    if(_navigation){
        CGFloat smallest=SumiCandidateWidth([[NSAttributedString alloc]initWithString:@"…" attributes:attributes]);
        if(width<[self navigationWidth]+smallest){[self clear];return NO;}
        pages=[self makePages:candidates navigation:YES];
    }
    if(!pages.count){[self clear];return NO;}
    _pages=pages;_localPage=MIN(_localPage,_pages.count-1);
    if(!same){
        _localPage=0;NSInteger selected=[snapshot[@"cursor"]integerValue];
        for(NSUInteger p=0;p<_pages.count;p++)for(SumiCandidateItem *item in _pages[p])if(item.candidateIndex==selected)_localPage=p;
    }
    [self displayLocalPage];return YES;
}
- (void)activateItem:(SumiCandidateItem *)item {
    if(![_items containsObject:item])return;
    if(!item.action){if(self.selectCandidate)self.selectCandidate(item.candidateIndex);return;}
    if(item.action<0 && _localPage>0){_localPage--;[self displayLocalPage];if(self.layoutChanged)self.layoutChanged();}
    else if(item.action>0 && _localPage+1<_pages.count){_localPage++;[self displayLocalPage];if(self.layoutChanged)self.layoutChanged();}
    else if(self.pageCandidates)self.pageCandidates(item.action>0);
}
- (void)mouseDown:(NSEvent *)event {
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    for(SumiCandidateItem *item in _items)if(NSPointInRect(point,item.frame)){[self activateItem:item];return;}
}
- (NSArray *)accessibilityChildren {
    NSMutableArray *children=[NSMutableArray new];
    for(SumiCandidateItem *item in _items){
        SumiCandidateAccessibilityElement *element=[SumiCandidateAccessibilityElement accessibilityElementWithRole:NSAccessibilityButtonRole frame:NSAccessibilityFrameInView(self,item.frame) label:item.accessibilityText parent:self];
        element.owner=self;element.item=item;[children addObject:element];
    }
    return children;
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;[(self.backgroundColor?:NSColor.textBackgroundColor)setFill];NSRectFill(self.bounds);
    CGContextRef context=NSGraphicsContext.currentContext.CGContext;
    for(SumiCandidateItem *item in _items){
        CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)item.text);CGFloat ascent=0,descent=0;
        CTLineGetTypographicBounds(line,&ascent,&descent,NULL);
        CGFloat baseline=item.frame.origin.y+(_lineHeight-ascent-descent)/2+ascent;
        CGContextSaveGState(context);CGContextClipToRect(context,item.frame);
        CGContextSetTextMatrix(context,CGAffineTransformIdentity);CGContextTranslateCTM(context,item.frame.origin.x,baseline);CGContextScaleCTM(context,1,-1);
        CGContextSetTextPosition(context,0,0);CTLineDraw(line,context);CGContextRestoreGState(context);CFRelease(line);
    }
}
@end
