#import <InputMethodKit/InputMethodKit.h>
#import "probe-common.h"
@interface SumiMarkerProbeController : IMKInputController
@end
@implementation SumiMarkerProbeController
- (void)recordClient:(id<IMKTextInput>)client phase:(NSString *)phase key:(NSString *)key {
    NSArray *attributes=[client validAttributesForMarkedText];NSUInteger markerCount=0;
    for(id value in attributes)if([value isKindOfClass:NSString.class] && [value hasPrefix:@"com.notemd.sumi.candidates.v1."])markerCount++;
    ProbeLog(@"ime.jsonl",@{@"phase":phase,@"key":key?:@"",@"clientBundle":[client bundleIdentifier]?:@"",@"clientClass":NSStringFromClass([(id)client class]),@"markerCount":@(markerCount),@"expectedMarker":@([attributes containsObject:ProbeMarker]),@"attributeCount":@(attributes.count)});
}
- (void)activateServer:(id)sender {[self recordClient:sender phase:@"activate" key:nil];}
- (void)deactivateServer:(id)sender {[self recordClient:sender phase:@"deactivate" key:nil];}
- (NSUInteger)recognizedEvents:(id)sender {(void)sender;return NSEventMaskKeyDown;}
- (BOOL)handleEvent:(NSEvent *)event client:(id)sender {
    if(![[sender bundleIdentifier]isEqualToString:@"com.notemd.SumiMarkerProbeHost"])return NO;
    [self recordClient:sender phase:@"key" key:event.characters];
    [sender insertText:@"验" replacementRange:NSMakeRange(NSNotFound,0)];
    return YES;
}
@end
int main(void){@autoreleasepool{
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    IMKServer *server=[[IMKServer alloc]initWithName:NSBundle.mainBundle.infoDictionary[@"InputMethodConnectionName"] bundleIdentifier:NSBundle.mainBundle.bundleIdentifier];
    ProbeLog(@"ime.jsonl",@{@"phase":@"start",@"serverCreated":@(server!=nil)});
    if(!server)return 2;[NSApp run];
}}
