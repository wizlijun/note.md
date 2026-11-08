#pragma once
#import <AppKit/AppKit.h>
// Only semantic modifiers participate. Caps Lock / Fn / numeric-pad flags are
// event metadata; every extra Ctrl / Option / Shift / Command is significant.
static NSString *SumiShortcut(NSString *characters, unsigned short keyCode, NSEventModifierFlags modifiers) {
    const NSEventModifierFlags cmd=NSEventModifierFlagCommand, shift=NSEventModifierFlagShift,
        alt=NSEventModifierFlagOption, ctrl=NSEventModifierFlagControl;
    NSEventModifierFlags flags=modifiers & (cmd|shift|alt|ctrl);
    NSString *key=characters.lowercaseString;
    if(flags==cmd){
        if(keyCode==36 || keyCode==76)return @"fullscreen";
        NSDictionary *keys=@{@"a":@"select_all",@"c":@"copy",@"x":@"cut",@"v":@"paste",
          @"z":@"undo",@"b":@"bold",@"i":@"italic",@"k":@"link",@"f":@"find",@"g":@"find_next",
          @"n":@"new_page",@"o":@"menu",@"s":@"save",@"w":@"close",@",":@"settings",
          @"=":@"zoom_in",@"+":@"zoom_in",@"-":@"zoom_out",@"0":@"zoom_reset",@"]":@"indent",@"[":@"outdent"};
        return keys[key];
    }
    if(flags==(cmd|shift)){
        NSDictionary *keys=@{@"z":@"redo",@"x":@"strike",@"v":@"paste_plain",@"g":@"find_previous",
          @"s":@"export",@"+":@"zoom_in",@"=":@"zoom_in",@"9":@"quote",@"(":@"quote",
          @"8":@"bullet_list",@"*":@"bullet_list",@"7":@"ordered_list",@"&":@"ordered_list"};
        return keys[key];
    }
    if(flags==(cmd|alt)){
        if(keyCode==123)return @"previous_page";
        if(keyCode==124)return @"next_page";
        if([key isEqualToString:@"f"])return @"replace";
        if([key isEqualToString:@"0"])return @"paragraph";
        if(key.length==1 && [@"123456" containsString:key])return [@"heading" stringByAppendingString:key];
    }
    if(flags==(cmd|ctrl) && [key isEqualToString:@"f"])return @"fullscreen";
    if(flags==(cmd|alt|shift) && [key isEqualToString:@"v"])return @"paste_plain";
    if(keyCode==48 && flags==0)return @"indent";
    if(keyCode==48 && flags==shift)return @"outdent";
    if(keyCode==53 && flags==0)return @"escape";
    return nil;
}
