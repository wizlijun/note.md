// No installed tap, permission request, visible window or posted keyboard event.
#import "editor.m"
@interface SumiTypingProbeWindow : NSWindow
@property(nonatomic) BOOL simulatedVisible;
@end
@implementation SumiTypingProbeWindow
- (BOOL)isVisible { return self.simulatedVisible; }
- (BOOL)actuallyVisible { return [super isVisible]; }
@end
static NSMutableArray<NSNumber *> *roles;
static void require(BOOL ok,const char *message){if(!ok){fprintf(stderr,"FAIL: %s\n",message);exit(1);}}
static void sound(const char *surface,uint64_t generation,uint32_t role){require(strcmp(surface,"typing-probe")==0 && generation==9,"identity unchanged");[roles addObject:@(role)];}
static int64_t document(void *context,const char *json,char **reply){(void)context;(void)reply;NSDictionary *value=SumiJSON(json);return [value[@"kind"] isEqual:@"edit"]?[value[@"base_revision"] longLongValue]+1:0;}
static void releaseReply(char *value){free(value);}
int main(){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    roles=[NSMutableArray new];
    SumiTypingProbeWindow *window=[[SumiTypingProbeWindow alloc]initWithContentRect:NSMakeRect(0,0,800,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    const char *config="{\"surface_id\":\"typing-probe\",\"generation\":9,\"revision\":0,\"bounds\":{\"x\":0,\"y\":0,\"width\":760,\"height\":540},\"appearance\":{\"font_family\":\"Menlo\",\"font_size\":22,\"line_height\":1.6,\"foreground\":\"#eeeeee\",\"background\":\"#000000\",\"max_columns\":80,\"bottom_inset\":80,\"caret_motion\":\"steady\"},\"document\":{\"text\":\"hello 中文\",\"runs\":[]}}";
    void *handle=sumi_editor_mount((__bridge void *)window.contentView,0,config,document,releaseReply,NULL);require(handle!=NULL,"native mount");
    SumiEditor *editor=(__bridge SumiEditor *)handle;
    [window makeFirstResponder:editor.text];
    require(SumiTypingFocusedEditor(YES,window)==nil,"actual unordered window never eligible");
    // Inject only visibility/activity prerequisites; actual AppKit firstResponder and ancestry remain real.
    window.simulatedVisible=YES;
    require(SumiTypingFocusedEditor(YES,window)==editor,"real native first responder eligible with simulated foreground");
    require(SumiTypingFocusedEditor(NO,window)==nil && SumiTypingFocusedEditor(YES,nil)==nil,"inactive and absent key window excluded");
    NSView *other=[NSView new];[window.contentView addSubview:other];
    [window makeFirstResponder:nil];require(SumiTypingFocusedEditor(YES,window)==nil,"settings/empty responder excluded");
    [window makeFirstResponder:editor.text];editor.container.hidden=YES;require(SumiTypingFocusedEditor(YES,window)==nil,"hidden surface excluded");editor.container.hidden=NO;
    editor.detached=YES;require(SumiTypingFocusedEditor(YES,window)==nil,"detached excluded");editor.detached=NO;
    [window makeFirstResponder:editor.text];
    SumiTypingEnabled=YES;SumiTypingHandler=sound;
    [editor.text setMarkedText:@"zhong" selectedRange:NSMakeRange(2,0) replacementRange:NSMakeRange(0,0)];
    NSString *text=[editor.text.string copy];NSRange selection=editor.text.selectedRange,marked=editor.text.markedRange;uint64_t revision=editor.revision;
    require(SumiTypingFocusedEditor(YES,window)==editor && editor.composing,"IME remains eligible");
    SumiTypingHandle(editor,kCGEventKeyDown,0,NO,0);SumiTypingHandle(editor,kCGEventKeyDown,0,YES,0);SumiTypingHandle(editor,kCGEventKeyDown,0,NO,0);SumiTypingHandle(editor,kCGEventKeyUp,0,NO,0);
    require([roles isEqual:@[@0,@5]],"one initial key, no autorepeat/duplicate, release once");[roles removeAllObjects];
    for(NSNumber *code in @[@49,@36,@76,@51,@117]){SumiTypingHandle(editor,kCGEventKeyDown,code.unsignedShortValue,NO,0);SumiTypingHandle(editor,kCGEventKeyUp,code.unsignedShortValue,NO,0);}
    require([roles isEqual:@[@1,@6,@2,@5,@2,@5,@3,@5,@3,@5]],"space enter numpad enter both delete roles");[roles removeAllObjects];
    SumiTypingHandle(editor,kCGEventFlagsChanged,56,NO,NX_DEVICELSHIFTKEYMASK);
    SumiTypingHandle(editor,kCGEventFlagsChanged,60,NO,NX_DEVICELSHIFTKEYMASK|NX_DEVICERSHIFTKEYMASK);
    SumiTypingHandle(editor,kCGEventFlagsChanged,56,NO,NX_DEVICERSHIFTKEYMASK);
    SumiTypingHandle(editor,kCGEventFlagsChanged,56,NO,NX_DEVICERSHIFTKEYMASK);
    SumiTypingHandle(editor,kCGEventFlagsChanged,60,NO,0);
    require([roles isEqual:@[@4,@4,@5,@5]],"left/right modifiers independently tracked and duplicate ignored");[roles removeAllObjects];
    for(NSNumber *code in @[@54,@55,@56,@58,@59,@60,@61,@62,@63]){
        CGEventFlags mask=SumiTypingModifierMask(code.unsignedShortValue);require(mask!=0,"known modifier mask");
        SumiTypingHandle(editor,kCGEventFlagsChanged,code.unsignedShortValue,NO,mask);
        SumiTypingHandle(editor,kCGEventFlagsChanged,code.unsignedShortValue,NO,mask);
        SumiTypingHandle(editor,kCGEventFlagsChanged,code.unsignedShortValue,NO,0);
        require([roles isEqual:@[@4,@5]],"all modifier edges exactly once");[roles removeAllObjects];
    }
    SumiTypingHandle(editor,kCGEventFlagsChanged,57,NO,kCGEventFlagMaskAlphaShift);SumiTypingHandle(editor,kCGEventFlagsChanged,57,NO,0);
    require([roles isEqual:@[@4,@5]],"caps lock state change");[roles removeAllObjects];
    SumiTypingHandle(nil,kCGEventKeyDown,0,NO,0);require([roles isEqual:@[@7]],"focus loss stops and clears");[roles removeAllObjects];
    SumiTypingHandle(editor,kCGEventKeyUp,0,NO,0);require(roles.count==0,"orphan release after focus loss silent");
    require([editor.text.string isEqual:text] && NSEqualRanges(editor.text.selectedRange,selection) && NSEqualRanges(editor.text.markedRange,marked) && editor.revision==revision && editor.composing,"sound never mutates text marked range selection revision");
    require(SumiTypingReceive(NULL,kCGEventKeyDown,NULL,NULL)==NULL,"real inactive callback passes through and stays silent");
    [roles removeAllObjects];SumiTypingHandle(editor,kCGEventKeyDown,0,NO,0);sumi_typing_configure(0,NULL);
    require([roles isEqual:@[@0,@7]] && !SumiTypingTap && !SumiTypingSource,"disable stops without installing permission tap");
    window.simulatedVisible=NO;require(![window actuallyVisible] && !NSApp.isActive && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,"foreground untouched");
    [editor.text unmarkText];sumi_editor_detach(handle);
    printf("PASS: typing roles/repeat/modifiers/IME state, actual hidden AppKit responder tree safety, simulated foreground gate, stop/disable; no tap installed or permission requested\n");
}}
