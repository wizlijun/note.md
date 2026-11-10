// Private, opt-in display protocol. Composition stays on NSTextInputClient.
#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <QuartzCore/QuartzCore.h>

static NSString *const SumiCandidateMarkerPrefix=@"com.notemd.sumi.candidates.v1.";
static NSString *const SumiCandidateReplyPrefix=@"org.fcitx.Fcitx5.Sumi.";
static const NSUInteger SumiCandidateMessageLimit=256*1024;

static BOOL SumiCandidateSend(CFMessagePortRef port,NSDictionary *message) {
    if(!port || !CFMessagePortIsValid(port))return NO;
    NSData *data=[NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if(!data || data.length>SumiCandidateMessageLimit)return NO;
    return CFMessagePortSendRequest(port,1,(__bridge CFDataRef)data,0,0,NULL,NULL)==kCFMessagePortSuccess;
}
static BOOL SumiCandidateSerial(id value,uint64_t *serial) {
    if(![value isKindOfClass:NSString.class] || ![value length] || [value length]>20)return NO;
    const char *bytes=[value UTF8String];uint64_t result=0;
    for(const char *p=bytes;*p;p++){
        if(*p<'0' || *p>'9' || result>(UINT64_MAX-(uint64_t)(*p-'0'))/10)return NO;
        result=result*10+(uint64_t)(*p-'0');
    }
    if(!result)return NO;
    if(serial)*serial=result;return YES;
}
static BOOL SumiCandidateSnapshotValid(NSDictionary *message) {
    NSArray *candidates=message[@"candidates"];
    if(![candidates isKindOfClass:NSArray.class] || candidates.count>512)return NO;
    NSMutableSet *indices=[NSMutableSet new];
    for(id item in candidates){
        if(![item isKindOfClass:NSDictionary.class])return NO;
        NSNumber *index=item[@"index"];
        if(![index isKindOfClass:NSNumber.class] || index.integerValue<0 || index.integerValue>=512 || index.doubleValue!=index.integerValue || [indices containsObject:index])return NO;
        [indices addObject:index];
        for(NSString *key in @[@"text",@"label",@"comment"])
            if(![item[key] isKindOfClass:NSString.class] || [item[key] length]>32768)return NO;
    }
    if(![message[@"cursor"] isKindOfClass:NSNumber.class])return NO;
    for(NSString *key in @[@"hasPrev",@"hasNext"])if(![message[key] isKindOfClass:NSNumber.class])return NO;
    return YES;
}

@interface SumiCandidatesBridge : NSObject {
    CFMessagePortRef _port, _reply;
    CFRunLoopSourceRef _source;
}
@property(nonatomic,readonly) NSString *marker;
@property(nonatomic,copy) NSString *(^eligible)(void);
@property(nonatomic,copy) BOOL (^prepare)(NSDictionary *snapshot);
@property(nonatomic,copy) void (^present)(void);
@property(nonatomic,copy) void (^clear)(void);
@property(nonatomic,readonly) BOOL connected;
- (void)receive:(NSDictionary *)message;
- (void)releaseLease;
- (void)selectIndex:(NSInteger)index;
- (void)pageNext:(BOOL)next;
- (void)checkLease;
@end

@interface SumiCandidatesBridge ()
@property(nonatomic,copy) NSString *token, *marker, *context, *lease, *generation, *replyName;
@property(nonatomic) uint64_t serial;
@property(nonatomic,strong) NSDictionary *snapshot;
@property(nonatomic) CFTimeInterval lastSeen;
@property(nonatomic,strong) NSTimer *timer;
@property(nonatomic) BOOL displayed;
@end

static CFDataRef SumiCandidatesReceive(CFMessagePortRef port,SInt32 messageID,CFDataRef data,void *info) {
    (void)port;
    if(messageID!=1 || !data || CFDataGetLength(data)>SumiCandidateMessageLimit)return NULL;
    id value=[NSJSONSerialization JSONObjectWithData:(__bridge NSData *)data options:0 error:nil];
    if([value isKindOfClass:NSDictionary.class])[(__bridge SumiCandidatesBridge *)info receive:value];
    return NULL;
}
@implementation SumiCandidatesBridge
- (instancetype)init {
    if((self=[super init])){
        _token=NSUUID.UUID.UUIDString;
        _marker=[SumiCandidateMarkerPrefix stringByAppendingString:_token];
        CFMessagePortContext context={0,(__bridge void *)self,NULL,NULL,NULL};
        _port=CFMessagePortCreateLocal(NULL,(__bridge CFStringRef)_marker,SumiCandidatesReceive,&context,NULL);
        if(_port){_source=CFMessagePortCreateRunLoopSource(NULL,_port,0);CFRunLoopAddSource(CFRunLoopGetMain(),_source,kCFRunLoopCommonModes);}
        else _marker=nil;
    }return self;
}
- (BOOL)connected {return self.lease.length>0;}
- (BOOL)isEligible {return self.eligible && [self.eligible() isEqualToString:self.generation];}
- (NSMutableDictionary *)message:(NSString *)type {
    return [@{@"v":@1,@"type":type,@"token":self.token,@"context":self.context ?: @"",@"lease":self.lease ?: @"",@"generation":self.generation ?: @""} mutableCopy];
}
- (BOOL)send:(NSString *)type fields:(NSDictionary *)fields {
    NSMutableDictionary *message=[self message:type];if(fields)[message addEntriesFromDictionary:fields];
    return SumiCandidateSend(_reply,message);
}
- (void)releaseLease {
    if(self.lease)[self send:@"release" fields:nil];
    self.lease=nil;self.context=nil;self.generation=nil;self.replyName=nil;
    self.snapshot=nil;self.serial=0;self.displayed=NO;
    [self.timer invalidate];self.timer=nil;
    if(_reply){CFRelease(_reply);_reply=NULL;}
    if(self.clear)self.clear();
}
- (void)checkLease {
    if(self.connected && (![self isEligible] || CACurrentMediaTime()-self.lastSeen>1))[self releaseLease];
}
- (void)receive:(NSDictionary *)message {
    id version=message[@"v"];
    if(![version isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)version)==CFBooleanGetTypeID()
       || ![version isEqual:@1] || ![message[@"token"] isEqual:self.token])return;
    NSString *type=message[@"type"],*context=message[@"context"];
    if(![type isKindOfClass:NSString.class] || ![context isKindOfClass:NSString.class] || !context.length || context.length>128)return;
    if([type isEqual:@"hello"]){
        NSString *generation=self.eligible?self.eligible():nil,*reply=message[@"reply"];
        if(!generation || ![reply isKindOfClass:NSString.class] || ![reply hasPrefix:SumiCandidateReplyPrefix]
           || ![[NSUUID alloc]initWithUUIDString:[reply substringFromIndex:SumiCandidateReplyPrefix.length]])return;
        if(self.connected && [self.context isEqual:context] && [self.replyName isEqual:reply] && [self.generation isEqual:generation]){
            self.lastSeen=CACurrentMediaTime();[self send:@"ready" fields:nil];return;
        }
        [self releaseLease];
        _reply=CFMessagePortCreateRemote(NULL,(__bridge CFStringRef)reply);if(!_reply)return;
        self.context=context;self.replyName=reply;self.generation=generation;self.lease=NSUUID.UUID.UUIDString;self.lastSeen=CACurrentMediaTime();
        if(![self send:@"ready" fields:nil]){[self releaseLease];return;}
        __weak SumiCandidatesBridge *weak=self;
        self.timer=[NSTimer timerWithTimeInterval:.25 repeats:YES block:^(NSTimer *timer){(void)timer;[weak checkLease];}];
        [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];return;
    }
    if(!self.connected || ![context isEqual:self.context] || ![message[@"lease"] isEqual:self.lease] || ![message[@"generation"] isEqual:self.generation])return;
    if(![self isEligible]){[self releaseLease];return;}
    self.lastSeen=CACurrentMediaTime();
    if([type isEqual:@"release"]){[self releaseLease];return;}
    if([type isEqual:@"ping"]){if(![self send:@"pong" fields:nil])[self releaseLease];return;}
    uint64_t serial=0;if(!SumiCandidateSerial(message[@"serial"],&serial))return;
    if([type isEqual:@"snapshot"]){
        if(serial<=self.serial || !SumiCandidateSnapshotValid(message))return;
        self.snapshot=message;self.serial=serial;self.displayed=NO;
        if(!self.prepare || !self.prepare(message) || ![self send:@"prepared" fields:@{@"serial":message[@"serial"]}]){[self releaseLease];return;}
    }else if([type isEqual:@"present"] && serial==self.serial && self.snapshot){
        self.displayed=YES;if(self.present)self.present();
    }
}
- (void)selectIndex:(NSInteger)index {
    [self checkLease];if(!self.connected || !self.displayed)return;
    BOOL found=NO;for(NSDictionary *item in self.snapshot[@"candidates"])if([item[@"index"] integerValue]==index){found=YES;break;}
    if(found){self.displayed=NO;if(![self send:@"select" fields:@{@"serial":[NSString stringWithFormat:@"%llu",(unsigned long long)self.serial],@"index":@(index)}])[self releaseLease];}
}
- (void)pageNext:(BOOL)next {
    [self checkLease];if(!self.connected || !self.displayed || ![self.snapshot[next?@"hasNext":@"hasPrev"] boolValue])return;
    self.displayed=NO;
    if(![self send:@"page" fields:@{@"serial":[NSString stringWithFormat:@"%llu",(unsigned long long)self.serial],@"next":@(next)}])[self releaseLease];
}
- (void)dealloc {
    [self.timer invalidate];
    if(_source){CFRunLoopRemoveSource(CFRunLoopGetMain(),_source,kCFRunLoopCommonModes);CFRelease(_source);}
    if(_port){CFMessagePortInvalidate(_port);CFRelease(_port);}
    if(_reply)CFRelease(_reply);
}
@end
