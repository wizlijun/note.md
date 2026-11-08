// Synthetic data and a private pasteboard only; never reads generalPasteboard.
// Build (macOS): xcrun clang -fobjc-arc -Wall -Wextra -Werror
// -Wno-unused-parameter -Wno-nullability-completeness -framework Cocoa
// -framework QuartzCore -framework CoreText clipboard-probe.m -o /tmp/clipboard-probe
// Run the binary without activating or displaying a window.
#import "editor.m"
static NSDictionary *lastEvent;
static NSUInteger cutCount;
static void require(BOOL ok, NSString *message){if(!ok){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static int64_t receive(void *context,const char *json,char **reply){
    (void)context;lastEvent=SumiJSON(json);
    if([lastEvent[@"kind"] isEqualToString:@"clipboard"]){
        if([lastEvent[@"cut"] boolValue])cutCount++;
        else if(reply)*reply=strdup("{\"clipboard_text\":\"**选中**\\n[link](https://example.com)\"}");
    }
    return 1;
}
static void freeReply(char *reply){free(reply);}
@interface FailingClipboard : NSObject @end
@implementation FailingClipboard
- (NSInteger)clearContents{return 0;}
- (BOOL)setString:(NSString *)value forType:(NSPasteboardType)type{(void)value;(void)type;return NO;}
@end
int main(){@autoreleasepool{
    [NSApplication sharedApplication];
    SumiTextView *text=[[SumiTextView alloc]initUsingTextLayoutManager:YES];
    SumiEditor *owner=[SumiEditor new];owner.text=text;text.owner=owner;owner.surfaceID=@"clipboard-probe";owner.generation=1;owner.revision=1;owner.callback=receive;owner.freeReply=freeReply;
    text.string=@"选中 link";text.selectedRange=NSMakeRange(0,2);
    NSPasteboard *pb=[NSPasteboard pasteboardWithUniqueName];
    require([text writeMarkdownToPasteboard:pb cut:NO],@"copy accepted");
    require([[pb stringForType:NSPasteboardTypeString] isEqualToString:@"**选中**\n[link](https://example.com)"],@"copy is canonical Markdown");
    require([pb.types containsObject:NSPasteboardTypeString] && ![pb availableTypeFromArray:@[NSPasteboardTypeRTF,NSPasteboardTypeRTFD,NSPasteboardTypeHTML,NSPasteboardTypePNG,NSPasteboardTypeTIFF]],@"only plain text aliases, no rich formats, are written");
    require([text writeMarkdownToPasteboard:pb cut:YES] && cutCount==1,@"cut follows successful clipboard write");
    require(![text writeMarkdownToPasteboard:(NSPasteboard *)(id)[FailingClipboard new] cut:YES] && cutCount==1,@"failed clipboard write never deletes source");
    [pb clearContents];[pb setString:@"**plain wins**" forType:NSPasteboardTypeString];[pb setString:@"<b>wrong</b>" forType:NSPasteboardTypeHTML];
    [text pasteFromPasteboard:pb];require([lastEvent[@"text"] isEqualToString:@"**plain wins**"] && lastEvent[@"html"]==NSNull.null,@"plain wins over HTML");
    [pb clearContents];[pb setString:@"**literal**\r\n" forType:NSPasteboardTypeString];
    text.string=@"";text.selectedRange=NSMakeRange(0,0);[text pastePlainFromPasteboard:pb];
    require([lastEvent[@"text"] isEqualToString:@"**literal**\r\n"] && [lastEvent[@"literal"] boolValue],@"explicit plain paste marks literal input for host normalization");
    [pb clearContents];[pb setString:@"<p style='color:red'>only HTML</p>" forType:NSPasteboardTypeHTML];
    [text pasteFromPasteboard:pb];require(lastEvent[@"text"]==NSNull.null && [lastEvent[@"html"] hasPrefix:@"<p"],@"HTML-only sent to tokenizer");
    [text pastePlainFromPasteboard:pb];require([lastEvent[@"literal"] boolValue] && [lastEvent[@"html"] hasPrefix:@"<p"],@"explicit plain HTML-only uses the shared extractor");
    NSAttributedString *rich=[[NSAttributedString alloc]initWithString:@"RTF 中文" attributes:@{NSFontAttributeName:[NSFont boldSystemFontOfSize:60],NSForegroundColorAttributeName:NSColor.redColor}];
    [pb clearContents];[pb setData:[rich RTFFromRange:NSMakeRange(0,rich.length) documentAttributes:@{}] forType:NSPasteboardTypeRTF];
    [text pasteFromPasteboard:pb];require([lastEvent[@"text"] isEqualToString:@"RTF 中文"],@"RTF-only extracts string and discards style");
    [text pastePlainFromPasteboard:pb];require([lastEvent[@"literal"] boolValue] && [lastEvent[@"text"] isEqualToString:@"RTF 中文"],@"explicit plain RTF-only extracts string");
    [pb clearContents];[pb setString:@"file:///tmp/synthetic.txt" forType:NSPasteboardTypeFileURL];
    [text pasteFromPasteboard:pb];require([lastEvent[@"text"] isEqualToString:@"[文件: file:///tmp/synthetic.txt]"],@"file URL is text without opening file");
    [text pastePlainFromPasteboard:pb];require([lastEvent[@"literal"] boolValue] && [lastEvent[@"text"] hasPrefix:@"[文件: "],@"explicit plain file URL text");
    [pb clearContents];[pb setData:[NSData dataWithBytes:"png" length:3] forType:NSPasteboardTypePNG];
    [text pasteFromPasteboard:pb];require([lastEvent[@"text"] isEqualToString:@"[图片]"],@"image is placeholder, never an attachment");
    [text pastePlainFromPasteboard:pb];require([lastEvent[@"literal"] boolValue] && [lastEvent[@"text"] isEqualToString:@"[图片]"],@"explicit plain image placeholder");
    [pb clearContents];[pb setData:[@"invalid RTF" dataUsingEncoding:NSUTF8StringEncoding] forType:NSPasteboardTypeRTF];
    [text pasteFromPasteboard:pb];require([lastEvent[@"kind"] isEqualToString:@"paste"],@"malformed RTF does not crash and reaches recoverable host rejection");
    owner.composing=YES;NSDictionary *before=lastEvent;[text pasteFromPasteboard:pb];require(lastEvent==before,@"composition is not interrupted");
    [pb releaseGlobally];printf("PASS: private-pasteboard Markdown copy/cut, write-failure safety, plain/HTML/RTF priority, file/image text, composition gate\n");
}}
