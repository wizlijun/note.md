import AppKit
import WebKit

// A standalone, nonpersistent WebKit process. Only the served fixture directory
// is readable by the protocol. Real note.md and its RPC/config are never opened.
final class Harness: NSObject, NSApplicationDelegate, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    let output = CommandLine.arguments[1]
    let root = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
    var window: NSWindow!
    var webView: WKWebView!
    var events: [[String: Any]] = []
    var finished = false
    let uiMode = CommandLine.arguments.contains("--ui")
    var settings: [String: Any] = ["browser": ["from":"2026-09-01", "to":"2026-09-30", "view":"3d"]]
    var atlas: Any = NSNull()
    lazy var fixture: [String: Any] = (try! JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("fixture-data.json")))) as! [String: Any]

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func writeEvents() {
        guard uiMode else { return }
        let report: [String: Any] = ["mode":"production-ui", "scheme":"plugin://notemd.strata", "storage":"nonPersistent", "rpc":"synthetic-only", "events":events]
        if let bytes=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]) { try? bytes.write(to:URL(fileURLWithPath:output).appendingPathComponent("ui-events.json")) }
    }
    func rpc(_ method: String, _ params: [String: Any]) -> Any? {
        guard uiMode else { return method == "host.vault.info" ? ["root":"/synthetic-strata-vault"] : nil }
        events.append(["kind":"rpc", "method":method, "params":params]); defer { writeEvents() }
        switch method {
        case "host.vault.info": return ["root":"/synthetic-strata-vault"]
        case "host.settings.get": return ["settings":settings]
        case "host.settings.set":
            if let key=params["key"] as? String, let value=params["value"] { settings[key]=value }; return ["ok":true]
        case "host.agent.providers": return ["providers":[], "default":""]
        case "plugin.atlas.load": return ["atlas":atlas]
        case "plugin.atlas.save": atlas=params["atlas"] ?? NSNull(); return ["ok":true]
        case "host.index.status": return ["valid":true, "freshness":"current", "snapshotId":"fixture-snapshot"]
        case "plugin.job": return NSNull()
        case "plugin.snapshot":
            let files=fixture["files"] as! [[String:Any]], nodes=fixture["nodes"] as! [[String:Any]]
            let from=params["from"] as? String ?? "", to=params["to"] as? String ?? ""
            let selected=files.enumerated().filter { let date=$0.element["docDate"] as! String; return date>=from && date<=to }
            let verified=selected.filter {nodes[$0.offset]["state"] as? String == "verified"}.count
            return ["schema":"notemd.strata/snapshot/v1", "vaultKey":"fixture-only", "snapshotId":"fixture-snapshot", "configHash":"fixture-config", "asOf":"2026-09-30", "range":params, "files":files, "nodes":nodes, "relations":fixture["relations"]!, "job":NSNull(), "coverage":["indexed":40,"selected":selected.count,"processed":verified,"candidate":selected.count-verified,"excluded":0,"stale":0,"proofDeferred":0,"dateInferred":selected.filter{$0.element["dateInferred"] as? Bool == true}.count,"confidential":0,"unknownConfidentiality":selected.filter{$0.element["confidentiality"] as? String == "unknown"}.count]]
        case "plugin.open_source":
            let nodes=fixture["nodes"] as! [[String:Any]]
            guard let index=nodes.firstIndex(where:{$0["id"] as? String == params["nodeId"] as? String}) else { return nil }
            let files=fixture["files"] as! [[String:Any]]
            return ["path":files[index]["path"]!,"lineStart":4,"lineEnd":4]
        case "host.editor.open": return ["ok":true,"fixtureOnly":true]
        default: return nil
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "plugin")
        config.userContentController.add(self, name: "qa")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: uiMode ? 1280 : 1050, height: uiMode ? 840 : 650), configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = uiMode ? "STRATA — 原生 WebKit 合成数据验收" : "STRATA isolated WebKit Worker QA — synthetic data only"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore(url: URL(fileURLWithPath: output))!.compileContentRuleList(forIdentifier: "strata-worker-isolation", encodedContentRuleList: rules) { list, error in
            guard let list = list else { self.finish(ok: false, reason: "Cannot install network block: \(String(describing:error))"); return }
            config.userContentController.add(list)
            self.webView.load(URLRequest(url: URL(string: "plugin://notemd.strata/index.html")!))
        }
        if uiMode {
            print("STRATA_UI_READY: \(output)"); fflush(stdout)
            writeEvents()
        } else { DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.finish(ok: false, reason: "Native WebKit fixture timed out") } }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "plugin", url.host == "notemd.strata" else {
            task.didFailWithError(NSError(domain: "fixture", code: 403)); return
        }
        events.append(["kind": "resource", "url": url.absoluteString, "method": task.request.httpMethod ?? "GET"])
        if url.path == "/__rpc__" && task.request.httpMethod == "POST" {
            let request = (try? JSONSerialization.jsonObject(with: requestBody(task.request))) as? [String: Any] ?? [:]
            let method = request["method"] as? String ?? ""
            let value=rpc(method,request["params"] as? [String:Any] ?? [:])
            let object: [String: Any] = value != nil
                ? ["jsonrpc":"2.0", "id":request["id"] ?? NSNull(), "result":value!]
                : ["jsonrpc":"2.0", "id":request["id"] ?? NSNull(), "error":["code":-32601,"message":"Unexpected fixture RPC: \(method)"]]
            respond(task, url: url, bytes: try! JSONSerialization.data(withJSONObject: object), mime: "application/json"); return
        }
        let path = root.appendingPathComponent(url.path == "/" ? "index.html" : String(url.path.dropFirst())).standardizedFileURL
        guard path.path.hasPrefix(root.path + "/"), let bytes = try? Data(contentsOf: path) else {
            task.didFailWithError(NSError(domain: "fixture", code: 404)); return
        }
        let mime = path.pathExtension == "html" ? "text/html" : path.pathExtension == "js" ? "text/javascript" : path.pathExtension == "css" ? "text/css" : "application/octet-stream"
        respond(task, url: url, bytes: bytes, mime: mime)
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    func requestBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data=Data(); var buffer=[UInt8](repeating:0,count:4096)
        while stream.hasBytesAvailable { let count=stream.read(&buffer,maxLength:buffer.count); if count<=0 {break}; data.append(buffer,count:count) }
        return data
    }
    func respond(_ task: WKURLSchemeTask, url: URL, bytes: Data, mime: String) {
        var headers=["Content-Type":mime+"; charset=utf-8","Cache-Control":"no-cache"]
        if mime == "text/html" { headers["Content-Security-Policy"]=try! String(contentsOf:root.appendingPathComponent("plugin-csp.txt"),encoding:.utf8) }
        task.didReceive(HTTPURLResponse(url:url,statusCode:200,httpVersion:"HTTP/1.1",headerFields:headers)!)
        task.didReceive(bytes); task.didFinish()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.scheme == "plugin" && action.request.url?.host == "notemd.strata" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(ok:false,reason:error.localizedDescription) }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body=message.body as? [String:Any], !finished else {return}
        events.append(body); writeEvents()
        if !uiMode && body["kind"] as? String == "complete" {finish(ok:body["ok"] as? Bool == true,reason:body["error"] as? String ?? "All Worker checks passed")}
    }
    func finish(ok:Bool,reason:String) {
        guard !finished else{return};finished=true
        let result:[String:Any]=["status":ok ? "passed":"failed","reason":reason,"storage":"WKWebsiteDataStore.nonPersistent","scheme":"plugin://notemd.strata","events":events]
        let bytes=try! JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
        try! bytes.write(to:URL(fileURLWithPath:output).appendingPathComponent("result.json"))
        print(String(data:bytes,encoding:.utf8)!)
        webView.takeSnapshot(with:nil) {image,error in
            if let image=image,let tiff=image.tiffRepresentation,let rep=NSBitmapImageRep(data:tiff),let png=rep.representation(using:.png,properties:[:]) {try? png.write(to:URL(fileURLWithPath:self.output).appendingPathComponent("worker.png"))}
            exit(ok ? 0:1)
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+3){exit(ok ? 0:1)}
    }
}
let app=NSApplication.shared
app.setActivationPolicy(CommandLine.arguments.contains("--ui") ? .regular : .accessory)
let harness=Harness();app.delegate=harness;app.run()
