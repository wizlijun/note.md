import AppKit
import WebKit

final class Harness: NSObject, NSApplicationDelegate, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    let output = CommandLine.arguments[1]
    let pluginRoot = CommandLine.arguments[2]
    let fixtureRoot = CommandLine.arguments[3]
    let cases = ["supported", "unsupported"]
    var index = 0
    var window: NSWindow!
    var webView: WKWebView!
    var timeout: DispatchWorkItem?
    var events: [[String: Any]] = []
    var failed = false
    var finishing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1000, height: 760), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Isolated file-view WebKit QA — fixture data only"
        window.appearance = NSAppearance(named: .aqua)
        window.makeKeyAndOrderFront(nil)
        runNext()
    }

    func runNext() {
        if index == cases.count { print("WK_FILE_VIEWS_COMPLETE failed=\(failed)"); exit(failed ? 1 : 0) }
        finishing = false
        events = []
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "tauri")
        config.setURLSchemeHandler(self, forURLScheme: "plugin")
        config.userContentController.add(self, name: "qa")
        let driver = try! String(contentsOfFile: "\(fixtureRoot)/driver.js", encoding: .utf8).replacingOccurrences(of: "__SCENARIO__", with: cases[index])
        config.userContentController.addUserScript(WKUserScript(source: driver, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 760), configuration: config)
        webView.navigationDelegate = self
        window.contentView = webView
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore(url: URL(fileURLWithPath: output))!.compileContentRuleList(forIdentifier: "notemd-file-view-isolation", encodedContentRuleList: rules) { list, error in
            guard let list = list else { print("RULE_ERROR \(String(describing:error))"); exit(2) }
            config.userContentController.add(list)
            self.webView.load(URLRequest(url: URL(string: "tauri://localhost/index.html?case=\(self.cases[self.index])")!))
        }
        let item = DispatchWorkItem { self.finish(ok: false, reason: "native harness timeout") }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: item)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let isPlugin = url.scheme == "plugin" && url.host == "notemd.timeline"
        let isHost = url.scheme == "tauri" && url.host == "localhost"
        guard isPlugin || isHost else { urlSchemeTask.didFailWithError(NSError(domain: "fixture", code: 403)); return }
        let root = URL(fileURLWithPath: isPlugin ? pluginRoot : "\(output)/host").standardizedFileURL
        let path = root.appendingPathComponent(url.path == "/" ? "index.html" : String(url.path.dropFirst())).standardizedFileURL
        guard path.path.hasPrefix(root.path + "/"), let bytes = try? Data(contentsOf: path) else {
            events.append(["kind": "missing-resource", "url": url.absoluteString])
            urlSchemeTask.didFailWithError(NSError(domain: "fixture", code: 404)); return
        }
        let mime: String
        switch path.pathExtension { case "html": mime = "text/html"; case "js": mime = "text/javascript"; case "css": mime = "text/css"; default: mime = "application/octet-stream" }
        var headers = ["Content-Type": mime + "; charset=utf-8"]
        if isPlugin && path.pathExtension == "html" { headers["Content-Security-Policy"] = try! String(contentsOfFile: "\(output)/plugin-csp.txt", encoding: .utf8) }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(bytes)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url!
        if (url.scheme == "tauri" && url.host == "localhost") || (url.scheme == "plugin" && url.host == "notemd.timeline") {
            decisionHandler(.allow)
        } else {
            events.append(["kind": "blocked-navigation", "url": url.absoluteString])
            decisionHandler(.cancel)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], !finishing else { return }
        events.append(body)
        if body["kind"] as? String == "plugin-complete" && cases[index] == "supported" {
            webView.takeSnapshot(with: nil) { image, error in
                if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: "\(self.output)/supported-timeline.png"))
                }
                self.webView.evaluateJavaScript("window.qaSnapshotDone = true", in: message.frameInfo, in: .page) { _ in }
            }
        }
        if body["kind"] as? String == "failed" { finish(ok: false, reason: body["error"] as? String ?? "JavaScript failure") }
        if body["kind"] as? String == "complete" {
            let pluginComplete = events.contains { $0["kind"] as? String == "plugin-complete" }
            finish(ok: pluginComplete, reason: pluginComplete ? "all frame checks passed" : "missing plugin checks")
        }
    }

    func finish(ok: Bool, reason: String) {
        guard !finishing else { return }
        finishing = true
        timeout?.cancel()
        failed = failed || !ok
        let result: [String: Any] = ["scenario": cases[index], "status": ok ? "passed" : "failed", "reason": reason, "storage": "WKWebsiteDataStore.nonPersistent", "events": events]
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        try! data.write(to: URL(fileURLWithPath: "\(output)/\(cases[index]).json"))
        print(String(data: data, encoding: .utf8)!)
        webView.takeSnapshot(with: nil) { image, error in
            if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(self.output)/\(self.cases[self.index]).png"))
            }
            self.webView.configuration.userContentController.removeScriptMessageHandler(forName: "qa")
            self.index += 1
            DispatchQueue.main.async { self.runNext() }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let harness = Harness()
app.delegate = harness
app.run()
