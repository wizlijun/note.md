@implementation SumiTextView (Candidates)
- (NSString *)candidateGeneration {
    if(!self.owner || self.owner.detached || !self.owner.focusDocumentReady || self.owner.draftError
       || ![self caretSurfaceActive] || self.window.firstResponder!=self)return nil;
    return [NSString stringWithFormat:@"%llu",(unsigned long long)self.owner.generation];
}
- (void)ensureCandidateBridge {
    if(self.candidateBridge)return;
    SumiCandidatesBridge *bridge=[SumiCandidatesBridge new];self.candidateBridge=bridge;
    __weak SumiTextView *weak=self;
    bridge.eligible=^NSString *{return [weak candidateGeneration];};
    bridge.prepare=^BOOL(NSDictionary *snapshot){
        SumiTextView *text=weak;if(!text)return NO;
        // Keep an already-owned overlay through successive snapshots. The
        // bridge disables clicks until present; removing the gap each key
        // would make lower focus rows flash in and out of the candidate area.
        text.candidateSnapshot=snapshot;text.candidateLayoutKey=nil;
        return [text updateCandidateLayout];
    };
    bridge.present=^{SumiTextView *text=weak;text.candidatePresented=YES;[text updateCandidateLayout];[text refreshTypewriterCaret:NO];};
    bridge.clear=^{
        SumiTextView *text=weak;text.candidatePresented=NO;text.candidateSnapshot=nil;text.candidateLayoutKey=nil;text.candidateGap=0;
        text.candidateView.hidden=YES;[text.candidateView clear];text.focusView.needsDisplay=YES;
        if(!text.hasMarkedText && text.candidateNormalSelection){text.selectedTextAttributes=text.candidateNormalSelection;text.candidateNormalSelection=nil;}
        [text queueCaretRefresh];
    };
}
- (CGFloat)candidateOffsetForRow:(SumiFocusRow *)row {
    SumiFocusRow *active=self.focusView.rows.firstObject;
    return active && row.rawOrigin.y>active.rawOrigin.y+.1?self.candidateGap:0;
}
- (BOOL)updateCandidateLayout {
    if(self.candidateUpdating)return self.candidateView!=nil;
    if(!self.candidateSnapshot || !self.owner)return YES;
    self.candidateUpdating=YES;
    if(![self candidateGeneration]){[self.candidateBridge releaseLease];self.candidateUpdating=NO;return NO;}
    if(!self.candidateView){
        self.candidateView=[[SumiCandidatesView alloc]initWithFrame:NSZeroRect];self.candidateView.hidden=YES;
        __weak SumiTextView *weak=self;
        self.candidateView.selectCandidate=^(NSInteger index){[weak.candidateBridge selectIndex:index];};
        self.candidateView.pageCandidates=^(BOOL next){[weak.candidateBridge pageNext:next];};
        self.candidateView.layoutChanged=^{[weak updateCandidateLayout];[weak refreshTypewriterCaret:NO];};
        [self.owner.container addSubview:self.candidateView positioned:NSWindowAbove relativeTo:nil];
    }
    NSView *container=self.owner.container;
    NSRect viewport=[container convertRect:self.owner.scroll.contentView.bounds fromView:self.owner.scroll.contentView];
    viewport=NSIntersectionRect(viewport,container.bounds);
    CGFloat left=[container convertPoint:NSMakePoint(self.textContainerOrigin.x,0) fromView:self].x;
    CGFloat width=MIN(self.textContainer.size.width,NSMaxX(viewport)-left);
    NSDictionary *attributes=[self.owner baseAttributes];NSFont *font=attributes[NSFontAttributeName];
    CGFloat lineHeight=[[NSLayoutManager new]defaultLineHeightForFont:font]*[self.owner.appearance[@"line_height"] doubleValue];
    SumiFocusRow *active=self.focusView.rows.firstObject;
    CGFloat top=NSMaxY(viewport),maxHeight=viewport.size.height;
    if(active){
        CGFloat pitch=CGFLOAT_MAX;
        for(SumiFocusRow *row in self.focusView.rows){CGFloat distance=fabs(row.rawOrigin.y-active.rawOrigin.y);if(distance>.1)pitch=MIN(pitch,distance);}
        if(pitch!=CGFLOAT_MAX)lineHeight=pitch;
        NSRect rowRect=[self focusRect:NSMakeRect(active.rawOrigin.x,active.rawOrigin.y,1,active.height)];
        top=MAX(NSMinY(viewport),rowRect.origin.y+MAX(active.height,lineHeight));maxHeight=MAX(0,NSMaxY(viewport)-top);
    }
    NSArray *key=@[@(width),@(maxHeight),@(lineHeight),attributes];
    BOOL okay=YES;
    if(![self.candidateLayoutKey isEqual:key]){
        okay=[self.candidateView prepareSnapshot:self.candidateSnapshot attributes:attributes lineHeight:lineHeight width:width maxHeight:maxHeight];
        if(okay)self.candidateLayoutKey=key;
    }
    if(!okay){[self.candidateBridge releaseLease];self.candidateUpdating=NO;return NO;}
    CGFloat height=self.candidateView.contentHeight;
    self.candidateView.backgroundColor=self.backgroundColor;
    self.candidateView.frame=NSMakeRect(left,active?top:NSMaxY(viewport)-height,MAX(0,width),height);
    self.candidateView.hidden=!self.candidatePresented || height<=0;
    CGFloat gap=active && !self.candidateView.hidden?height:0;
    if(self.candidateGap!=gap){self.candidateGap=gap;self.focusView.needsDisplay=YES;}
    self.candidateUpdating=NO;return YES;
}
@end
