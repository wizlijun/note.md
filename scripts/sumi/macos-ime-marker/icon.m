#import <AppKit/AppKit.h>
int main(int argc,const char **argv){@autoreleasepool{
 if(argc!=2)return 2;NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc]initWithBitmapDataPlanes:NULL pixelsWide:32 pixelsHigh:32 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
 [NSGraphicsContext saveGraphicsState];[NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
 [NSColor.blackColor setFill];[[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(2,2,28,28) xRadius:4 yRadius:4]fill];
 [@"S" drawAtPoint:NSMakePoint(8,3) withAttributes:@{NSFontAttributeName:[NSFont boldSystemFontOfSize:23],NSForegroundColorAttributeName:NSColor.whiteColor}];[NSGraphicsContext restoreGraphicsState];
 return [bitmap.TIFFRepresentation writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]?0:1;
}}
