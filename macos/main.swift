// Pulcro.app — ventana nativa que arranca el motor local (Node) y muestra la interfaz.
import Cocoa
import WebKit
import ServiceManagement

let port = 4747
let baseURL = URL(string: "http://127.0.0.1:\(port)/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, NSPopoverDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    // Barra de menús
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var panelWeb: WKWebView!
    var quickMenu: NSMenu!
    var loginItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        setupStatusItem()
        // Si se abrió al iniciar sesión, arranca discreto: solo en la barra de menús.
        if ProcessInfo.processInfo.systemUptime < 180 { window.orderOut(nil); NSApp.setActivationPolicy(.accessory) }
        startServerIfNeeded { [weak self] ok in
            guard let self else { return }
            self.refreshStatus()
            if ok {
                self.webView.load(URLRequest(url: baseURL))
                self.panelWeb.load(URLRequest(url: baseURL.appendingPathComponent("menu.html")))
            } else {
                self.webView.loadHTMLString(Self.errorPage, baseURL: nil)
            }
        }
    }

    // Cerrar la ventana no cierra Pulcro: sigue vivo en la barra de menús.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(nil)
        return true
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    @objc func showWindow(_ sender: Any?) {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // MARK: - Motor local

    private func info(_ key: String) -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }

    private func isServerUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/scan/last"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func startServerIfNeeded(_ done: @escaping (Bool) -> Void) {
        isServerUp { up in
            if up { return DispatchQueue.main.async { done(true) } }
            DispatchQueue.main.async { self.launchServer(done) }
        }
    }

    private func launchServer(_ done: @escaping (Bool) -> Void) {
        // El motor viaja dentro del bundle (Contents/Resources/engine), así no depende
        // de carpetas protegidas como el Escritorio.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [info("PulcroNode"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node"].compactMap { $0 }
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            webView.loadHTMLString(Self.noNodePage, baseURL: nil)
            panelWeb?.loadHTMLString(Self.noNodePage, baseURL: nil)
            return
        }
        guard let root = info("PulcroRoot") ?? Bundle.main.resourceURL?.appendingPathComponent("engine").path
        else { return done(false) }
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Pulcro", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try? FileHandle(forWritingTo: logURL)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["\(root)/src/server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        do { try p.run() } catch { return done(false) }
        server = p

        var attempts = 0
        func poll() {
            attempts += 1
            isServerUp { up in
                DispatchQueue.main.async {
                    if up { done(true) }
                    else if attempts > 40 { done(false) }
                    else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: poll) }
                }
            }
        }
        poll()
    }

    // MARK: - Ventana

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Pulcro"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 820, height: 560)
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0.094, green: 0.106, blue: 0.125, alpha: 1)
                : NSColor(red: 0.925, green: 0.933, blue: 0.949, alpha: 1)
        }
        window.contentView = webView
        window.setFrameAutosaveName("PulcroMain")
        if !window.setFrameUsingName("PulcroMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        webView.loadHTMLString(Self.loadingPage, baseURL: nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Los enlaces externos se abren en el navegador, no dentro de Pulcro.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    @objc func reload(_ sender: Any?) { webView.load(URLRequest(url: baseURL)) }

    // MARK: - Menú

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Acerca de Pulcro", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Ocultar Pulcro", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Salir de Pulcro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edición")
        edit.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "Ver")
        view.addItem(withTitle: "Recargar", action: #selector(reload(_:)), keyEquivalent: "r")
        viewItem.submenu = view
        main.addItem(viewItem)

        let winItem = NSMenuItem()
        let win = NSMenu(title: "Ventana")
        win.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Cerrar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        main.addItem(winItem)

        NSApp.mainMenu = main
    }

    static let loadingPage = """
    <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    font:15px -apple-system;color:#888;background:transparent">Preparando Pulcro…</body></html>
    """

    static let noNodePage = """
    <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;
    font:15px -apple-system;color:#888;background:transparent;text-align:center;padding:20px"><b style="color:#d33">Pulcro necesita Node.js</b>
    <span>Instálalo con <code>brew install node</code> o desde nodejs.org y vuelve a abrir Pulcro.</span></body></html>
    """

    static let errorPage = """
    <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;
    font:15px -apple-system;color:#888;background:transparent"><b style="color:#d33">No se pudo iniciar el motor de Pulcro</b>
    <span>Revisa ~/Library/Application Support/Pulcro/server.log</span></body></html>
    """
}

// MARK: - Barra de menús (panel estilo CleanMyMac)

extension AppDelegate: WKScriptMessageHandler {
    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let img = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Pulcro")
            img?.isTemplate = true
            button.image = img
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // Panel: una página web del motor (public/menu.html) dentro de un NSPopover.
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "pulcro")
        panelWeb = WKWebView(frame: NSRect(x: 0, y: 0, width: 360, height: 640), configuration: config)
        panelWeb.setValue(false, forKey: "drawsBackground")
        let vc = NSViewController()
        vc.view = panelWeb
        popover = NSPopover()
        popover.contentViewController = vc
        popover.contentSize = NSSize(width: 360, height: 640)
        popover.behavior = .transient
        popover.animates = true
        popover.appearance = NSAppearance(named: .darkAqua)
        popover.delegate = self
        panelWeb.loadHTMLString(Self.loadingPage, baseURL: nil)

        // Clic derecho: menú rápido.
        quickMenu = NSMenu()
        let open = NSMenuItem(title: "Abrir Pulcro", action: #selector(showWindow(_:)), keyEquivalent: "o")
        open.target = self
        quickMenu.addItem(open)
        quickMenu.addItem(.separator())
        loginItem = NSMenuItem(title: "Abrir al iniciar sesión", action: #selector(toggleLogin), keyEquivalent: "")
        loginItem.target = self
        quickMenu.addItem(loginItem)
        quickMenu.addItem(.separator())
        let quit = NSMenuItem(title: "Salir de Pulcro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        quickMenu.addItem(quit)

        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in self?.refreshStatus() }
    }

    @objc func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            if popover.isShown { popover.performClose(nil) }
            loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
            statusItem.menu = quickMenu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        togglePanel()
    }

    func togglePanel() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = statusItem.button else { return }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        panelWeb.evaluateJavaScript("window.pulcroOpened && window.pulcroOpened()")
    }

    func popoverDidClose(_ notification: Notification) {
        panelWeb.evaluateJavaScript("window.pulcroClosed && window.pulcroClosed()")
        refreshStatus()
    }

    // Mensajes desde menu.js
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "resize":
            let maxH = (NSScreen.main?.visibleFrame.height ?? 800) - 30
            if let h = (body["height"] as? NSNumber)?.doubleValue, h > 100 {
                popover.contentSize = NSSize(width: 360, height: min(h, maxH))
            }
        case "open":
            popover.performClose(nil)
            showWindow(nil)
            if let view = body["view"] as? String, view.range(of: "^[a-z]+$", options: .regularExpression) != nil {
                webView.evaluateJavaScript("window.pulcroShow && window.pulcroShow('\(view)')")
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func fmt(_ bytes: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: bytes)
    }

    // Con poco espacio, junto al ícono aparece cuánto queda.
    func refreshStatus() {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let h = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self, let disk = h?["disk"] as? [String: Any] else { return }
                let free = (disk["free"] as? NSNumber)?.int64Value ?? 0
                let total = (disk["total"] as? NSNumber)?.int64Value ?? 1
                let freePct = Double(free) / Double(total) * 100
                self.statusItem.button?.title = freePct < 15 ? " \(self.fmt(free))" : ""
            }
        }.resume()
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = "No se pudo cambiar el inicio automático"
            a.informativeText = error.localizedDescription
            a.runModal()
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
