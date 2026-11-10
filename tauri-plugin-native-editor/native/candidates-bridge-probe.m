#import <AppKit/AppKit.h>
#import "candidates-bridge.h"

static int checks=0;
static void require(BOOL value,NSString *message){checks++;if(!value){fprintf(stderr,"FAIL: %s\n",message.UTF8String);exit(1);}}
static void pump(NSTimeInterval seconds){NSDate *until=[NSDate dateWithTimeIntervalSinceNow:seconds];while(until.timeIntervalSinceNow>0)[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];}
static NSMutableDictionary *lastMessage;
static CFDataRef reply(CFMessagePortRef port,SInt32 msgid,CFDataRef data,void *info){(void)port;(void)msgid;(void)info;lastMessage=[[NSJSONSerialization JSONObjectWithData:(__bridge NSData *)data options:0 error:nil] mutableCopy];return NULL;}
static BOOL waitType(NSString *type){for(int i=0;i<200;i++){if([lastMessage[@"type"] isEqual:type])return YES;pump(.01);}return NO;}

static int client(NSString *marker){
    NSString *token=[marker substringFromIndex:SumiCandidateMarkerPrefix.length];
    NSString *name=[SumiCandidateReplyPrefix stringByAppendingString:NSUUID.UUID.UUIDString];
    CFMessagePortContext context={0,NULL,NULL,NULL,NULL};
    CFMessagePortRef local=CFMessagePortCreateLocal(NULL,(__bridge CFStringRef)name,reply,&context,NULL);
    require(local!=NULL,@"client reply port available");
    CFRunLoopSourceRef source=CFMessagePortCreateRunLoopSource(NULL,local,0);CFRunLoopAddSource(CFRunLoopGetMain(),source,kCFRunLoopCommonModes);
    CFMessagePortRef remote=CFMessagePortCreateRemote(NULL,(__bridge CFStringRef)marker);require(remote!=NULL,@"cross-process host port discovered");
    NSMutableDictionary *message=[@{@"v":@1,@"type":@"hello",@"token":token,@"context":@"probe-context",@"reply":name} mutableCopy];
    require(SumiCandidateSend(remote,message),@"hello queued without synchronous reply");require(waitType(@"ready"),@"real async ready received");
    message[@"lease"]=lastMessage[@"lease"];message[@"generation"]=lastMessage[@"generation"];
    message[@"type"]=@"snapshot";message[@"serial"]=@"1";message[@"candidates"]=@[@{@"index":@0,@"text":@"你好",@"label":@"1",@"comment":@""}];message[@"cursor"]=@0;message[@"hasPrev"]=@NO;message[@"hasNext"]=@YES;
    require(SumiCandidateSend(remote,message),@"snapshot queued");require(waitType(@"prepared"),@"host prepared before present");
    message[@"type"]=@"present";require(SumiCandidateSend(remote,message),@"present queued");require(waitType(@"select"),@"host click delivered across processes");require([lastMessage[@"index"] isEqual:@0] && [lastMessage[@"serial"] isEqual:@"1"],@"selection retains true index and revision");
    message[@"type"]=@"snapshot";message[@"serial"]=@"2";message[@"candidates"]=@[];
    require(SumiCandidateSend(remote,message),@"clear snapshot queued");require(waitType(@"prepared"),@"clear prepared");
    message[@"type"]=@"present";require(SumiCandidateSend(remote,message),@"clear present");require(waitType(@"release"),@"inactive host revokes without waiting for another key");
    CFRelease(remote);CFRunLoopRemoveSource(CFRunLoopGetMain(),source,kCFRunLoopCommonModes);CFRelease(source);CFMessagePortInvalidate(local);CFRelease(local);
    printf("client PASS %d checks\n",checks);return 0;
}
int main(int argc,const char **argv){@autoreleasepool{
    if(argc==3 && !strcmp(argv[1],"--client"))return client([NSString stringWithUTF8String:argv[2]]);
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    __block BOOL active=YES;__block int prepared=0,presented=0,cleared=0;
    SumiCandidatesBridge *bridge=[SumiCandidatesBridge new];require(bridge.marker.length>0,@"host port available");
    bridge.eligible=^NSString *{return active?@"7":nil;};
    bridge.prepare=^BOOL(NSDictionary *snapshot){prepared++;require([snapshot[@"serial"] isEqual:prepared==1?@"1":@"2"],@"monotonic snapshots");return YES;};
    __weak SumiCandidatesBridge *weak=bridge;
    bridge.present=^{presented++;if(presented==1){[weak selectIndex:0];[weak selectIndex:0];}else {active=NO;[weak checkLease];}};
    bridge.clear=^{cleared++;};
    BOOL swiftClient=argc==3 && !strcmp(argv[1],"--swift-client");
    NSTask *task=[NSTask new];task.executableURL=[NSURL fileURLWithPath:[NSString stringWithUTF8String:swiftClient?argv[2]:argv[0]]];task.arguments=@[swiftClient?@"--host-marker":@"--client",bridge.marker];
    NSError *error=nil;require([task launchAndReturnError:&error],@"separate client process launched");
    for(int i=0;i<800 && task.running;i++)pump(.01);
    require(!task.running,@"protocol completed without deadlock");require(task.terminationStatus==0,@"client protocol assertions pass");
    require(prepared==2 && presented==2 && cleared>=1 && !bridge.connected,@"display lifecycle and focus release");
    require(!SumiCandidateSerial(@"18446744073709551616",NULL),@"serial overflow rejected");require(!SumiCandidateSerial(@"-1",NULL),@"negative serial rejected");require(!SumiCandidateSnapshotValid(@{@"candidates":@[@{@"index":@0}]}),@"malformed candidate rejected");
    // A lost peer expires even if no key or new candidate arrives.
    active=YES;bridge.context=@"expired";bridge.lease=@"lease";bridge.generation=@"7";bridge.lastSeen=CACurrentMediaTime()-2;
    [bridge checkLease];require(!bridge.connected,@"lost peer lease expires");
    // Late old-lease messages must never revoke a replacement lease.
    bridge.context=@"new";bridge.lease=@"new-lease";bridge.generation=@"7";bridge.lastSeen=CACurrentMediaTime();
    [bridge receive:@{@"v":@1,@"token":bridge.token,@"context":@"old",@"lease":@"old-lease",@"generation":@"7",@"type":@"release"}];require(bridge.connected,@"old release cannot revoke new lease");[bridge releaseLease];
    printf("host PASS %d checks\n",checks);return 0;
}}
