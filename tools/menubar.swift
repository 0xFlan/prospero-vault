// Prospero Vault menu bar shell.
//
// The server is the same Bun entry point the repo runs; this process owns the
// lifecycle (start, stop, logs, open the UI) and the login item. It is a menu
// bar app only (LSUIElement in Info.plist), so double-clicking the bundle puts
// a status item up rather than a window.
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: Process?
    private var poll: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private let port = Int(ProcessInfo.processInfo.environment["PV_PORT"] ?? "") ?? 8090

    private var supportDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Prospero Vault", isDirectory: true)
    }
    private var dataDir: URL { supportDir.appendingPathComponent("data", isDirectory: true) }
    private var logURL: URL {
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Logs", isDirectory: true)
        return logs.appendingPathComponent("Prospero Vault.log")
    }
    private var loginPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.prospero.vault.plist")
    }
    private var uiURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A `kill` on this process (a test harness, or Force Quit) must take the
        // server with it; otherwise the child keeps the port and the next launch
        // says it is already running.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }

        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PV"
        statusItem.button?.toolTip = "Prospero Vault"

        buildMenu()
        startServerIfNeeded()
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.buildMenu()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let server else { return }
        server.terminate()
        // Give it a moment to release the port before this process disappears.
        let deadline = Date().addingTimeInterval(2)
        while server.isRunning && Date() < deadline {
            usleep(50_000)
        }
    }

    private func buildMenu() {
        let menu = NSMenu()

        let open = NSMenuItem(title: "Open Prospero Vault", action: #selector(openUI), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        let status = NSMenuItem(title: statusLine(), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = FileManager.default.fileExists(atPath: loginPlist.path) ? .on : .off
        menu.addItem(login)

        let log = NSMenuItem(title: "Show Log", action: #selector(showLog), keyEquivalent: "")
        log.target = self
        menu.addItem(log)

        let data = NSMenuItem(title: "Show Data Folder", action: #selector(showData), keyEquivalent: "")
        data.target = self
        menu.addItem(data)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Prospero Vault", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func statusLine() -> String {
        if healthy() { return "Running on port \(port)" }
        if server?.isRunning == true { return "Starting on port \(port)…" }
        return "Not running — open the log"
    }

    private func healthy() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/state") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 { ok = true }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.5)
        return ok
    }

    private func startServerIfNeeded() {
        if healthy() { return }

        let resources = Bundle.main.resourceURL!
        let bun = resources.appendingPathComponent("bun")
        let appDir = resources.appendingPathComponent("app", isDirectory: true)

        let process = Process()
        process.executableURL = bun
        process.arguments = ["app/server.ts"]
        process.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["PV_DATA"] = dataDir.path
        env["PV_CONFIG"] = dataDir.appendingPathComponent("config.json").path
        process.environment = env

        let log = logURL
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }

        do {
            try process.run()
            server = process
        } catch {
            let alert = NSAlert()
            alert.messageText = "Prospero Vault could not start"
            alert.informativeText = "\(error.localizedDescription)\n\nSee \(log.path)."
            alert.runModal()
        }
    }

    @objc private func openUI() {
        startServerIfNeeded()
        NSWorkspace.shared.open(uiURL)
    }

    @objc private func toggleLogin() {
        let fm = FileManager.default
        if fm.fileExists(atPath: loginPlist.path) {
            try? fm.removeItem(at: loginPlist)
            runLaunchctl(["unload", loginPlist.path])
            return
        }

        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>com.prospero.vault</string>
          <key>ProgramArguments</key>
          <array><string>\(Bundle.main.bundlePath)/Contents/MacOS/ProsperoVault</string></array>
          <key>RunAtLoad</key><true/>
          <key>LimitLoadToSessionType</key><string>Aqua</string>
        </dict>
        </plist>
        """
        try? fm.createDirectory(at: loginPlist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? plist.write(to: loginPlist, atomically: true, encoding: .utf8)
        runLaunchctl(["load", "-w", loginPlist.path])
        buildMenu()
    }

    private func runLaunchctl(_ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    @objc private func showLog() {
        NSWorkspace.shared.selectFile(logURL.path, inFileViewerRootedAtPath: logURL.deletingLastPathComponent().path)
    }

    @objc private func showData() {
        NSWorkspace.shared.open(supportDir)
    }

    @objc private func quit() {
        server?.terminate()
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
