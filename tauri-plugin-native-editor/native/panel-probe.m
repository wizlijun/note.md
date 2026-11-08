// Real AppKit preedit/panel handoff; unordered window, no system IME activation.
#import "editor.m"
static NSMutableArray *events;
static BOOL rejectNext,canonicalNext;
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;NSDictionary *event=SumiJSON(json);[events addObject:event];
    if(![event[@"kind"] isEqualToString:@"edit"])return 0;
    if(rejectNext){rejectNext=NO;return -1;}
    if(canonicalNext){canonicalNext=NO;*reply=strdup("{\"document\":{\"text\":\"规范正文\",\"runs\":[]},\"selection\":{\"start\":4,\"length\":0}}");}
    return [event[@"base_revision"] longLongValue]+1;
}
static void freeReply(char *reply){free(reply);}
static NSUInteger editCount(void){NSUInteger count=0;for(NSDictionary *e in events)if([e[@"kind"] isEqualToString:@"edit"])count++;return count;}
@interface PanelProbeWindow : NSWindow
@property(nonatomic) BOOL refuseResign;
@end
@implementation PanelProbeWindow
- (BOOL)makeFirstResponder:(NSResponder *)responder { if(!responder && self.refuseResign)return NO;return [super makeFirstResponder:responder]; }
@end
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];events=[NSMutableArray new];
    PanelProbeWindow *window=[[PanelProbeWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"panel-probe\",\"generation\":1,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":760,\"height\":540},\"appearance\":{\"font_family\":\"Menlo\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#44413c\",\"background\":\"#f3ead7\",\"max_columns\":80,\"bottom_inset\":80},\"document\":{\"text\":\"甲乙😀\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,config,receive,freeReply,NULL);
    require(handle!=NULL,@"mount");SumiEditor *editor=(__bridge SumiEditor *)handle;
    const char *hide="{\"command\":\"set_visible\",\"visible\":false}";
    const char *show="{\"command\":\"set_visible\",\"visible\":true}";
    const char *panel="{\"command\":\"prepare_panel\"}";
    [editor.text setMarkedText:@"" selectedRange:NSMakeRange(0,0) replacementRange:NSMakeRange(0,0)];
    require(!editor.composing && !editor.text.hasMarkedText && editor.revision==0 && editCount()==0,@"empty preedit releases composition without edit or revision");
    [editor.text setMarkedText:@"你好" selectedRange:NSMakeRange(1,1) replacementRange:NSMakeRange(0,2)];
    require(editor.composing && editor.text.hasMarkedText && editCount()==0,@"preedit is not committed prematurely");
    require(sumi_editor_command(handle,hide)==1 && !editor.container.hidden && editor.text.hasMarkedText,@"background hide still rejects without touching preedit");
    require([window makeFirstResponder:editor.text] && window.firstResponder==editor.text,@"real responder established in unordered window");
    NSUInteger start=events.count;
    require(sumi_editor_command(handle,panel)==0,@"explicit panel commits and opens during composition");
    require(window.firstResponder!=editor.text,@"successful panel resigns actual editor first responder");
    printf("PANEL text=%s committed=%s revision=%llu edits=%lu events=%s\n",editor.text.string.UTF8String,editor.committed.UTF8String,(unsigned long long)editor.revision,(unsigned long)editCount(),[[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:events options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
    require([editor.text.string isEqualToString:@"你好😀"] && [editor.committed isEqualToString:editor.text.string] && editor.revision==1 && editCount()==1,@"selected replacement preserves displayed text in one accepted edit");
    require(editor.container.hidden && !editor.composing && !editor.text.hasMarkedText,@"hide only after composition finishes");
    require([events[start][@"kind"] isEqualToString:@"edit"] && [events[start+1][@"kind"] isEqualToString:@"composition"] && ![events[start+1][@"active"] boolValue],@"local commit precedes composition release for remote drain");
    require(sumi_editor_command(handle,panel)==0 && editCount()==1,@"repeated panel open does not replay edit");
    require(sumi_editor_command(handle,show)==0,@"return to writing");
    [editor.text setMarkedText:@"ni好" selectedRange:NSMakeRange(2,1) replacementRange:NSMakeRange(0,2)];
    NSString *preview=[editor.text.string copy];NSRange mark=editor.text.markedRange,selection=editor.text.selectedRange;
    rejectNext=YES;start=events.count;
    require(sumi_editor_command(handle,panel)==5,@"rejected commit reports panel failure");
    require(!editor.container.hidden && editor.composing && editor.text.hasMarkedText && [editor.text.string isEqualToString:preview] && NSEqualRanges(mark,editor.text.markedRange) && NSEqualRanges(selection,editor.text.selectedRange) && editor.revision==1,@"rejection preserves text, clause, revision and visible editor for retry");
    for(NSUInteger i=start;i<events.count;i++)require(!([events[i][@"kind"] isEqualToString:@"composition"] && ![events[i][@"active"] boolValue]),@"rejection does not release remote updates");
    require(sumi_editor_command(handle,panel)==0 && editor.revision==2 && [editor.committed isEqualToString:preview],@"retry commits retained preedit once");
    sumi_editor_command(handle,show);
    [editor.text setMarkedText:@"" selectedRange:NSMakeRange(0,0) replacementRange:NSMakeRange(0,2)];
    require(!editor.composing && !editor.text.hasMarkedText && editor.revision==3 && [editor.committed isEqualToString:@"好😀"],@"empty marked replacement commits an actual deletion once");
    [editor.text setMarkedText:@"候选" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(0,1)];
    canonicalNext=YES;
    require(sumi_editor_command(handle,panel)==0 && editor.revision==4 && [editor.text.string isEqualToString:@"规范正文"],@"accepted canonical projection may differ from displayed preedit");
    sumi_editor_command(handle,show);[editor beginComposition];
    require(!editor.text.hasMarkedText && sumi_editor_command(handle,panel)==0 && !editor.composing && editor.revision==4,@"stale composing flag without marked text can finish without duplicate edit");
    sumi_editor_command(handle,show);
    require([window makeFirstResponder:editor.text],@"restore real first responder");
    [editor.text setMarkedText:@"附加" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(4,0)];
    window.refuseResign=YES;
    require(sumi_editor_command(handle,panel)==5 && !editor.container.hidden && window.firstResponder==editor.text,@"denied focus handoff keeps visible editor");
    require(!editor.composing && !editor.text.hasMarkedText && editor.revision==5 && [editor.committed isEqualToString:@"规范正文附加"],@"text already accepted despite failed responder transition");
    window.refuseResign=NO;
    require(sumi_editor_command(handle,panel)==0 && editor.revision==5,@"focus-only retry has no duplicate edit");
    sumi_editor_detach(handle);
    printf("PASS: panel handoff, empty preedit, single commit, background barrier, reject/retry preservation, canonical projection, stale composition; no UI activation\n");
}}
