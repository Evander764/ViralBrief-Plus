import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var port = "8787"

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 设置 Dock 图标以防作为独立进程运行时 Dock 图标为白板
        var iconImage: NSImage? = nil
        if let iconPath = Bundle.main.path(forResource: "AppIcon", ofType: "icns") {
            iconImage = NSImage(contentsOfFile: iconPath)
        }
        if iconImage == nil {
            let exePath = URL(fileURLWithPath: CommandLine.arguments[0])
            let resourcesURL = exePath.deletingLastPathComponent().appendingPathComponent("../Resources/AppIcon.icns")
            iconImage = NSImage(contentsOf: resourcesURL)
        }
        if let image = iconImage {
            NSApplication.shared.applicationIconImage = image
        }

        // 从环境变量中读取端口
        if let envPort = ProcessInfo.processInfo.environment["VBP_PORT"] ?? ProcessInfo.processInfo.environment["VB_PORT"] {
            port = envPort
        }
        
        setupMenu()
        
        let screenRect = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let width: CGFloat = 1200
        let height: CGFloat = 800
        let x = (screenRect.width - width) / 2
        let y = (screenRect.height - height) / 2
        
        // 创建原生 macOS 窗口，保留原生的红绿灯标题栏与调整大小支持
        window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Viral Brief Plus"
        window.delegate = self
        
        // 使用 macOS 原生 WebKit (Safari 同款引擎)
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        window.contentView = webView
        
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        
        // 清除 WebKit 缓存以防止旧前端代码在升级时被缓存
        let websiteDataTypes = NSSet(array: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache])
        let dateFrom = Date(timeIntervalSince1970: 0)
        WKWebsiteDataStore.default().removeData(ofTypes: websiteDataTypes as! Set<String>, modifiedSince: dateFrom) {}
        
        let url = URL(string: "http://127.0.0.1:\(port)")!
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10.0)
        webView.load(request)
        
        // 轮询检查 Node 服务是否已启动
        pollServer(request: request)
    }
    
    func pollServer(request: URLRequest) {
        let task = URLSession.shared.dataTask(with: request.url!) { [weak self] _, response, error in
            if error != nil {
                // 服务端还未启动，0.5秒后重试
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self?.pollServer(request: request)
                }
            } else {
                // 启动就绪，加载网页
                DispatchQueue.main.async {
                    self?.webView.load(request)
                }
            }
        }
        task.resume()
    }
    
    func setupMenu() {
        let mainMenu = NSMenu()
        
        // App 菜单
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        
        // 编辑菜单 (确保复制粘贴等快捷键 Cmd+C, Cmd+V 能在 WKWebView 中正常生效)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: #selector(UndoManager.undo), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: #selector(UndoManager.redo), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        
        NSApp.mainMenu = mainMenu
    }

    func isLocalDashboardURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        let host = url.host?.lowercased() ?? ""
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    func shouldOpenExternally(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        return !isLocalDashboardURL(url)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, let url = navigationAction.request.url else {
            return nil
        }
        if shouldOpenExternally(url) {
            NSWorkspace.shared.open(url)
        } else {
            webView.load(navigationAction.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, shouldOpenExternally(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "提示"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "请确认"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "请输入"
        alert.informativeText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
