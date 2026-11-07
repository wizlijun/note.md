// Process-scoped font registration and actual NSTextView family verification.
#import "editor.m"
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
int main(int argc,const char **argv){@autoreleasepool{
    require(argc==2,@"pass the fixed bundled SourceHanSerifSC-Regular.otf path");
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    char *error=NULL;
    require(sumi_editor_register_font("/nonexistent/sumi-font.otf","Source Han Serif SC",&error)!=0,@"missing resource rejects");
    require(error!=NULL,@"missing resource explains failure");sumi_editor_free_string(error);error=NULL;
    require(sumi_editor_register_font(argv[1],"Not The Bundled Family",&error)!=0,@"wrong family rejects");
    require(error!=NULL,@"family mismatch explains failure");sumi_editor_free_string(error);error=NULL;
    require(sumi_editor_register_font(argv[1],"Source Han Serif SC",&error)==0,@"bundled font registers in process");
    require(error==NULL,@"successful registration has no error");
    require(sumi_editor_register_font(argv[1],"Source Han Serif SC",&error)==0,@"registration is idempotent");
    SumiEditor *editor=[SumiEditor new];editor.appearance=@{@"font_family":@"Source Han Serif SC",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#111111"};
    NSFont *font=[editor baseFont];
    require([font.familyName isEqualToString:@"Source Han Serif SC"],@"editor actually resolves bundled family");
    require([font.fontName isEqualToString:@"SourceHanSerifSC-Regular"],@"editor actually resolves regular face");
    NSTextView *text=[[NSTextView alloc] initWithFrame:NSMakeRect(0,0,640,480)];
    [text.textStorage setAttributedString:[[NSAttributedString alloc] initWithString:@"沉浸式写作 Sumi 😀" attributes:@{NSFontAttributeName:font}]];
    NSFont *actual=[text.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    require([actual.familyName isEqualToString:@"Source Han Serif SC"],@"NSTextView attributed storage carries the intended family");
    editor.text=(SumiTextView *)text;editor.runs=@[@{@"range":@{@"start":@0,@"length":@5},@"bold":@YES,@"italic":@YES}];
    [editor styleRanges:[NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0,text.string.length)]];
    actual=[text.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    require([actual.familyName isEqualToString:@"Source Han Serif SC"],@"rich styles preserve unified family");
    require(([NSFontManager.sharedFontManager traitsOfFont:actual]&NSBoldFontMask) || [[text.textStorage attribute:NSStrokeWidthAttributeName atIndex:0 effectiveRange:NULL] doubleValue]<0,@"bold uses native face or explicit synthesis");
    require(([NSFontManager.sharedFontManager traitsOfFont:actual]&NSItalicFontMask) || [[text.textStorage attribute:NSObliquenessAttributeName atIndex:0 effectiveRange:NULL] doubleValue]>0,@"italic uses native face or explicit synthesis");
    printf("PASS: process-scoped bundled registration, missing/mismatched rejection, repeat registration, actual family=%s face=%s\n",actual.familyName.UTF8String,actual.fontName.UTF8String);
    return 0;
}}
