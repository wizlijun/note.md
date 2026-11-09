// Five already-laid-out visual lines. This layer never owns or edits document text.
@interface SumiFocusRow : NSObject
@property(nonatomic,strong) NSTextLineFragment *line API_AVAILABLE(macos(12.0));
@property(nonatomic) NSRange range;
@property(nonatomic) NSPoint rawOrigin, origin, startOrigin;
@property(nonatomic) CGFloat scale, alpha, baseline, height;
@end
@implementation SumiFocusRow
@end
@interface SumiFocusView : NSView
@property(nonatomic,weak) SumiTextView *text;
@property(nonatomic,copy) NSArray<SumiFocusRow *> *rows;
@property(nonatomic) CGFloat progress;
@property(nonatomic) CFTimeInterval started;
@property(nonatomic,strong) NSTimer *timer;
@end
@implementation SumiFocusView
- (BOOL)isFlipped {return YES;}
- (BOOL)isAccessibilityElement {return NO;}
- (NSView *)hitTest:(NSPoint)point {(void)point;return nil;}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;[self.text.backgroundColor setFill];NSRectFillUsingOperation(self.bounds,NSCompositingOperationSourceOver);
    CGContextRef ctx=NSGraphicsContext.currentContext.CGContext;
    if(@available(macOS 13.0,*))for(SumiFocusRow *row in self.rows){
        CGFloat p=self.progress,scale=1+(row.scale-1)*p;
        NSPoint origin=NSMakePoint(row.startOrigin.x+(row.origin.x-row.startOrigin.x)*p,row.startOrigin.y+(row.origin.y-row.startOrigin.y)*p);
        CGContextSaveGState(ctx);CGContextSetAlpha(ctx,1+(row.alpha-1)*p);
        CGContextTranslateCTM(ctx,origin.x,origin.y);CGContextScaleCTM(ctx,scale,scale);
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
- (void)dealloc {[self.timer invalidate];}
@end

@implementation SumiTextView (FocusTyping)
- (BOOL)focusEnabled {if(@available(macOS 13.0,*)){}else{return NO;}id value=self.owner.appearance[@"focus_typing"];return value ? [value boolValue] : YES;}
- (void)stopFocusTyping {
    self.focusInputCount=0;self.focusLastInput=0;self.focusFirstInput=0;
    SumiFocusView *view=self.focusView;if(!view)return;
    [view.timer invalidate];view.timer=nil;
    if(self.typewriterCaret.superview==view){[self.typewriterCaret removeFromSuperview];[self addSubview:self.typewriterCaret];}
    [view removeFromSuperview];self.focusView=nil;[self scrollRangeToVisible:self.selectedRange];[self.inputContext invalidateCharacterCoordinates];[self refreshTypewriterCaret:NO];
}
- (void)focusScrollNotification:(NSNotification *)notification {(void)notification;[self stopFocusTyping];}
- (void)recordFocusEvent:(NSEvent *)event {
    if(event.type!=NSEventTypeKeyDown || event.windowNumber!=self.window.windowNumber || event.isARepeat || event.timestamp==self.focusLastEvent)return;
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
- (void)recordFocusInputAt:(CFTimeInterval)time {
    if(![self focusEnabled] || !self.owner || self.owner.applying || self.owner.draftError || !self.isEditable || self.owner.detached || self.owner.container.hidden || self.window.firstResponder!=self)return;
    if(time-self.focusFirstInput>2 || time<self.focusLastInput)self.focusInputCount=0;
    if(!self.focusInputCount)self.focusFirstInput=time;
    self.focusLastInput=time;self.focusInputCount++;
    if(self.focusInputCount<4)return;
    BOOL entering=self.focusView==nil;
    if(entering){
        SumiFocusView *view=[[SumiFocusView alloc]initWithFrame:self.owner.container.bounds];view.text=self;view.wantsLayer=YES;
        view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;self.focusView=view;
        [self.owner.container addSubview:view positioned:NSWindowAbove relativeTo:self.owner.scroll];
        view.progress=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?1:0;
        view.started=CACurrentMediaTime();
    }
    [self updateFocusRows];
    if(entering && self.focusView && self.focusView.progress<1){
        __weak SumiTextView *weak=self;
        self.focusView.timer=[NSTimer scheduledTimerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer *timer){
            SumiTextView *text=weak;SumiFocusView *view=text.focusView;
            if(!view){[timer invalidate];return;}
            CGFloat t=MIN(1,(CACurrentMediaTime()-view.started)/.42);view.progress=t*t*(3-2*t);
            view.needsDisplay=YES;[text.inputContext invalidateCharacterCoordinates];[text refreshTypewriterCaret:NO];
            if(t>=1){[timer invalidate];view.timer=nil;}
        }];
    }
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
            BOOL (^appendFragment)(NSTextLayoutFragment *)=^BOOL(NSTextLayoutFragment *fragment){
                NSInteger start=[content offsetFromLocation:content.documentRange.location toLocation:fragment.rangeInElement.location];
                NSArray<NSTextLineFragment *> *lines=fragment.textLineFragments;
                NSUInteger lo=0,hi=lines.count;
                while(lo<hi){NSUInteger mid=lo+(hi-lo)/2;NSUInteger begin=(NSUInteger)MAX(0,start)+lines[mid].characterRange.location;if(begin<=index)lo=mid+1;else hi=mid;}
                while(lo>0){
                    NSTextLineFragment *line=lines[--lo];
                    NSUInteger lineStart=(NSUInteger)MAX(0,start)+line.characterRange.location;
                    SumiFocusRow *row=[SumiFocusRow new];row.line=line;row.range=NSMakeRange(lineStart,line.characterRange.length);
                    row.rawOrigin=NSMakePoint(self.textContainerOrigin.x+fragment.layoutFragmentFrame.origin.x+line.typographicBounds.origin.x,self.textContainerOrigin.y+fragment.layoutFragmentFrame.origin.y+line.typographicBounds.origin.y);
                    row.startOrigin=[view convertPoint:row.rawOrigin fromView:self];row.baseline=line.glyphOrigin.y;row.height=line.typographicBounds.size.height;
                    [rows addObject:row];if(rows.count==5)return NO;
                }
                return YES;
            };
            NSTextLayoutFragment *current=[layout textLayoutFragmentForLocation:location];
            BOOL more=current?appendFragment(current):YES;
            // Reverse enumeration begins before the fragment containing location.
            if(more)[layout enumerateTextLayoutFragmentsFromLocation:location options:NSTextLayoutFragmentEnumerationOptionsReverse|NSTextLayoutFragmentEnumerationOptionsEnsuresLayout|NSTextLayoutFragmentEnumerationOptionsEnsuresExtraLineFragment usingBlock:^BOOL(NSTextLayoutFragment *fragment){
                return fragment==current?YES:appendFragment(fragment);
            }];
        }
        CGFloat font=[self.owner baseFont].pointSize,width=self.textContainer.size.width;
        CGFloat available=MAX(1,view.bounds.size.width-24),zoom=MIN((font+2)/font,available/MAX(1,width));
        zoom=MIN(zoom,MAX(.1,view.bounds.size.height)/MAX(1,font*2.5));
        CGFloat wholeWidth=width*zoom,center=NSMidX(view.bounds);
        const CGFloat scales[]={1,.97,.93,.88,.82},alphas[]={1,.92,.74,.46,.20};
        CGFloat baseline=MAX(font*zoom,MIN(view.bounds.size.height*.57,view.bounds.size.height-font*zoom*2.5));
        CGFloat step=MAX(font*1.2,font*[self.owner.appearance[@"line_height"] doubleValue])*zoom;
        NSMutableArray *visible=[NSMutableArray new];
        for(NSUInteger n=0;n<rows.count;n++){
            SumiFocusRow *row=rows[n];row.scale=zoom*scales[n];row.alpha=alphas[n];
            // Scale every original x relative to the same whole paper column.
            row.origin=NSMakePoint(center-wholeWidth*scales[n]/2+(row.rawOrigin.x-self.textContainerOrigin.x)*row.scale,baseline-row.baseline*row.scale);
            if(row.origin.y<4 && n>0)break;
            [visible addObject:row];baseline-=MAX(step*scales[n],row.height*row.scale);
        }
        view.rows=visible;view.needsDisplay=YES;
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
    CGFloat p=view.progress,scale=1+(row.scale-1)*p;
    NSPoint origin=NSMakePoint(row.startOrigin.x+(row.origin.x-row.startOrigin.x)*p,row.startOrigin.y+(row.origin.y-row.startOrigin.y)*p);
    return NSMakeRect(origin.x+(rect.origin.x-row.rawOrigin.x)*scale,origin.y+(rect.origin.y-row.rawOrigin.y)*scale,rect.size.width*scale,rect.size.height*scale);
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
    CGFloat p=self.focusView.progress,scale=1+(nearest.scale-1)*p;
    NSPoint origin=NSMakePoint(nearest.startOrigin.x+(nearest.origin.x-nearest.startOrigin.x)*p,nearest.startOrigin.y+(nearest.origin.y-nearest.startOrigin.y)*p);
    CGFloat x=nearest.rawOrigin.x+(point.x-origin.x)/scale;
    CGFloat y=nearest.rawOrigin.y+(point.y-origin.y)/scale;
    // Inter-line / outside whitespace belongs to its nearest visible row, never
    // to the hidden text above or below the five-line presentation.
    y=MAX(nearest.rawOrigin.y+.1,MIN(y,nearest.rawOrigin.y+MAX(.2,nearest.height)-.1));
    x=MAX(self.textContainerOrigin.x,MIN(x,self.textContainerOrigin.x+self.textContainer.size.width));
    return NSMakePoint(x,y);
}
@end
