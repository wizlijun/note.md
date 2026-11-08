// Process-scoped font registration and actual NSTextView family verification.
#import "editor.m"
static void require(BOOL value,NSString *message){if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static void checkSystemFallback(void){
    require(SumiRegisteredFonts.count==0 && SumiRegisteredFontPaths.count==0,@"fallback works before any Sumi font registration");
    SumiEditor *editor=[SumiEditor new];editor.appearance=@{@"font_family":@"Sumi System",@"font_size":@22};
    NSFont *font=[editor baseFont],*expected=[NSFont monospacedSystemFontOfSize:22 weight:NSFontWeightLight];
    require([font.fontName isEqualToString:expected.fontName] && font.pointSize==22,@"fallback resolves the actual system monospaced Light face");
    CGFloat narrow=[@"iiii" sizeWithAttributes:@{NSFontAttributeName:font}].width,wide=[@"WWWW" sizeWithAttributes:@{NSFontAttributeName:font}].width;
    require(narrow>0 && fabs(narrow-wide)<0.01,@"system fallback has equal Latin character advances");
    NSAttributedString *body=[[NSAttributedString alloc]initWithString:@"Sumi 中文写作" attributes:@{NSFontAttributeName:font}];
    CTLineRef line=CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)body);
    require(CTLineGetTypographicBounds(line,NULL,NULL,NULL)>0,@"mixed English and Chinese have real typographic width");
    NSUInteger chinese=0;NSMutableSet<NSString *> *faces=[NSMutableSet new];
    for(id value in (__bridge NSArray *)CTLineGetGlyphRuns(line)){
        CTRunRef run=(__bridge CTRunRef)value;CFRange range=CTRunGetStringRange(run);
        NSRange overlap=NSIntersectionRange(NSMakeRange((NSUInteger)range.location,(NSUInteger)range.length),NSMakeRange(5,4));
        if(!overlap.length)continue;
        CTFontRef actual=(CTFontRef)CFDictionaryGetValue(CTRunGetAttributes(run),kCTFontAttributeName);
        NSString *name=CFBridgingRelease(CTFontCopyPostScriptName(actual));[faces addObject:name];
        CFIndex count=CTRunGetGlyphCount(run);NSMutableData *glyphs=[NSMutableData dataWithLength:(NSUInteger)count*sizeof(CGGlyph)];CTRunGetGlyphs(run,CFRangeMake(0,0),glyphs.mutableBytes);
        require(count>0,@"Chinese fallback creates glyphs");for(CFIndex i=0;i<count;i++)require(((CGGlyph *)glyphs.mutableBytes)[i]!=0,@"Chinese fallback contains no missing glyph");
        chinese+=overlap.length;
    }
    CFRelease(line);require(chinese==4 && faces.count>0,@"all four Chinese characters use actual CoreText fallback runs");
    if(@available(macOS 13.0,*)){
        NSTextView *text=[[NSTextView alloc]initUsingTextLayoutManager:YES];text.frame=NSMakeRect(0,0,640,480);
        [text.textStorage setAttributedString:body];
        [text.textLayoutManager ensureLayoutForRange:text.textLayoutManager.textContentManager.documentRange];
        __block NSUInteger lines=0;
        [text.textLayoutManager enumerateTextLayoutFragmentsFromLocation:nil options:NSTextLayoutFragmentEnumerationOptionsEnsuresLayout usingBlock:^BOOL(NSTextLayoutFragment *fragment){
            for(NSTextLineFragment *part in fragment.textLineFragments){require(part.typographicBounds.size.width>0 && part.typographicBounds.size.height>0,@"TextKit 2 lays out mixed-script fallback text");lines++;}return YES;
        }];
        require(lines>0 && [text.string isEqualToString:body.string],@"fallback layout preserves mixed-script content");
    }else require(NO,@"fallback probe needs the supported macOS 13 native editor runtime");
    require(SumiRegisteredFonts.count==0,@"system fallback never registers or downloads a Sumi font");
    printf("PASS: no-font fallback actual=%s, equal Latin advances=%.3f, Chinese CoreText faces=%s, real TextKit 2 layout\n",font.fontName.UTF8String,narrow,[[faces.allObjects sortedArrayUsingSelector:@selector(compare:)]componentsJoinedByString:@","] .UTF8String);
}
int main(int argc,const char **argv){@autoreleasepool{
    require(argc==2,@"pass the fixed bundled IBMPlexSansSC-Light.otf path");
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];pid_t foreground=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    checkSystemFallback();
    char *error=NULL;
    require(sumi_editor_register_font("/nonexistent/sumi-font.otf","IBM Plex Sans SC",&error)!=0,@"missing resource rejects");
    require(error!=NULL,@"missing resource explains failure");sumi_editor_free_string(error);error=NULL;
    require(sumi_editor_register_font(argv[1],"Not The Bundled Family",&error)!=0,@"wrong family rejects");
    require(error!=NULL,@"family mismatch explains failure");sumi_editor_free_string(error);error=NULL;
    require(sumi_editor_register_font(argv[1],"IBM Plex Sans SC",&error)==0,@"bundled font registers in process");
    require(error==NULL,@"successful registration has no error");
    require(sumi_editor_register_font(argv[1],"IBM Plex Sans SC",&error)==0,@"registration is idempotent");
    SumiEditor *editor=[SumiEditor new];editor.appearance=@{@"font_family":@"IBM Plex Sans SC",@"font_size":@22,@"line_height":@1.6,@"foreground":@"#111111"};
    NSFont *font=[editor baseFont];
    require([font.familyName isEqualToString:@"IBM Plex Sans SC"],@"editor actually resolves bundled family");
    require([font.fontName isEqualToString:@"IBMPlexSansSC-Light"],@"editor actually resolves Light face");
    NSTextView *text=[[NSTextView alloc] initWithFrame:NSMakeRect(0,0,640,480)];
    [text.textStorage setAttributedString:[[NSAttributedString alloc] initWithString:@"沉浸式写作 Sumi 😀" attributes:@{NSFontAttributeName:font}]];
    NSFont *actual=[text.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    require([actual.familyName isEqualToString:@"IBM Plex Sans SC"],@"NSTextView attributed storage carries the intended family");
    editor.text=(SumiTextView *)text;editor.runs=@[@{@"range":@{@"start":@0,@"length":@5},@"bold":@YES,@"italic":@YES}];
    [editor styleRanges:[NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0,text.string.length)]];
    actual=[text.textStorage attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    require([actual.familyName isEqualToString:@"IBM Plex Sans SC"],@"rich styles preserve unified family");
    require(([NSFontManager.sharedFontManager traitsOfFont:actual]&NSBoldFontMask) || [[text.textStorage attribute:NSStrokeWidthAttributeName atIndex:0 effectiveRange:NULL] doubleValue]<0,@"bold uses native face or explicit synthesis");
    require(([NSFontManager.sharedFontManager traitsOfFont:actual]&NSItalicFontMask) || [[text.textStorage attribute:NSObliquenessAttributeName atIndex:0 effectiveRange:NULL] doubleValue]>0,@"italic uses native face or explicit synthesis");
    require(!NSApp.isActive && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==foreground,@"font probe never activates or changes foreground");
    printf("PASS: process-scoped bundled registration, missing/mismatched rejection, repeat registration, actual family=%s face=%s\n",actual.familyName.UTF8String,actual.fontName.UTF8String);
    return 0;
}}
