// Prospero Vault menu bar shell.
//
// The server is the same Bun entry point the repo runs; this process owns the
// lifecycle (start, stop, logs, open the UI) and the login item. It is a menu
// bar app only (LSUIElement in Info.plist), so double-clicking the bundle puts
// a status item up rather than a window.
//
// The same handlers the menu calls are reachable without a GUI for checks:
//
//   ProsperoVault --action login-on     # write + load the LaunchAgent
//   ProsperoVault --action login-off    # unload + remove it
//   ProsperoVault --action url          # print the console URL the menu opens
//   ProsperoVault --action quit         # ask the running instance to quit
//
// `--login` is what the LaunchAgent runs: if another instance is already
// serving, it exits instead of adding a second menu bar item.
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: Process?
    private var poll: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var didStartUI = false
    private var ownsPid = false
    private let port = Int(ProcessInfo.processInfo.environment["PV_PORT"] ?? "") ?? 8090

    var supportDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Prospero Vault", isDirectory: true)
    }
    var dataDir: URL { supportDir.appendingPathComponent("data", isDirectory: true) }
    var logURL: URL {
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Logs", isDirectory: true)
        return logs.appendingPathComponent("Prospero Vault.log")
    }
    var loginPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.prospero.vault.plist")
    }
    var pidFile: URL { supportDir.appendingPathComponent("app.pid") }
    var consoleURLString: String { "http://127.0.0.1:\(port)/" }

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A login item that fires while the app is already open must not create
        // a second menu bar item or a second server on the same port.
        if CommandLine.arguments.contains("--login") && (healthy() || instanceIsRunning()) {
            NSApplication.shared.terminate(nil)
            return
        }

        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        writePid()

        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.requestQuit() }
            source.resume()
            signalSources.append(source)
        }
        // The check drives the Quit menu item's own handler from outside.
        signal(SIGUSR2, SIG_IGN)
        let quitSource = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        quitSource.setEventHandler { [weak self] in self?.quit() }
        quitSource.resume()
        signalSources.append(quitSource)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PV"
        statusItem.button?.toolTip = "Prospero Vault"

        buildMenu()
        startServerIfNeeded()
        didStartUI = true
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.buildMenu()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if ownsPid { try? FileManager.default.removeItem(at: pidFile) }
        guard let server else { return }
        server.terminate()
        let deadline = Date().addingTimeInterval(2)
        while server.isRunning && Date() < deadline {
            usleep(50_000)
        }
    }

    // MARK: - Login item (the code the Launch at Login item calls)

    func installLoginItem() -> (ok: Bool, detail: String) {
        let executable = Bundle.main.bundlePath + "/Contents/MacOS/ProsperoVault"
        // A launchd job does not inherit the shell's environment. Only a port
        // explicitly set in the environment is carried over, which lets a
        // check run the real agent on a spare port without touching the app's
        // normal 8090.
        var environment = ""
        if let port = ProcessInfo.processInfo.environment["PV_PORT"] {
            environment = "<key>EnvironmentVariables</key><dict><key>PV_PORT</key><string>\(port)</string></dict>"
        }
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>com.prospero.vault</string>
          <key>ProgramArguments</key>
          <array><string>\(executable)</string><string>--login</string></array>
          \(environment)
          <key>RunAtLoad</key><true/>
          <key>LimitLoadToSessionType</key><string>Aqua</string>
        </dict>
        </plist>
        """
        do {
            try FileManager.default.createDirectory(
                at: loginPlist.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try plist.write(to: loginPlist, atomically: true, encoding: .utf8)
        } catch {
            return (false, "could not write \(loginPlist.path): \(error.localizedDescription)")
        }
        // Loading makes the agent live now (RunAtLoad); the login helper exits
        // immediately when this app is already serving.
        runLaunchctl(["load", "-w", loginPlist.path])
        let loaded = FileManager.default.fileExists(atPath: loginPlist.path)
        return (loaded, loginPlist.path)
    }

    func removeLoginItem() -> (ok: Bool, detail: String) {
        let existed = FileManager.default.fileExists(atPath: loginPlist.path)
        try? FileManager.default.removeItem(at: loginPlist)
        // Both forms: unload by path and remove by label, so an agent loaded by
        // an older build or by hand cannot survive the toggle.
        runLaunchctl(["unload", "-w", loginPlist.path])
        runLaunchctl(["remove", "com.prospero.vault"])
        let present = FileManager.default.fileExists(atPath: loginPlist.path)
        return (!present, existed ? "removed \(loginPlist.path)" : "no login item was installed")
    }

    // MARK: - Quit (the code the Quit item calls)

    func requestQuit() {
        NSApplication.shared.terminate(nil)
    }

    /** Asks the running instance to quit through the same terminate path. */
    func quitRunningInstance(timeout: TimeInterval = 8) -> (ok: Bool, detail: String) {
        guard let raw = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return (false, "no running instance recorded")
        }
        if kill(pid, SIGUSR2) != 0 {
            return (false, "could not signal pid \(pid)")
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if processIsGone(pid) { return (true, "pid \(pid) exited") }
            usleep(100_000)
        }
        return (false, "pid \(pid) still running after \(Int(timeout))s")
    }

    /** True once the process is gone, including a zombie its parent has not reaped yet. */
    private func processIsGone(_ pid: pid_t) -> Bool {
        if kill(pid, 0) != 0 { return true }
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-o", "stat=", "-p", "\(pid)"]
        let pipe = Pipe()
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice
        try? ps.run()
        ps.waitUntilExit()
        let state = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return state.isEmpty || state.hasPrefix("Z")
    }

    // MARK: - UI

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

    private func instanceIsRunning() -> Bool {
        guard let raw = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return kill(pid, 0) == 0
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

    private func writePid() {
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: pidFile, atomically: true, encoding: .utf8)
        ownsPid = true
    }

    @objc private func openUI() {
        startServerIfNeeded()
        if let url = URL(string: consoleURLString) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func toggleLogin() {
        if FileManager.default.fileExists(atPath: loginPlist.path) {
            _ = removeLoginItem()
        } else {
            _ = installLoginItem()
        }
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
        requestQuit()
    }
}

// MARK: - Headless entry point (checks drive the same handler functions)

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}

let arguments = CommandLine.arguments
if let at = arguments.firstIndex(of: "--action"), at + 1 < arguments.count {
    let delegate = AppDelegate()
    switch arguments[at + 1] {
    case "login-on":
        let result = delegate.installLoginItem()
        emit(["ok": result.ok, "plist": delegate.loginPlist.path, "detail": result.detail])
        exit(result.ok ? 0 : 1)
    case "login-off":
        let result = delegate.removeLoginItem()
        emit(["ok": result.ok, "plist": delegate.loginPlist.path, "detail": result.detail])
        exit(result.ok ? 0 : 1)
    case "url":
        emit(["ok": true, "url": delegate.consoleURLString])
        exit(0)
    case "quit":
        let result = delegate.quitRunningInstance()
        emit(["ok": result.ok, "detail": result.detail])
        exit(result.ok ? 0 : 1)
    default:
        emit(["ok": false, "detail": "unknown action \(arguments[at + 1])"])
        exit(2)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
