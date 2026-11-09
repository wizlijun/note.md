// Immutable native glyph tiles, bounded to the current viewport.
@interface SumiFocusTile : NSObject
@property(nonatomic) CGImageRef image;
@property(nonatomic) NSRect bounds;
@end
@implementation SumiFocusTile
- (void)dealloc {if(_image)CGImageRelease(_image);}
@end
@interface SumiFocusRow : NSObject
@property(nonatomic,strong) NSTextLineFragment *line API_AVAILABLE(macos(12.0));
@property(nonatomic,strong) NSTextLayoutFragment *fragment API_AVAILABLE(macos(12.0));
@property(nonatomic) NSRange range;
@property(nonatomic) NSPoint rawOrigin, origin, startOrigin;
@property(nonatomic) CGFloat alpha, height;
@property(nonatomic,strong) SumiFocusTile *rasterTile;
@property(nonatomic,readonly) CGImageRef rasterImage;
@property(nonatomic,readonly) NSRect rasterBounds;
@end
@implementation SumiFocusRow
- (CGImageRef)rasterImage{return self.rasterTile.image;}
- (NSRect)rasterBounds{return self.rasterTile.bounds;}
@end
static NSArray *SumiFocusTileKey(SumiFocusRow *row,CGFloat scale,CGFloat padding) API_AVAILABLE(macos(13.0));
static NSArray *SumiFocusTileKey(SumiFocusRow *row,CGFloat scale,CGFloat padding){
    NSAttributedString *source=row.line.attributedString;NSRange range=row.line.characterRange;
    if(range.location>source.length || range.length>source.length-range.location)return nil;
    // Copy only this bounded visual line, never its parent paragraph/document.
    NSMutableAttributedString *slice=[[source attributedSubstringFromRange:range]mutableCopy];
    NSAttributedString *attributes=[slice copy];
    [attributes enumerateAttribute:NSParagraphStyleAttributeName inRange:NSMakeRange(0,attributes.length) options:0 usingBlock:^(id value,NSRange part,BOOL *stop){(void)stop;if(value)[slice addAttribute:NSParagraphStyleAttributeName value:[value copy] range:part];}];
    // The native shaped paragraph snapshot and its local range are part of
    // the key: equal visible text alone does not imply equal contextual shaping.
    // Current/next rows retain their original native line through cache lookup.
    return @[[NSValue valueWithNonretainedObject:source],[NSValue valueWithRange:range],[slice copy],[NSValue valueWithRect:row.line.typographicBounds],[NSValue valueWithPoint:row.line.glyphOrigin],@(scale),@(padding),@(row.height)];
}
static SumiFocusTile *SumiCreateFocusTile(SumiFocusRow *row,CGFloat scale,CGFloat padding) API_AVAILABLE(macos(13.0));
static SumiFocusTile *SumiCreateFocusTile(SumiFocusRow *row,CGFloat scale,CGFloat padding){
    scale=MAX(1,scale);padding=MAX(4,ceil(padding));
    NSRect bounds=NSMakeRect(-padding,-padding,ceil(MAX(1,row.line.typographicBounds.size.width)+2*padding),ceil(MAX(1,row.height)+2*padding));
    size_t width=(size_t)ceil(bounds.size.width*scale),height=(size_t)ceil(bounds.size.height*scale);
    if(!width || !height || width>32768 || height>32768)return nil;
    CGColorSpaceRef color=CGColorSpaceCreateDeviceRGB();CGContextRef bitmap=CGBitmapContextCreate(NULL,width,height,8,0,color,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);CGColorSpaceRelease(color);if(!bitmap)return nil;
    CGContextClearRect(bitmap,CGRectMake(0,0,width,height));
    CGContextTranslateCTM(bitmap,-bounds.origin.x*scale,(CGFloat)height+bounds.origin.y*scale);CGContextScaleCTM(bitmap,scale,-scale);
    CGContextSetTextMatrix(bitmap,CGAffineTransformIdentity);CGContextSetShouldAntialias(bitmap,YES);
    NSGraphicsContext *graphics=[NSGraphicsContext graphicsContextWithCGContext:bitmap flipped:YES];
    [NSGraphicsContext saveGraphicsState];[NSGraphicsContext setCurrentContext:graphics];[row.line drawAtPoint:NSZeroPoint inContext:bitmap];[NSGraphicsContext restoreGraphicsState];
    CGImageRef image=CGBitmapContextCreateImage(bitmap);CGContextRelease(bitmap);if(!image)return nil;
    SumiFocusTile *tile=[SumiFocusTile new];tile.image=image;tile.bounds=bounds;
    return tile;
}
@interface SumiFocusView : NSView
@property(nonatomic,weak) SumiTextView *text;
@property(nonatomic,copy) NSArray<SumiFocusRow *> *rows;
@property(nonatomic,copy) NSDictionary<NSArray *,SumiFocusTile *> *rasterCache;
@property(nonatomic) float nativeScrollOpacity;
@property(nonatomic) BOOL nativeScrollHidden;
@property(nonatomic) CGFloat progress, strength, fromProgress, fromStrength, targetStrength;
@property(nonatomic) CFTimeInterval started, lastActivity;
@property(nonatomic) NSTimeInterval duration;
@property(nonatomic,strong) NSTimer *timer, *idleTimer;
@end
@implementation SumiFocusView
- (BOOL)isFlipped {return YES;}
- (BOOL)isAccessibilityElement {return NO;}
- (NSView *)hitTest:(NSPoint)point {(void)point;return nil;}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;[self.text.backgroundColor setFill];NSRectFillUsingOperation(self.bounds,NSCompositingOperationSourceOver);
    CGContextRef ctx=NSGraphicsContext.currentContext.CGContext;
    NSArray<SumiFocusRow *> *frameRows=self.rows;
    if(@available(macOS 13.0,*))for(SumiFocusRow *row in frameRows){
        CGFloat p=self.progress;
        NSPoint origin=NSMakePoint(row.startOrigin.x+(row.origin.x-row.startOrigin.x)*p,row.startOrigin.y+(row.origin.y-row.startOrigin.y)*p);
        CGContextSaveGState(ctx);CGContextSetAlpha(ctx,1+(row.alpha-1)*self.strength);
        CGContextTranslateCTM(ctx,origin.x,origin.y);
        NSRange selected=NSIntersectionRange(self.text.selectedRange,row.range);
        if(self.text.focusTracking && selected.length){
            NSUInteger base=row.line.characterRange.location;
            NSPoint left=[row.line locationForCharacterAtIndex:base+selected.location-row.range.location];
            NSPoint right=[row.line locationForCharacterAtIndex:base+NSMaxRange(selected)-row.range.location];
            [NSColor.selectedTextBackgroundColor setFill];NSRectFill(NSMakeRect(MIN(left.x,right.x),0,MAX(1,fabs(right.x-left.x)),row.height));
        }
        if(row.rasterImage){
            NSRect bounds=row.rasterBounds;CGContextTranslateCTM(ctx,bounds.origin.x,bounds.origin.y+bounds.size.height);CGContextScaleCTM(ctx,1,-1);
            CGContextDrawImage(ctx,CGRectMake(0,0,bounds.size.width,bounds.size.height),row.rasterImage);
        }
        CGContextRestoreGState(ctx);
    }
}
- (void)dealloc {[self.timer invalidate];[self.idleTimer invalidate];}
@end

@implementation SumiTextView (FocusTyping)
- (BOOL)focusEnabled {if(@available(macOS 13.0,*)){}else{return NO;}id value=self.owner.appearance[@"focus_typing"];return value ? [value boolValue] : YES;}
- (void)ensureEmptyFocus {
    if(self.focusView || !self.owner || self.owner.applying || !self.owner.focusDocumentReady
        || ![self focusEnabled] || self.string.length || !self.isEditable || self.owner.draftError || self.owner.detached
        || self.owner.container.hidden || self.isHiddenOrHasHiddenAncestor || self.owner.container.bounds.size.width<=0 || self.owner.container.bounds.size.height<=0)return;
    // A loaded blank page is already a writing surface. Prepare its line in
    // place without editing the document, taking focus, or fabricating input.
    SumiFocusView *view=[[SumiFocusView alloc]initWithFrame:self.owner.container.bounds];view.text=self;view.wantsLayer=YES;
    view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    view.progress=1;view.strength=1;view.targetStrength=1;self.focusView=view;
    [self.owner.container addSubview:view positioned:NSWindowAbove relativeTo:self.owner.scroll];
}
- (void)stopFocusTyping {
    self.focusInputCount=0;self.focusLastInput=0;self.focusFirstInput=0;self.focusResumeOnInput=NO;
    SumiFocusView *view=self.focusView;if(!view)return;
    if(view.nativeScrollHidden){[CATransaction begin];[CATransaction setDisableActions:YES];self.owner.scroll.layer.opacity=view.nativeScrollOpacity;view.nativeScrollHidden=NO;[CATransaction commit];}
    [view.timer invalidate];view.timer=nil;[view.idleTimer invalidate];view.idleTimer=nil;
    if(self.typewriterCaret.superview==view){[self.typewriterCaret removeFromSuperview];[self addSubview:self.typewriterCaret];}
    [view removeFromSuperview];self.focusView=nil;[self scrollRangeToVisible:self.selectedRange];[self.inputContext invalidateCharacterCoordinates];[self refreshTypewriterCaret:NO];
}
- (void)focusScrollNotification:(NSNotification *)notification {(void)notification;[self stopFocusTyping];[self prepareFocusResumeAfterReading];}
- (void)recordFocusEvent:(NSEvent *)event {
    if(event.type!=NSEventTypeKeyDown || event.windowNumber!=self.window.windowNumber || event.timestamp==self.focusLastEvent)return;
    if(event.isARepeat && (!self.focusView || !self.focusInputChanged))return;
    if(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))return;
    if(event.keyCode==123 || event.keyCode==124 || event.keyCode==125 || event.keyCode==126 || event.keyCode==115 || event.keyCode==119 || event.keyCode==116 || event.keyCode==121 || event.keyCode==53)return;
    self.focusLastEvent=event.timestamp;[self recordFocusInputAt:CACurrentMediaTime()];
}
- (void)focusMutationFinished {
    if(self.caretInputDepth || self.focusKeyDepth || self.owner.applying)return;
    [self updateFocusRows];
}
- (void)animateFocusStrength:(CGFloat)strength duration:(NSTimeInterval)duration {
    SumiFocusView *view=self.focusView;if(!view)return;
    [view.timer invalidate];view.timer=nil;
    // Reduced motion suppresses spatial travel. The explicitly requested
    // opacity transition remains visible, just like the independent caret mode.
    if(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion)view.progress=1;
    view.fromProgress=view.progress;view.fromStrength=view.strength;view.targetStrength=strength;
    view.started=CACurrentMediaTime();view.duration=duration;
    __weak SumiTextView *weak=self;__weak SumiFocusView *weakView=view;
    view.timer=[NSTimer scheduledTimerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer *timer){
        SumiTextView *text=weak;SumiFocusView *view=weakView;
        if(!text || !view || text.focusView!=view || view.timer!=timer){[timer invalidate];return;}
        if(!text.owner || !text.isEditable || ![text focusEnabled] || text.owner.draftError || text.owner.detached || text.owner.container.hidden || text.isHiddenOrHasHiddenAncestor || text.window.firstResponder!=text){[text stopFocusTyping];return;}
        CGFloat t=MIN(1,MAX(0,(CACurrentMediaTime()-view.started)/view.duration)),ease=t*t*(3-2*t);
        view.progress=view.fromProgress+(1-view.fromProgress)*ease;
        view.strength=view.fromStrength+(view.targetStrength-view.fromStrength)*ease;
        view.needsDisplay=YES;[text.inputContext invalidateCharacterCoordinates];[text refreshTypewriterCaret:NO];
        if(t>=1){[timer invalidate];view.timer=nil;[text updateFocusRows];}
    }];
}
- (void)scheduleFocusIdle {
    SumiFocusView *view=self.focusView;if(!view || view.idleTimer)return;
    __weak SumiTextView *weak=self;__weak SumiFocusView *weakView=view;
    NSTimeInterval remaining=MAX(.001,10-(CACurrentMediaTime()-view.lastActivity));
    view.idleTimer=[NSTimer scheduledTimerWithTimeInterval:remaining repeats:NO block:^(NSTimer *timer){
        SumiTextView *text=weak;SumiFocusView *view=weakView;
        if(!text || !view || text.focusView!=view || view.idleTimer!=timer)return;
        view.idleTimer=nil;
        if(!text.owner || !text.isEditable || ![text focusEnabled] || text.owner.draftError || text.owner.detached || text.owner.container.hidden || text.isHiddenOrHasHiddenAncestor || text.window.firstResponder!=text){[text stopFocusTyping];return;}
        if(CACurrentMediaTime()-view.lastActivity<10){[text scheduleFocusIdle];return;}
        [text animateFocusStrength:0 duration:1.2];
    }];
}
- (void)recordFocusInputAt:(CFTimeInterval)time {
    if(![self focusEnabled] || !self.owner || self.owner.applying || self.owner.draftError || !self.isEditable || self.owner.detached || self.owner.container.hidden || self.window.firstResponder!=self)return;
    if(time-self.focusFirstInput>2 || time<self.focusLastInput)self.focusInputCount=0;
    if(!self.focusInputCount)self.focusFirstInput=time;
    self.focusLastInput=time;self.focusInputCount++;
    if(!self.focusView && self.focusInputCount<4 && !self.focusResumeOnInput)return;
    BOOL entering=self.focusView==nil;
    if(entering){
        SumiFocusView *view=[[SumiFocusView alloc]initWithFrame:self.owner.container.bounds];view.text=self;view.wantsLayer=YES;
        view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;self.focusView=view;
        [self.owner.container addSubview:view positioned:NSWindowAbove relativeTo:self.owner.scroll];
        view.progress=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?1:0;
    }
    [self updateFocusRows];
    SumiFocusView *view=self.focusView;if(!view)return;
    self.focusResumeOnInput=NO;
    view.lastActivity=CACurrentMediaTime();[self scheduleFocusIdle];
    if(entering || view.targetStrength!=1)[self animateFocusStrength:1 duration:.2];
}
- (void)updateFocusRows {
    if(self.focusUpdating || self.focusTracking)return;
    SumiFocusView *view=self.focusView;if(!view)return;
    if(![self focusEnabled] || self.owner.draftError || !self.isEditable || self.owner.detached || self.owner.container.hidden){[self stopFocusTyping];return;}
    self.focusUpdating=YES;
    if(@available(macOS 13.0,*)){
        NSTextLayoutManager *layout=self.textLayoutManager;NSTextContentManager *content=layout.textContentManager;
        // Commit the bounded native viewport before reading fragment frames.
        // After edits or projection restyling, neighboring paragraphs can
        // otherwise retain incompatible estimated frames and overlap here.
        BOOL reportingViewport=self.owner.reportingViewport;
        self.owner.reportingViewport=YES;
        [layout.textViewportLayoutController layoutViewport];
        self.owner.reportingViewport=reportingViewport;
        NSUInteger index=MIN(self.selectedRange.location,self.string.length);
        id<NSTextLocation> location=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)index];
        NSMutableArray<SumiFocusRow *> *rows=[NSMutableArray new];
        if(location){
            [layout ensureLayoutForRange:[[NSTextRange alloc]initWithLocation:location]];
            __block NSTextLayoutFragment *current=[layout textLayoutFragmentForLocation:location];
            if(!current)[layout enumerateTextLayoutFragmentsFromLocation:location options:NSTextLayoutFragmentEnumerationOptionsReverse|NSTextLayoutFragmentEnumerationOptionsEnsuresLayout|NSTextLayoutFragmentEnumerationOptionsEnsuresExtraLineFragment usingBlock:^BOOL(NSTextLayoutFragment *fragment){current=fragment;return NO;}];
            NSArray<NSTextLineFragment *> *lines=current.textLineFragments;
            NSInteger start=current?[content offsetFromLocation:content.documentRange.location toLocation:current.rangeInElement.location]:0;
            NSUInteger lo=0,hi=lines.count;
            while(lo<hi){NSUInteger mid=lo+(hi-lo)/2;NSUInteger begin=(NSUInteger)MAX(0,start)+lines[mid].characterRange.location;if(begin<=index)lo=mid+1;else hi=mid;}
            if(lo){
                NSUInteger activeIndex=lo-1;
                void (^refreshRow)(SumiFocusRow *)=^(SumiFocusRow *row){
                    row.rawOrigin=NSMakePoint(self.textContainerOrigin.x+row.fragment.layoutFragmentFrame.origin.x+row.line.typographicBounds.origin.x,self.textContainerOrigin.y+row.fragment.layoutFragmentFrame.origin.y+row.line.typographicBounds.origin.y);
                    row.startOrigin=[view convertPoint:row.rawOrigin fromView:self];
                };
                SumiFocusRow *(^makeRow)(NSTextLayoutFragment *,NSTextLineFragment *)=^SumiFocusRow *(NSTextLayoutFragment *fragment,NSTextLineFragment *line){
                    NSInteger offset=[content offsetFromLocation:content.documentRange.location toLocation:fragment.rangeInElement.location];
                    SumiFocusRow *row=[SumiFocusRow new];row.line=line;row.fragment=fragment;row.range=NSMakeRange((NSUInteger)MAX(0,offset)+line.characterRange.location,line.characterRange.length);
                    row.height=line.typographicBounds.size.height;refreshRow(row);
                    return row;
                };
                SumiFocusRow *active=makeRow(current,lines[activeIndex]);[rows addObject:active];
                CGFloat activeMid=active.rawOrigin.y+active.height/2,half=view.bounds.size.height/2;
                // During entry include the old visible rows as well, so they
                // fade and move out instead of disappearing on the first frame.
                // An offscreen synthetic selection must not expand the walk.
                CGFloat startMid=active.startOrigin.y+active.height/2;
                BOOL includeStart=view.progress<1 && startMid>=0 && startMid<=view.bounds.size.height;
                BOOL (^append)(NSTextLayoutFragment *,NSTextLineFragment *,BOOL)=^BOOL(NSTextLayoutFragment *fragment,NSTextLineFragment *line,BOOL reverse){
                    SumiFocusRow *row=makeRow(fragment,line);
                    refreshRow(active);
                    CGFloat anchor=active.rawOrigin.y+active.height/2;
                    CGFloat top=half+row.rawOrigin.y-anchor,bottom=top+row.height;
                    BOOL outside=reverse?bottom<0:top>view.bounds.size.height;
                    BOOL outsideStart=reverse?row.startOrigin.y+row.height<0:row.startOrigin.y>view.bounds.size.height;
                    if(outside && (!includeStart || outsideStart))return NO;
                    [rows addObject:row];return YES;
                };
                BOOL more=YES;
                for(NSUInteger n=activeIndex;n>0 && more;)more=append(current,lines[--n],YES);
                // The reverse iterator starts before the paragraph at location.
                if(more)[layout enumerateTextLayoutFragmentsFromLocation:location options:NSTextLayoutFragmentEnumerationOptionsReverse|NSTextLayoutFragmentEnumerationOptionsEnsuresLayout|NSTextLayoutFragmentEnumerationOptionsEnsuresExtraLineFragment usingBlock:^BOOL(NSTextLayoutFragment *fragment){
                    if(fragment==current)return YES;
                    for(NSTextLineFragment *line in fragment.textLineFragments.reverseObjectEnumerator)if(!append(fragment,line,YES))return NO;
                    return YES;
                }];
                more=YES;
                for(NSUInteger n=activeIndex+1;n<lines.count && more;n++)more=append(current,lines[n],NO);
                if(more)[layout enumerateTextLayoutFragmentsFromLocation:location options:NSTextLayoutFragmentEnumerationOptionsEnsuresLayout|NSTextLayoutFragmentEnumerationOptionsEnsuresExtraLineFragment usingBlock:^BOOL(NSTextLayoutFragment *fragment){
                    if(fragment==current)return YES;
                    for(NSTextLineFragment *line in fragment.textLineFragments)if(!append(fragment,line,NO))return NO;
                    return YES;
                }];
                // Candidate traversal can refine estimated paragraph frames.
                // Lay out its bounded range, commit the viewport, then discard
                // those objects and read one fresh snapshot without EnsuresLayout.
                NSUInteger first=self.string.length,last=0;
                for(SumiFocusRow *row in rows){first=MIN(first,row.range.location);last=MAX(last,NSMaxRange(row.range));}
                id<NSTextLocation> firstLocation=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)first];
                id<NSTextLocation> lastLocation=[content locationFromLocation:content.documentRange.location withOffset:(NSInteger)last];
                if(!firstLocation || !lastLocation){self.focusUpdating=NO;[self stopFocusTyping];return;}
                [layout ensureLayoutForRange:[[NSTextRange alloc]initWithLocation:firstLocation endLocation:lastLocation]];
                BOOL finalReporting=self.owner.reportingViewport;self.owner.reportingViewport=YES;
                [layout.textViewportLayoutController layoutViewport];self.owner.reportingViewport=finalReporting;
                NSMutableArray<SumiFocusRow *> *snapshot=[NSMutableArray new];
                __block BOOL available=YES;
                // Keep the prepared insertion line even when the document is empty.
                [layout enumerateTextLayoutFragmentsFromLocation:firstLocation options:NSTextLayoutFragmentEnumerationOptionsEnsuresExtraLineFragment usingBlock:^BOOL(NSTextLayoutFragment *fragment){
                    NSInteger offset=[content offsetFromLocation:content.documentRange.location toLocation:fragment.rangeInElement.location];
                    if((NSUInteger)MAX(0,offset)>last)return NO;
                    if(fragment.state!=NSTextLayoutFragmentStateLayoutAvailable){available=NO;return NO;}
                    NSArray<NSTextLineFragment *> *freshLines=fragment.textLineFragments;
                    NSUInteger low=0,high=freshLines.count;
                    while(low<high){NSUInteger mid=low+(high-low)/2;NSUInteger begin=(NSUInteger)MAX(0,offset)+freshLines[mid].characterRange.location;if(begin<=first)low=mid+1;else high=mid;}
                    for(NSUInteger n=low?low-1:0;n<freshLines.count;n++){
                        NSUInteger begin=(NSUInteger)MAX(0,offset)+freshLines[n].characterRange.location;
                        if(begin>last)break;
                        [snapshot addObject:makeRow(fragment,freshLines[n])];
                    }
                    return YES;
                }];
                SumiFocusRow *resolved=nil;
                for(SumiFocusRow *row in snapshot)if(row.range.location<=index)resolved=row;else break;
                if(!available || !resolved){self.focusUpdating=NO;[self stopFocusTyping];return;}
                rows=[NSMutableArray arrayWithObject:resolved];active=resolved;
                for(SumiFocusRow *row in snapshot.reverseObjectEnumerator)if(row.range.location<active.range.location)[rows addObject:row];
                for(SumiFocusRow *row in snapshot)if(row.range.location>active.range.location)[rows addObject:row];
                // Keep native glyphs, left edge and all native line spacing;
                // focus is one common vertical translation, never a font change.
                // Laying out a neighboring paragraph may refine earlier
                // estimated paragraph heights. Read every final fragment frame
                // again before computing the shared translation.
                for(SumiFocusRow *row in rows)refreshRow(row);
                activeMid=active.rawOrigin.y+active.height/2;
                CGFloat pitch=CGFLOAT_MAX;
                for(SumiFocusRow *row in rows){CGFloat distance=fabs(row.rawOrigin.y+row.height/2-activeMid);if(distance>.1)pitch=MIN(pitch,distance);}
                if(pitch==CGFLOAT_MAX)pitch=MAX(1,active.height);
                NSMutableDictionary<NSArray *,SumiFocusTile *> *nextRasterCache=[NSMutableDictionary new];BOOL rasterFailed=NO;
                for(SumiFocusRow *row in rows){
                    row.origin=NSMakePoint(row.startOrigin.x,half+row.rawOrigin.y-activeMid);
                    CGFloat distance=fabs(row.rawOrigin.y+row.height/2-activeMid),edge=distance/MAX(1,half);
                    row.alpha=pow(.55,distance/pitch)*MAX(0,1-edge*edge);
                    if(row!=active && (row.origin.y<=0 || row.origin.y+row.height>=view.bounds.size.height))row.alpha=0;
                    CGFloat scale=MAX(1,self.window.backingScaleFactor),padding=MAX(1,[self.owner.appearance[@"font_size"] doubleValue]);
                    NSArray *key=SumiFocusTileKey(row,scale,padding);
                    SumiFocusTile *tile=key?(nextRasterCache[key] ?: view.rasterCache[key]):nil;
                    if(!tile && key)tile=SumiCreateFocusTile(row,scale,padding);
                    if(!tile){rasterFailed=YES;break;}
                    row.rasterTile=tile;nextRasterCache[key]=tile;
                }
                if(rasterFailed){view.rasterCache=nil;view.rows=nil;self.focusUpdating=NO;[self stopFocusTyping];return;}
                // Retain only the just-visible viewport keys. No document-wide LRU.
                view.rasterCache=nextRasterCache;
            }
        }
        // Main-thread complete row batch; paint retains one batch reference.
        view.rows=rows;
        if(rows.count){
            if(!view.nativeScrollHidden){CALayer *native=self.owner.scroll.layer;view.nativeScrollOpacity=native?native.opacity:1;view.nativeScrollHidden=YES;}
            [CATransaction begin];[CATransaction setDisableActions:YES];self.owner.scroll.wantsLayer=YES;self.owner.scroll.layer.opacity=0;[CATransaction commit];
        }
        view.needsDisplay=YES;
    }
    self.focusUpdating=NO;
    if(view.rows.count==0){[self stopFocusTyping];return;}
    [self.inputContext invalidateCharacterCoordinates];[self refreshTypewriterCaret:NO];
}
- (SumiFocusRow *)focusRowForRect:(NSRect)rect {
    for(SumiFocusRow *row in self.focusView.rows){
        CGFloat bottom=row.rawOrigin.y+row.height;
        if(NSMidY(rect)>=row.rawOrigin.y-1 && NSMidY(rect)<=bottom+1)return row;
    }
    return self.focusView.rows.firstObject;
}
- (NSRect)focusRect:(NSRect)rect {
    SumiFocusView *view=self.focusView;SumiFocusRow *row=[self focusRowForRect:rect];if(!row)return rect;
    CGFloat p=view.progress;
    NSPoint origin=NSMakePoint(row.startOrigin.x+(row.origin.x-row.startOrigin.x)*p,row.startOrigin.y+(row.origin.y-row.startOrigin.y)*p);
    return NSMakeRect(origin.x+rect.origin.x-row.rawOrigin.x,origin.y+rect.origin.y-row.rawOrigin.y,rect.size.width,rect.size.height);
}
- (NSUInteger)focusCharacterIndexAtPoint:(NSPoint)point {
    NSPoint original=[self focusOriginalPoint:point];
    if(@available(macOS 13.0,*)){
        SumiFocusRow *row=[self focusRowForRect:NSMakeRect(original.x,original.y,0,0)];
        if(row){
            // Hit-test the same immutable laid-out line that is on screen. A
            // document-wide hit-test may re-estimate offscreen paragraph heights.
            NSInteger local=[row.line characterIndexForPoint:NSMakePoint(original.x-row.rawOrigin.x,original.y-row.rawOrigin.y)];
            NSInteger offset=MAX(0,local-(NSInteger)row.line.characterRange.location);
            return MIN(self.string.length,row.range.location+MIN(row.range.length,(NSUInteger)offset));
        }
    }
    return self.selectedRange.location;
}
- (NSPoint)focusOriginalPoint:(NSPoint)point {
    SumiFocusRow *nearest=nil;CGFloat distance=CGFLOAT_MAX;
    for(SumiFocusRow *row in self.focusView.rows){NSRect rect=[self focusRect:NSMakeRect(row.rawOrigin.x,row.rawOrigin.y,1,row.height)];CGFloat d=fabs(point.y-NSMidY(rect));if(d<distance){distance=d;nearest=row;}}
    if(!nearest)return [self convertPoint:point fromView:self.focusView];
    CGFloat p=self.focusView.progress;
    NSPoint origin=NSMakePoint(nearest.startOrigin.x+(nearest.origin.x-nearest.startOrigin.x)*p,nearest.startOrigin.y+(nearest.origin.y-nearest.startOrigin.y)*p);
    CGFloat x=nearest.rawOrigin.x+point.x-origin.x;
    CGFloat y=nearest.rawOrigin.y+point.y-origin.y;
    // Inter-line / outside whitespace belongs to its nearest visible row, never
    // to unlaid-out text beyond the viewport-sized presentation.
    y=MAX(nearest.rawOrigin.y+.1,MIN(y,nearest.rawOrigin.y+MAX(.2,nearest.height)-.1));
    x=MAX(self.textContainerOrigin.x,MIN(x,self.textContainerOrigin.x+self.textContainer.size.width));
    return NSMakePoint(x,y);
}
@end
