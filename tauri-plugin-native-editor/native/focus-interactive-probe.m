// Isolated manual AppKit probe: synthetic text in memory, no vault/backend/audio.
#import "editor.m"
static NSWindow *probeWindow;
static void *probeHandle;
static int64_t receive(void *context,const char *json,char **reply) {
    (void)context;(void)reply;NSDictionary *event=SumiJSON(json);
    if([event[@"kind"] isEqual:@"edit"])return [event[@"base_revision"] longLongValue]+1;
    if([event[@"action"] isEqual:@"fullscreen"])[probeWindow toggleFullScreen:nil];
    if([event[@"kind"] isEqual:@"copy"]){SumiEditor *editor=(__bridge SumiEditor *)probeHandle;NSRange range=SumiReadRange(event[@"range"]);if(NSMaxRange(range)<=editor.text.string.length){NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"clipboard_text":[editor.text.string substringWithRange:range]} options:0 error:nil];*reply=strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);}}
    return [event[@"revision"] longLongValue];
}
static void releaseReply(char *reply){free(reply);}
@interface FocusProbeDelegate : NSObject <NSApplicationDelegate,NSWindowDelegate>
@end
@implementation FocusProbeDelegate
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender{(void)sender;return YES;}
- (void)windowDidResize:(NSNotification *)notification {
    (void)notification;if(!probeHandle)return;SumiEditor *editor=(__bridge SumiEditor *)probeHandle;
    [editor setBounds:@{@"x":@0,@"y":@0,@"width":@(probeWindow.contentView.bounds.size.width),@"height":@(probeWindow.contentView.bounds.size.height)}];
}
- (void)applicationWillTerminate:(NSNotification *)notification{(void)notification;if(probeHandle)sumi_editor_detach(probeHandle);probeHandle=NULL;}
@end
int main(void){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    FocusProbeDelegate *delegate=[FocusProbeDelegate new];NSApp.delegate=delegate;
    NSMenu *menu=[NSMenu new];NSMenuItem *application=[NSMenuItem new];[menu addItem:application];NSMenu *appMenu=[NSMenu new];[appMenu addItemWithTitle:@"Quit Sumi Native Probe" action:@selector(terminate:) keyEquivalent:@"q"];application.submenu=appMenu;NSApp.mainMenu=menu;
    probeWindow=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,100,960,720) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    probeWindow.title=@"Sumi Native Probe — 合成草稿 · 等字号居中渐隐 / 连打聚焦 / 方向键与拖选阅读";probeWindow.delegate=delegate;
    probeWindow.collectionBehavior=NSWindowCollectionBehaviorFullScreenPrimary;
    NSString *paragraph=@"雨停以后，我把窗推开了一些，街道上的灯光映在湿润的石板上，像一封还没有写完的信。我坐回桌前，听见远处偶尔传来车轮经过的声音。白天那些纷乱的念头终于慢了下来，不再催促我立刻找到答案。The quiet rhythm of the keys carries each thought onto the page. 我只是沿着刚才的句子继续往下写，想起一个很久没有见面的人，也想起曾经走过的那条小路。夜色渐深，我仍想把这一刻认真写下。";
    NSString *body=[NSString stringWithFormat:@"%@\n\n%@\n\n%@",paragraph,paragraph,paragraph];
    NSDictionary *config=@{@"surface_id":@"isolated-focus-probe",@"generation":@1,@"revision":@0,@"bounds":@{@"x":@0,@"y":@0,@"width":@960,@"height":@720},@"appearance":@{@"font_family":@"Sumi System",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#45433f",@"background":@"#f3ebdd",@"max_columns":@60,@"bottom_inset":@0,@"caret_motion":@"breathing",@"focus_typing":@YES},@"document":@{@"text":body,@"runs":@[]}};
    NSData *json=[NSJSONSerialization dataWithJSONObject:config options:0 error:nil];NSString *encoded=[[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding];
    probeHandle=sumi_editor_mount((__bridge void *)probeWindow.contentView,0,encoded.UTF8String,receive,releaseReply,NULL);if(!probeHandle)return 1;
    SumiEditor *editor=(__bridge SumiEditor *)probeHandle;[editor.text setSelectedRange:NSMakeRange(body.length/2,0)];[editor.text scrollRangeToVisible:editor.text.selectedRange];
    [probeWindow center];[probeWindow makeKeyAndOrderFront:nil];[probeWindow makeFirstResponder:editor.text];[NSApp activateIgnoringOtherApps:YES];[NSApp run];
}}
