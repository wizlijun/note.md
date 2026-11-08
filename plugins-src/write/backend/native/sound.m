#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import "sound.h"
#import <math.h>

@interface SumiSound : NSObject
@property dispatch_queue_t queue;
@property AVAudioEngine *engine;
@property NSArray<AVAudioPlayerNode *> *players;
@property NSDictionary<NSString *,NSArray<AVAudioPCMBuffer *> *> *bank;
@property id observer;
@property NSUInteger next;
@property uint32_t scheduled;
@property BOOL offline;
@property BOOL closed;
- (BOOL)start:(NSError **)error;
@end
@implementation SumiSound
- (BOOL)start:(NSError **)error {
    if(self.closed)return NO;
    [self.engine stop];
    self.engine=[AVAudioEngine new];
    AVAudioFormat *format=[[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:1];
    NSMutableArray *players=[NSMutableArray new];
    for(NSUInteger n=0;n<24;n++){
        AVAudioPlayerNode *player=[AVAudioPlayerNode new];
        [self.engine attachNode:player];
        [self.engine connect:player to:self.engine.mainMixerNode format:format];
        [players addObject:player];
    }
    self.players=players; self.next=0;
    // Leave headroom for overlapping samples; no software pressure estimation.
    self.engine.mainMixerNode.outputVolume=0.55;
    if(self.offline && ![self.engine enableManualRenderingMode:AVAudioEngineManualRenderingModeOffline format:format maximumFrameCount:4096 error:error])return NO;
    [self.engine prepare];
    return [self.engine startAndReturnError:error];
}
@end
static void SoundError(char **error,NSString *message){if(error)*error=strdup(message.UTF8String);}
void sumi_sound_free(char *value){free(value);}
void *sumi_sound_create(const char *bank_json,int offline,char **error){
    @autoreleasepool {
        if(error)*error=NULL;
        NSData *data=bank_json?[NSData dataWithBytes:bank_json length:strlen(bank_json)]:nil;
        NSDictionary *paths=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
        if(![paths isKindOfClass:NSDictionary.class]){SoundError(error,@"Invalid sound bank");return NULL;}
        SumiSound *sound=[SumiSound new];sound.offline=offline!=0;
        sound.queue=dispatch_queue_create("net.notemd.sumi.sound",DISPATCH_QUEUE_SERIAL);
        NSMutableDictionary *bank=[NSMutableDictionary new];
        for(NSString *role in paths){
            if(![paths[role] isKindOfClass:NSArray.class]){SoundError(error,@"Invalid sound role");return NULL;}
            NSMutableArray *buffers=[NSMutableArray new];
            for(NSString *path in paths[role]){
                if(![path isKindOfClass:NSString.class]){SoundError(error,@"Invalid sound file");return NULL;}
                NSError *failure=nil;
                AVAudioFile *file=[[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&failure];
                if(!file || file.length<1 || file.length>48000*5 || file.processingFormat.sampleRate!=48000 || file.processingFormat.channelCount!=1){SoundError(error,@"Sound file must be short 48 kHz mono PCM");return NULL;}
                AVAudioPCMBuffer *buffer=[[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat frameCapacity:(AVAudioFrameCount)file.length];
                if(![file readIntoBuffer:buffer error:&failure]){SoundError(error,@"Sound file cannot be decoded");return NULL;}
                [buffers addObject:buffer];
            }
            bank[role]=buffers;
        }
        sound.bank=bank;
        __block BOOL started=NO;
        dispatch_sync(sound.queue,^{NSError *failure=nil;started=[sound start:&failure];});
        if(!started){SoundError(error,@"Audio output is unavailable");return NULL;}
        __weak SumiSound *weak=sound;
        sound.observer=[NSNotificationCenter.defaultCenter addObserverForName:AVAudioEngineConfigurationChangeNotification object:nil queue:nil usingBlock:^(NSNotification *note){
            SumiSound *strong=weak;if(!strong)return;
            dispatch_async(strong.queue,^{if(!strong.closed && !strong.offline && note.object==strong.engine){NSError *failure=nil;[strong start:&failure];}});
        }];
        return (__bridge_retained void *)sound;
    }
}
int sumi_sound_ready(void *context){
    if(!context)return 0;
    SumiSound *sound=(__bridge SumiSound *)context;__block BOOL ready;
    dispatch_sync(sound.queue,^{ready=!sound.closed && sound.engine.isRunning;});return ready;
}
void sumi_sound_play(void *context,const char *raw){
    if(!context || !raw)return;
    SumiSound *sound=(__bridge SumiSound *)context;NSString *role=[NSString stringWithUTF8String:raw];
    // Drop stale queued feedback after stalls/device changes rather than replay it.
    NSTimeInterval received=NSProcessInfo.processInfo.systemUptime;
    dispatch_async(sound.queue,^{@autoreleasepool{
        if(sound.closed || !sound.engine.isRunning || NSProcessInfo.processInfo.systemUptime-received>0.15)return;
        NSArray<AVAudioPCMBuffer *> *samples=sound.bank[role];if(!samples.count)return;
        AVAudioPCMBuffer *buffer=samples[arc4random_uniform((uint32_t)samples.count)];
        AVAudioPlayerNode *player=sound.players[sound.next++%sound.players.count];
        player.volume=[role isEqualToString:@"modifier"]?0.6:([role isEqualToString:@"key_up"]||[role isEqualToString:@"space_up"]?0.32:1.0);
        [player scheduleBuffer:buffer atTime:nil options:AVAudioPlayerNodeBufferInterrupts completionHandler:nil];
        if(!player.isPlaying)[player play];sound.scheduled++;
    }});
}
void sumi_sound_stop(void *context){
    if(!context)return;SumiSound *sound=(__bridge SumiSound *)context;
    dispatch_sync(sound.queue,^{for(AVAudioPlayerNode *player in sound.players)[player stop];sound.next=0;});
}
void sumi_sound_destroy(void *context){
    if(!context)return;SumiSound *sound=CFBridgingRelease(context);
    [NSNotificationCenter.defaultCenter removeObserver:sound.observer];
    dispatch_sync(sound.queue,^{sound.closed=YES;[sound.engine stop];for(AVAudioPlayerNode *player in sound.players)[player stop];});
}
int sumi_sound_render(void *context,uint32_t frames,float *peak,uint32_t *voices){
    if(!context || !peak || !voices || frames<1 || frames>4096)return 0;
    SumiSound *sound=(__bridge SumiSound *)context;__block int result=0;
    dispatch_sync(sound.queue,^{
        if(!sound.offline)return;
        AVAudioPCMBuffer *buffer=[[AVAudioPCMBuffer alloc] initWithPCMFormat:sound.engine.manualRenderingFormat frameCapacity:frames];NSError *error=nil;
        if([sound.engine renderOffline:frames toBuffer:buffer error:&error]!=AVAudioEngineManualRenderingStatusSuccess)return;
        float maximum=0;for(uint32_t n=0;n<buffer.frameLength;n++)maximum=fmaxf(maximum,fabsf(buffer.floatChannelData[0][n]));
        *peak=maximum;*voices=sound.scheduled;result=1;
    });return result;
}
