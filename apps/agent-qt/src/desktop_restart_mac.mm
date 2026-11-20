#include "native.h"
#include <atomic>
#import <AppKit/AppKit.h>

namespace Native {
void restartCodexDesktop() {
  @autoreleasepool {
    NSString *bundleId = @"com.openai.codex";
    NSRunningApplication *app = nil;
    for (NSRunningApplication *candidate in
         [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId]) {
      if (candidate.terminated)
        continue;
      if (app)
        throw Error("desktop-restart-unavailable");
      app = candidate;
    }
    NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
    NSURL *bundleURL = app ? app.bundleURL :
                            [workspace URLForApplicationWithBundleIdentifier:bundleId];
    if (!bundleURL)
      throw Error("desktop-restart-launch-failed");

    if (app) {
      const auto exited = [&] { return app.terminated; };
      [app terminate];
      if (!waitFor(exited, 5000))
        [app forceTerminate];
      if (!waitFor(exited, 5000))
        throw Error("desktop-restart-exit-unconfirmed", true);
    }

    NSWorkspaceOpenConfiguration *configuration =
        [NSWorkspaceOpenConfiguration configuration];
    configuration.activates = NO;
    auto outcome = std::make_shared<std::atomic<int>>(0);
    [workspace
        openApplicationAtURL:bundleURL configuration:configuration
        completionHandler:^(NSRunningApplication *launched, NSError *error) {
          if (error)
            outcome->store(-1);
          else
            outcome->store(launched && !launched.terminated &&
                                   [launched.bundleIdentifier isEqualToString:bundleId]
                               ? 1 : -2);
        }];
    if (!waitFor([&] { return outcome->load() != 0; }, 10000) ||
        outcome->load() == -2)
      throw Error("desktop-restart-launch-unconfirmed", true);
    if (outcome->load() == -1)
      throw Error("desktop-restart-launch-failed");
  }
}
} // namespace Native
