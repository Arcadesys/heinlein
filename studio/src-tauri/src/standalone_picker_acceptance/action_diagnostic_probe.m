// NO GUI: compiled only by the separate diagnostic-probes feature.
#import <Foundation/Foundation.h>
#include <stdint.h>
extern int32_t native47_d1_action(void *,uint32_t,uint32_t);
@interface Native47D1Probe : NSObject { @public uint32_t branch; uint32_t calls; BOOL senderWasNil; }
-(void)cancel:(id)sender;
-(void)ok:(id)sender;
@end
@implementation Native47D1Probe
-(void)cancel:(id)sender {
    calls++; senderWasNil=(sender==nil);
    if (branch==1) @throw [NSException exceptionWithName:@"PRIVATE_PROBE_NAME" reason:@"PRIVATE_PROBE_REASON" userInfo:nil];
    if (branch==2) @throw self;
}
-(void)ok:(id)sender { [self cancel:sender]; }
@end
int32_t native47_d1_probe(uint32_t branch,uint32_t action) {
    @autoreleasepool {
        Native47D1Probe *object=[Native47D1Probe new];
        object->branch=branch;
        int32_t result=native47_d1_action(object,action,action);
        BOOL valid=result==0 && object->calls==1 && object->senderWasNil;
        [object release];
        return valid?0:1;
    }
}
