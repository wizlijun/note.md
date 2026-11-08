// Included after the native editor declarations; all state is main-runloop owned.
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/hidsystem/IOLLEvent.h>
static BOOL SumiTypingEnabled;
static SumiTypingCallback SumiTypingHandler;
static CFMachPortRef SumiTypingTap;
static CFRunLoopSourceRef SumiTypingSource;
static __weak SumiEditor *SumiTypingOwner;
static BOOL SumiTypingPressed[128];

static SumiEditor *SumiTypingFocusedEditor(BOOL active, NSWindow *keyWindow) {
    if(!active || !keyWindow || !keyWindow.isVisible || keyWindow.attachedSheet)return nil;
    NSResponder *responder=keyWindow.firstResponder;
    if(![responder isKindOfClass:SumiTextView.class])return nil;
    SumiTextView *text=(SumiTextView *)responder;SumiEditor *editor=text.owner;
    if(!editor || editor.detached || editor.container.hidden || text.isHiddenOrHasHiddenAncestor || text.window!=keyWindow)return nil;
    return editor;
}
static void SumiTypingClear(void) {
    SumiEditor *old=SumiTypingOwner;SumiTypingOwner=nil;
    memset(SumiTypingPressed,0,sizeof(SumiTypingPressed));
    if(old && SumiTypingHandler)SumiTypingHandler(old.surfaceID.UTF8String,old.generation,7);
}
static void SumiTypingRefresh(void) {
    SumiEditor *focused=SumiTypingFocusedEditor(NSApp.isActive,NSApp.keyWindow);
    if(SumiTypingOwner && SumiTypingOwner!=focused)SumiTypingClear();
}
static uint32_t SumiTypingDownRole(uint16_t code) {
    switch(code){case 49:return 1;case 36:case 76:return 2;case 51:case 117:return 3;
        case 54:case 55:case 56:case 57:case 58:case 59:case 60:case 61:case 62:case 63:return 4;
        default:return 0;}
}
static CGEventFlags SumiTypingModifierMask(uint16_t code) {
    switch(code){case 54:return NX_DEVICERCMDKEYMASK;case 55:return NX_DEVICELCMDKEYMASK;
        case 56:return NX_DEVICELSHIFTKEYMASK;case 60:return NX_DEVICERSHIFTKEYMASK;
        case 58:return NX_DEVICELALTKEYMASK;case 61:return NX_DEVICERALTKEYMASK;
        case 59:return NX_DEVICELCTLKEYMASK;case 62:return NX_DEVICERCTLKEYMASK;
        case 57:return kCGEventFlagMaskAlphaShift;case 63:return kCGEventFlagMaskSecondaryFn;
        default:return 0;}
}
// Pure role/state processing is separately exercised without installing a system tap.
static void SumiTypingHandle(SumiEditor *editor, CGEventType type, uint16_t code, BOOL repeat, CGEventFlags flags) {
    if(!SumiTypingEnabled || !SumiTypingHandler || !editor){SumiTypingClear();return;}
    if(SumiTypingOwner!=editor){SumiTypingClear();SumiTypingOwner=editor;}
    if(code>=128)return;
    uint32_t role;
    if(type==kCGEventKeyDown){
        if(repeat || SumiTypingPressed[code])return;
        SumiTypingPressed[code]=YES;role=SumiTypingDownRole(code);
    }else if(type==kCGEventKeyUp){
        if(!SumiTypingPressed[code])return;
        SumiTypingPressed[code]=NO;role=code==49?6:5;
    }else if(type==kCGEventFlagsChanged){
        CGEventFlags mask=SumiTypingModifierMask(code);if(!mask)return;
        BOOL down=(flags&mask)!=0;if(down==SumiTypingPressed[code])return;
        SumiTypingPressed[code]=down;role=down?4:5;
    }else return;
    SumiTypingHandler(editor.surfaceID.UTF8String,editor.generation,role);
}
static CGEventRef SumiTypingReceive(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;(void)context;
    if(type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput){
        SumiTypingClear();
        if(SumiTypingEnabled && SumiTypingTap && CGPreflightListenEventAccess())CGEventTapEnable(SumiTypingTap,true);
        return event;
    }
    SumiEditor *editor=SumiTypingFocusedEditor(NSApp.isActive,NSApp.keyWindow);
    if(!editor || !event){SumiTypingClear();return event;}
    // No Unicode, text, key storage or event mutation. Only ephemeral virtual-key classification.
    SumiTypingHandle(editor,type,(uint16_t)CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode),
        CGEventGetIntegerValueField(event,kCGKeyboardEventAutorepeat)!=0,CGEventGetFlags(event));
    return event;
}
static void SumiTypingRemoveTap(void) {
    SumiTypingClear();
    if(SumiTypingSource){CFRunLoopRemoveSource(CFRunLoopGetMain(),SumiTypingSource,kCFRunLoopCommonModes);CFRelease(SumiTypingSource);SumiTypingSource=NULL;}
    if(SumiTypingTap){CFMachPortInvalidate(SumiTypingTap);CFRelease(SumiTypingTap);SumiTypingTap=NULL;}
}
uint32_t sumi_typing_status(int request_permission) {
    NSCAssert(NSThread.isMainThread,@"typing monitor must run on main thread");
    BOOL permission=CGPreflightListenEventAccess();
    if(request_permission && !permission)permission=CGRequestListenEventAccess();
    if(!SumiTypingEnabled || !SumiTypingHandler || !permission)SumiTypingRemoveTap();
    else if(!SumiTypingTap){
        CGEventMask mask=CGEventMaskBit(kCGEventKeyDown)|CGEventMaskBit(kCGEventKeyUp)|CGEventMaskBit(kCGEventFlagsChanged);
        SumiTypingTap=CGEventTapCreate(kCGSessionEventTap,kCGHeadInsertEventTap,kCGEventTapOptionListenOnly,mask,SumiTypingReceive,NULL);
        if(SumiTypingTap){
            SumiTypingSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,SumiTypingTap,0);
            if(SumiTypingSource)CFRunLoopAddSource(CFRunLoopGetMain(),SumiTypingSource,kCFRunLoopCommonModes);
            else SumiTypingRemoveTap();
        }
    }
    return (SumiTypingEnabled?1:0)|(permission?2:0)|((SumiTypingTap && CGEventTapIsEnabled(SumiTypingTap))?4:0);
}
uint32_t sumi_typing_configure(int enabled, SumiTypingCallback callback) {
    NSCAssert(NSThread.isMainThread,@"typing monitor must run on main thread");
    SumiTypingRemoveTap();SumiTypingEnabled=enabled!=0;SumiTypingHandler=callback;
    return sumi_typing_status(0);
}
