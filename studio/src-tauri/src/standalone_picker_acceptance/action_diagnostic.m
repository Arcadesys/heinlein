// Explicit diagnostic feature only. Caller retains its validated main-thread panel.
#import <AppKit/AppKit.h>
#include <stdint.h>
#include <unistd.h>

#define RECORD(category, phase) "{\"kind\":\"native47-d1\",\"category\":\"" category "\",\"phase\":" phase "}\n"
static void terminal(unsigned category, uint32_t phase) __attribute__((noreturn));
static void terminal(unsigned category, uint32_t phase) {
    const char *bytes;
    size_t length;
    int status;
#define SELECT(cat, code) do { \
    static const char one[]=RECORD(cat,"1"); \
    static const char two[]=RECORD(cat,"2"); \
    static const char unknown[]=RECORD(cat,"0"); \
    bytes=phase==1?one:phase==2?two:unknown; \
    length=phase==1?sizeof(one)-1:phase==2?sizeof(two)-1:sizeof(unknown)-1; \
    status=code; \
} while(0)
    switch(category) {
        case 1: SELECT("objc_exception",81); break;
        case 2: SELECT("objc_other",82); break;
        default: SELECT("invalid_dispatch",83); break;
    }
#undef SELECT
    // One checked bounded write; no retries, object inspection, cleanup or recovery.
    if (write(STDERR_FILENO,bytes,length)!=(ssize_t)length) _exit(79);
    _exit(status);
}

// Fixed Cancel/OK enum only; no arbitrary selector, Rust callback or result injection.
int32_t native47_d1_action(void *retained_panel, uint32_t action, uint32_t phase) {
    if (!retained_panel || !((action==1 && phase==1)||(action==2 && phase==2))) terminal(3,phase);
    @try {
        NSSavePanel *panel=(NSSavePanel *)retained_panel;
        if (action==1) [panel cancel:nil]; else [panel ok:nil];
        return 0; // POD: the public call returned, not a fabricated plugin response.
    } @catch (NSException *exception) {
        (void)exception;
        terminal(1,phase);
    } @catch (id object) {
        (void)object;
        terminal(2,phase);
    }
}
