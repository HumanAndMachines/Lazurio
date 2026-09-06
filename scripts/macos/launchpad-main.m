#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>

// This is only the LaunchServices adapter. The existing human launcher and
// Core own Bun resolution, server identity, startup/reuse and browser opening.
@interface LaunchpadDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) BOOL started;
@end

@implementation LaunchpadDelegate
- (void)showFailure:(NSString *)detail {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Lazurio Launchpad se nepodařilo spustit";
    alert.informativeText = detail;
    alert.alertStyle = NSAlertStyleCritical;
    [alert addButtonWithTitle:@"OK"];
    [NSApp activateIgnoringOtherApps:YES];
    [alert runModal];
}

- (void)launch {
    NSString *script = [[NSBundle mainBundle] pathForResource:@"launchpad-bootstrap" ofType:@"sh"];
    if (!script) {
        [self showFailure:@"Chybí bootstrap aplikace. Spusť znovu lazurio launchpad install."];
        return;
    }

    // An unlinked temporary file avoids a pipe deadlock and survives this GUI
    // exiting while the Core-managed server continues. It is diagnostic output,
    // not a new persistent log, PID file or server locator.
    FILE *output = tmpfile();
    if (!output) {
        [self showFailure:@"Nelze připravit dočasný výstup launcheru."];
        return;
    }
    // Only the explicit stdout/stderr duplicates belong in the child; future
    // reopen invocations must not inherit other launch attempts' descriptors.
    fcntl(fileno(output), F_SETFD, FD_CLOEXEC);
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/bash"];
    task.arguments = @[script];
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
    NSFileHandle *handle = [[NSFileHandle alloc] initWithFileDescriptor:fileno(output) closeOnDealloc:NO];
    task.standardOutput = handle;
    task.standardError = handle;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fclose(output);
        [self showFailure:error.localizedDescription];
        return;
    }
    // A cold start remains alive with its server; never block the UI or prevent
    // another Dock click from asking Core to open/reuse that running instance.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [task waitUntilExit];
        NSString *detail = nil;
        if (task.terminationStatus != 0) {
            off_t end = lseek(fileno(output), 0, SEEK_END);
            if (end > 0) {
                lseek(fileno(output), MAX((off_t)0, end - 8192), SEEK_SET);
                char bytes[8192];
                ssize_t count = read(fileno(output), bytes, sizeof(bytes));
                if (count > 0) detail = [[NSString alloc] initWithBytes:bytes length:(NSUInteger)count encoding:NSUTF8StringEncoding];
            }
            detail = detail.length ? detail : @"Launcher skončil s chybou. Zkontroluj instalaci Lazuria a dostupnost Bunu.";
        }
        fclose(output);
        if (detail) dispatch_async(dispatch_get_main_queue(), ^{ [self showFailure:detail]; });
    });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.started = YES;
    [self launch];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)application hasVisibleWindows:(BOOL)visible {
    (void)application;
    (void)visible;
    if (self.started) [self launch];
    return NO;
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        LaunchpadDelegate *delegate = [[LaunchpadDelegate alloc] init];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
