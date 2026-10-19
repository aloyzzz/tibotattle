// TiboTattle native macOS menu-bar app. See docs/reference/macos-app.md.
//
// The app is an accessory (LSUIElement): no Dock icon, a menu bar item with a
// window-style popover, and a dashboard window opened on demand.

import AppKit
import SwiftUI

@main
struct TiboTattleApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environmentObject(model)
        } label: {
            MenuBarLabel(lowest: model.lowest)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Info.plist sets LSUIElement; this also covers running the bare
        // executable outside the app bundle during development.
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// Menu bar label: `62%`, `62%?` when every series is stale, or only the icon
/// when there is no allowance data.
struct MenuBarLabel: View {
    let lowest: LowestAllowance?

    var body: some View {
        if let low = lowest {
            Text(low.menuText)
                .monospacedDigit()
                .help(low.tooltip)
                .accessibilityLabel(low.tooltip)
        } else {
            Image(systemName: "gauge")
                .help("TiboTattle: no allowance data")
                .accessibilityLabel("TiboTattle")
        }
    }
}
