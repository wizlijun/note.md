// Verify the actual shaped fonts, not only requested descriptor family names.
#import "editor.m"
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static BOOL covers(NSFont *font,UniChar character){CGGlyph glyph=0;return CTFontGetGlyphsForCharacters((__bridge CTFontRef)font,&character,&glyph,1)&&glyph!=0;}
static void assertFamily(NSFont *font,NSString *text,NSString *expected){
    NSAttributedString *value=[[NSAttributedString alloc] initWithString:text attributes:@{NSFontAttributeName:font}];
    CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)value);
    NSArray *runs=(__bridge NSArray *)CTLineGetGlyphRuns(line);require(runs.count>0,@"shaping produced glyph runs");
    for(id value in runs){
        CTRunRef run=(__bridge CTRunRef)value;
        CTFontRef actual=(CTFontRef)CFDictionaryGetValue(CTRunGetAttributes(run),kCTFontAttributeName);
        NSString *family=CFBridgingRelease(CTFontCopyFamilyName(actual));
        require([family isEqualToString:expected],[NSString stringWithFormat:@"'%@' shaped with %@, expected %@",text,family,expected]);
        printf("RUN %s => %s\n",text.UTF8String,family.UTF8String);
    }
    CFRelease(line);
}
int main(int argc,const char **argv){@autoreleasepool{
    require(argc==4,@"pass SpecialElite, ZhuqueFangsong and SourceHanSerif file paths");
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSArray *families=@[@"Special Elite",@"Zhuque Fangsong (technical preview)",@"Source Han Serif SC"];
    for(NSUInteger i=0;i<families.count;i++){
        char *error=NULL;int code=sumi_editor_register_font(argv[i+1],[families[i] UTF8String],&error);
        if(code){fprintf(stderr,"registration: %s\n",error?error:"unknown");sumi_editor_free_string(error);}
        require(code==0,@"register all trusted typewriter faces");
    }
    char *error=NULL;
    const char *cascade="{\"alias\":\"Sumi Typewriter\",\"families\":[\"Special Elite\",\"Zhuque Fangsong (technical preview)\",\"Source Han Serif SC\"]}";
    require(sumi_editor_register_cascade(cascade,&error)==0,@"register explicit ordered cascade");require(error==NULL,@"valid cascade has no error");
    SumiEditor *editor=[SumiEditor new];editor.appearance=@{@"font_family":@"Sumi Typewriter",@"font_size":@22};
    NSFont *font=[editor baseFont];require([font.familyName isEqualToString:@"Special Elite"],@"Latin stays on the typewriter primary face");
    assertFamily(font,@"Typewriter 1932",@"Special Elite");
    assertFamily(font,@"沉浸式写作中文",@"Zhuque Fangsong (technical preview)");
    NSFont *zhuque=[NSFont fontWithDescriptor:SumiRegisteredFonts[@"Zhuque Fangsong (technical preview)"] size:22];
    NSFont *sourceHan=[NSFont fontWithDescriptor:SumiRegisteredFonts[@"Source Han Serif SC"] size:22];
    BOOL found=NO;
    for(UniChar character=0x3400;character<0xa000;character++){
        if(!covers(font,character)&&!covers(zhuque,character)&&covers(sourceHan,character)){
            NSString *rare=[NSString stringWithCharacters:&character length:1];assertFamily(font,rare,@"Source Han Serif SC");found=YES;break;
        }
    }
    require(found,@"verified a real Source Han rare-character fallback");
    printf("PASS: actual CoreText runs use Special Elite Latin, Zhuque Chinese, and Source Han rare glyph fallback\n");
    return 0;
}}
