import AppKit
import Foundation

// The launcher waits only for the bounded update/readiness handoff. The native
// process owns an inherited lifetime lease until it has actually exited.
let bundle = Bundle.main.bundleURL
if CommandLine.arguments.contains("--activate-existing") {
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: "me.thearcades.heinlein.studio") {
        if app.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            app.activate(options: [.activateAllWindows])
        }
    }
    exit(0)
}
let pythonPaths = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
guard let python = pythonPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
    let alert = NSAlert()
    alert.messageText = "Heinlein could not start its updater"
    alert.informativeText = "Python 3 is required for this local source build. Your writing and saved accounts have not changed."
    alert.runModal()
    exit(1)
}
let process = Process()
process.executableURL = URL(fileURLWithPath: python)
process.arguments = ["-I", "-S", bundle.appendingPathComponent("Contents/Resources/update.py").path,
                     "--app", bundle.path, "launch"]
process.environment = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                       "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                       "LANG": "en_US.UTF-8"]
process.standardOutput = FileHandle.nullDevice
process.standardError = FileHandle.nullDevice
do { try process.run(); process.waitUntilExit() }
catch {
    let alert = NSAlert()
    alert.messageText = "Heinlein could not start safely"
    alert.informativeText = "The updater is unavailable. Your writing and saved accounts have not changed. Try opening Heinlein again."
    alert.runModal()
    exit(1)
}
exit(process.terminationStatus)
