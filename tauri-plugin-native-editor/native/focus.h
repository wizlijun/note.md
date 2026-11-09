// Viewport-sized, already-laid-out visual lines. This layer never owns or edits document text.
@interface SumiFocusRow : NSObject
@property(nonatomic,strong) NSTextLineFragment *line API_AVAILABLE(macos(12.0));
@property(nonatomic,strong) NSTextLayoutFragment *fragment API_AVAILABLE(macos(12.0));
@property(nonatomic) NSRange range;
@property(nonatomic) NSPoint rawOrigin, origin, startOrigin;
@property(nonatomic) CGFloat alpha, height;
@end
@implementation SumiFocusRow
@end
@interface SumiFocusView : NSView
@property(nonatomic,weak) SumiTextView *text;
@property(nonatomic,copy) NSArray<SumiFocusRow *> *rows;
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
    if(@available(macOS 13.0,*))for(SumiFocusRow *row in self.rows){
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
        [row.line drawAtPoint:NSZeroPoint inContext:ctx];CGContextRestoreGState(ctx);
    }
}
- (void)dealloc {[self.timer invalidate];[self.idleTimer invalidate];}
@end

@implementation SumiTextView (FocusTyping)
- (BOOL)focusEnabled {if(@available(macOS 13.0,*)){}else{return NO;}id value=self.owner.appearance[@"focus_typing"];return value ? [value boolValue] : YES;}
- (void)stopFocusTyping {
    self.focusInputCount=0;self.focusLastInput=0;self.focusFirstInput=0;
    SumiFocusView *view=self.focusView;if(!view)return;
    [view.timer invalidate];view.timer=nil;[view.idleTimer invalidate];view.idleTimer=nil;
    if(self.typewriterCaret.superview==view){[self.typewriterCaret removeFromSuperview];[self addSubview:self.typewriterCaret];}
    [view removeFromSuperview];self.focusView=nil;[self scrollRangeToVisible:self.selectedRange];[self.inputContext invalidateCharacterCoordinates];[self refreshTypewriterCaret:NO];
}
- (void)focusScrollNotification:(NSNotification *)notification {(void)notification;[self stopFocusTyping];}
- (void)recordFocusEvent:(NSEvent *)event {
    if(event.type!=NSEventTypeKeyDown || event.windowNumber!=self.window.windowNumber || event.timestamp==self.focusLastEvent)return;
    if(event.isARepeat && (!self.focusView || !self.focusInputChanged))return;
    if(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))return;
    if(event.keyCode==123 || event.keyCode==124 || event.keyCode==125 || event.keyCode==126 || event.keyCode==115 || event.keyCode==119 || event.keyCode==116 || event.keyCode==121 || event.keyCode==53)return;
    self.focusLastEvent=event.timestamp;[self recordFocusInputAt:CACurrentMediaTime()];
}
- (void)focusMutationFinished {
    if(self.caretInputDepth || self.focusKeyDepth || self.owner.applying)return;
    NSEvent *event=NSApp.currentEvent;
    if(event && fabs(NSProcessInfo.processInfo.systemUptime-event.timestamp)<.5)[self recordFocusEvent:event];
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
    if(!self.focusView && self.focusInputCount<4)return;
    BOOL entering=self.focusView==nil;
    if(entering){
        SumiFocusView *view=[[SumiFocusView alloc]initWithFrame:self.owner.container.bounds];view.text=self;view.wantsLayer=YES;
        view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;self.focusView=view;
        [self.owner.container addSubview:view positioned:NSWindowAbove relativeTo:self.owner.scroll];
        view.progress=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?1:0;
    }
    [self updateFocusRows];
    SumiFocusView *view=self.focusView;if(!view)return;
    view.lastActivity=CACurrentMediaTime();[self scheduleFocusIdle];
    if(entering || view.targetStrength!=1)[self animateFocusStrength:1 duration:.2];
}
- (void)updateFocusRows {
    SumiFocusView *view=self.focusView;if(!view || self.focusUpdating || self.focusTracking)return;
    if(![self focusEnabled] || self.owner.draftError || !self.isEditable || self.owner.detached || self.owner.container.hidden){[self stopFocusTyping];return;}
    self.focusUpdating=YES;
    if(@available(macOS 13.0,*)){
        NSTextLayoutManager *layout=self.textLayoutManager;NSTextContentManager *content=layout.textContentManager;
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
                for(SumiFocusRow *row in rows){
                    row.origin=NSMakePoint(row.startOrigin.x,half+row.rawOrigin.y-activeMid);
                    CGFloat distance=fabs(row.rawOrigin.y+row.height/2-activeMid),edge=distance/MAX(1,half);
                    row.alpha=pow(.55,distance/pitch)*MAX(0,1-edge*edge);
                    if(row!=active && (row.origin.y<=0 || row.origin.y+row.height>=view.bounds.size.height))row.alpha=0;
                }
            }
        }
        view.rows=rows;view.needsDisplay=YES;
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
