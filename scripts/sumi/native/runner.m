// Same production AppKit implementation; this runner does not modify its code.
// Programmatic insertText + forced viewport layout only. No hardware event or
// compositor present timestamp is inferred from these intervals.
#import "editor.m"
#import <QuartzCore/QuartzCore.h>
#import <sys/resource.h>
static void require(BOOL ok,NSString *message){if(!ok){fprintf(stderr,"benchmark: %s\n",message.UTF8String);abort();}}
static double clockMs(void){return CACurrentMediaTime()*1000.;}
char *sumi_bench_run(const char *config,const char *fixture,const char *fontRoot,
                    int warmup,int samples,int intervalMs,SumiEventCallback callback,SumiReplyFree freeReply,void *context){
@autoreleasepool {
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSString *root=[NSString stringWithUTF8String:fontRoot];
    NSArray *files=@[@"CourierPrime-Regular.ttf",@"ZhuqueFangsong-Regular.ttf",@"SourceHanSerifSC-Regular.otf"];
    NSArray *families=@[@"Courier Prime",@"Zhuque Fangsong (technical preview)",@"Source Han Serif SC"];
    for(NSUInteger i=0;i<files.count;i++){
        char *error=NULL;int result=sumi_editor_register_font([[root stringByAppendingPathComponent:files[i]] UTF8String],[families[i] UTF8String],&error);
        if(error){fprintf(stderr,"font: %s\n",error);sumi_editor_free_string(error);}require(result==0,@"font registration");
    }
    char *error=NULL;require(sumi_editor_register_cascade("{\"alias\":\"Sumi Typewriter\",\"families\":[\"Courier Prime\",\"Zhuque Fangsong (technical preview)\",\"Source Han Serif SC\"]}",&error)==0,@"font cascade");
    if(error)sumi_editor_free_string(error);
    NSDictionary *data=SumiJSON(fixture);NSArray *markers=data[@"markers"],*sequence=data[@"input_sequence"];
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,650) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    NSView *reference=window.contentView;
    double mountStart=clockMs();
    void *handle=sumi_editor_mount((__bridge void *)reference,0,config,callback,freeReply,context);
    require(handle!=NULL,@"production native mount");
    SumiEditor *editor=(__bridge SumiEditor *)handle;
    [editor.text.textLayoutManager.textViewportLayoutController layoutViewport];
    double mountMs=clockMs()-mountStart;
    require(editor.text.textLayoutManager!=nil,@"TextKit 2 required");
    NSString *initial=[editor.text.string copy];
    NSString *expected=initial;
    NSMutableArray *results=[NSMutableArray new];
    double warmStart=clockMs(),warmMs=0.;
    for(int i=0;i<warmup+samples;i++){@autoreleasepool{
        if(i==warmup)warmMs=clockMs()-warmStart;
        NSString *marker=markers[(NSUInteger)i%markers.count],*text=sequence[(NSUInteger)i%sequence.count];
        double start=clockMs();
        NSRange where=[editor.text.string rangeOfString:marker];require(where.location!=NSNotFound,@"marker remains in text");
        [editor.text insertText:text replacementRange:NSMakeRange(where.location,0)];
        double returned=clockMs();
        [editor.text scrollRangeToVisible:NSMakeRange(where.location+text.length,0)];
        [editor.text.textLayoutManager.textViewportLayoutController layoutViewport];
        [window.contentView layoutSubtreeIfNeeded];
        double laidOut=clockMs();
        NSRange expectedWhere=[expected rangeOfString:marker];
        expected=[expected stringByReplacingCharactersInRange:NSMakeRange(expectedWhere.location,0) withString:text];
        if(i>=warmup){
            [results addObject:@{@"insertText_return_ms":@(returned-start),@"insertText_plus_viewport_layout_ms":@(laidOut-start),@"viewport_layout_ms":@(laidOut-returned)}];
            // Process AppKit runloop callbacks at the same nominal 10Hz input rate.
            double remaining=MAX(0.,(double)intervalMs-(clockMs()-start));
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:remaining/1000.]];
        }
    }}
    require([editor.text.string isEqualToString:expected],@"exact expected text after all inserts");
    struct rusage usage;getrusage(RUSAGE_SELF,&usage);
    NSDictionary *result=@{@"mount_ms":@(mountMs),@"warmup_ms":@(warmMs),@"raw":results,@"correctness":@{@"exact_text":@YES,@"initial_visible_utf16":@(initial.length),@"final_visible_utf16":@(editor.text.string.length)},@"textkit2":@YES,@"requested_font_family":@"Sumi Typewriter",@"actual_primary_family":[editor baseFont].familyName,@"rss_peak_bytes":@(usage.ru_maxrss),@"final_text":editor.text.string,@"window_visible":@(window.visible)};
    NSData *json=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    char *answer=strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    sumi_editor_detach(handle);[window close];
    return answer;
}}
void sumi_bench_free(char *value){free(value);}
