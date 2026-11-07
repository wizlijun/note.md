// Pure Foundation string checks: no NSApplication, NSWindow or UI is created.
#import "editor.m"
static BOOL boundary(NSString *s,NSUInteger p){return p==s.length || [s rangeOfComposedCharacterSequenceAtIndex:p].location==p;}
int main(){@autoreleasepool{
    NSArray *samples=@[@"",@"a",@"😀",@"😃",@"a😀b",@"a😃b",@"你\n好",@"é",@"ẽ",@"👩‍💻",@"👩‍🔧",@"  ",@"a\r\nb",@"🇹🇼",@"🇯🇵"];
    NSUInteger count=0;
    for(NSString *before in samples)for(NSString *after in samples){
        NSDictionary *delta=SumiDifference(before,after);NSRange r=SumiReadRange(delta[@"range"]);NSString *replacement=delta[@"replacement"];
        BOOL valid=[[before stringByReplacingCharactersInRange:r withString:replacement] isEqualToString:after] && boundary(before,r.location) && boundary(before,NSMaxRange(r)) && boundary(after,r.location) && boundary(after,r.location+replacement.length);
        if(!valid){fprintf(stderr,"Unicode replacement failed\n");return 1;}count++;
    }
    printf("PASS: %lu composed-character replacement pairs; no UI created\n",(unsigned long)count);
}}
