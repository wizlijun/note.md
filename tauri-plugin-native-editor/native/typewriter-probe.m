// Verify production baseFont shaping with exact faces, not only descriptors.
#import "editor.m"
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static BOOL covers(NSFont *font,UniChar character){CGGlyph glyph=0;return CTFontGetGlyphsForCharacters((__bridge CTFontRef)font,&character,&glyph,1)&&glyph!=0;}
static void assertFace(NSFont *font,NSString *text,NSString *expected,BOOL light){
    NSAttributedString *value=[[NSAttributedString alloc] initWithString:text attributes:@{NSFontAttributeName:font}];
    CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)value);
    NSArray *runs=(__bridge NSArray *)CTLineGetGlyphRuns(line);require(runs.count>0,@"shaping produced glyph runs");
    for(id value in runs){
        CTRunRef run=(__bridge CTRunRef)value;
        CTFontRef actual=(CTFontRef)CFDictionaryGetValue(CTRunGetAttributes(run),kCTFontAttributeName);
        NSString *face=CFBridgingRelease(CTFontCopyPostScriptName(actual));
        require([face isEqualToString:expected],[NSString stringWithFormat:@"'%@' shaped with %@, expected %@",text,face,expected]);
        require(!(CTFontGetSymbolicTraits(actual)&(kCTFontBoldTrait|kCTFontItalicTrait)),@"plain text has no synthetic bold or italic");
        NSDictionary *traits=CFBridgingRelease(CTFontCopyTraits(actual));
        if(light)require([traits[(__bridge NSString *)kCTFontWeightTrait] doubleValue]<0,@"actual Light run retains a negative CoreText weight");
        CFIndex count=CTRunGetGlyphCount(run);CGGlyph *glyphs=calloc((size_t)count,sizeof(CGGlyph));CTRunGetGlyphs(run,CFRangeMake(0,0),glyphs);
        for(CFIndex i=0;i<count;i++)require(glyphs[i]!=0,@"no missing glyphs");free(glyphs);
        printf("RUN %s => %s weight=%g\n",text.UTF8String,face.UTF8String,[traits[(__bridge NSString *)kCTFontWeightTrait] doubleValue]);
    }
    CFRelease(line);
}
int main(int argc,const char **argv){@autoreleasepool{
    require(argc==2,@"pass absolute resources/sumi directory");
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *directory=[NSString stringWithUTF8String:argv[1]];
    require(directory.isAbsolutePath,@"resource directory is absolute");
    NSArray *registrations=@[
        @[@"CourierPrime-Regular.ttf",@"Courier Prime"],
        @[@"ZhuqueFangsong-Regular.ttf",@"Zhuque Fangsong (technical preview)"],
        @[@"SourceHanSerifSC-Regular.otf",@"Source Han Serif SC"],
        @[@"SourceHanSerifSC-Regular.otf",@"SourceHanSerifSC-Regular"],
        @[@"IBMPlexMono-Light.ttf",@"IBMPlexMono-Light"],
        @[@"IBMPlexSansSC-Light.otf",@"IBMPlexSansSC-Light"],
        @[@"LXGWWenKaiMonoLite-Regular.ttf",@"LXGWWenKaiMonoLite-Regular"],
        @[@"SpecialElite-Regular.ttf",@"SpecialElite-Regular"],
        @[@"YouyouYisong.ttf",@"youyou-yisong"]];
    for(NSArray *registration in registrations){
        char *error=NULL;
        int code=sumi_editor_register_font([[directory stringByAppendingPathComponent:registration[0]] UTF8String],[registration[1] UTF8String],&error);
        if(code){fprintf(stderr,"registration: %s\n",error?error:"unknown");sumi_editor_free_string(error);}
        require(code==0,@"register all fixed writing faces");
    }
    char *wrongError=NULL;
    require(sumi_editor_register_font([[directory stringByAppendingPathComponent:@"IBMPlexMono-Light.ttf"] UTF8String],"IBMPlexMono-Regular",&wrongError)!=0,@"Light file cannot register as Regular");
    sumi_editor_free_string(wrongError);
    NSDictionary *cascades=@{
        @"Sumi Typewriter":@[@"Courier Prime",@"Zhuque Fangsong (technical preview)",@"Source Han Serif SC"],
        @"Sumi Plex":@[@"IBMPlexMono-Light",@"IBMPlexSansSC-Light",@"SourceHanSerifSC-Regular"],
        @"Sumi WenKai":@[@"LXGWWenKaiMonoLite-Regular",@"SourceHanSerifSC-Regular"],
        @"Sumi Elite":@[@"SpecialElite-Regular",@"youyou-yisong",@"SourceHanSerifSC-Regular"]};
    NSDictionary *expected=@{
        @"Sumi Typewriter":@[@"CourierPrime-Regular",@"ZhuqueFangsong-Regular"],
        @"Sumi Plex":@[@"IBMPlexMono-Light",@"IBMPlexSansSC-Light"],
        @"Sumi WenKai":@[@"LXGWWenKaiMonoLite-Regular",@"LXGWWenKaiMonoLite-Regular"],
        @"Sumi Elite":@[@"SpecialElite-Regular",@"youyou-yisong"]};
    for(NSString *alias in cascades){
        NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"alias":alias,@"families":cascades[alias]} options:0 error:nil];
        char *error=NULL;NSString *config=[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        require(sumi_editor_register_cascade(config.UTF8String,&error)==0,@"register explicit ordered cascade");require(error==NULL,@"valid cascade has no error");
        SumiEditor *editor=[SumiEditor new];editor.appearance=@{@"font_family":alias,@"font_size":@22};
        NSFont *font=[editor baseFont];BOOL light=[alias isEqualToString:@"Sumi Plex"];
        assertFace(font,@"Typewriter 1932",expected[alias][0],light);
        assertFace(font,@"沉浸式写作中文",expected[alias][1],light);
        NSFont *sourceHan=[NSFont fontWithDescriptor:SumiRegisteredFonts[@"SourceHanSerifSC-Regular"] size:22];
        BOOL found=NO;
        for(UniChar character=0x3400;character<0xa000;character++){
            BOOL covered=NO;
            for(NSString *key in cascades[alias]){
                if([key isEqualToString:@"SourceHanSerifSC-Regular"] || [key isEqualToString:@"Source Han Serif SC"])continue;
                covered|=covers([NSFont fontWithDescriptor:SumiRegisteredFonts[key] size:22],character);
            }
            if(!covered&&covers(sourceHan,character)){
                NSString *rare=[NSString stringWithCharacters:&character length:1];assertFace(font,rare,@"SourceHanSerifSC-Regular",NO);found=YES;break;
            }
        }
        require(found,@"verified actual rare-character fallback");
        printf("PASS cascade %s\n",alias.UTF8String);
    }
    printf("PASS: 3 selected cascades plus legacy Typewriter; exact PS, Light weight, no missing glyph, rare fallback\n");
    return 0;
}}
