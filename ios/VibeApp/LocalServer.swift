import Foundation
import Network

/// A tiny HTTP/1.1 server on 127.0.0.1, standing in for Android's appassets origin.
///
/// It exists for two reasons a custom URL scheme cannot cover: the page gets a real HTTP origin
/// (so localStorage, fetch and CORS behave), and saved songs are answered with byte ranges, which
/// WKWebView needs to seek inside an <audio> element.
final class LocalServer {
    static let shared = LocalServer()
    static let port: UInt16 = 8737

    private let queue = DispatchQueue(label: "vibe.http")
    private var listener: NWListener?
    private let webRoot: URL
    private let offlineRoot: URL

    private init() {
        webRoot = Bundle.main.bundleURL.appendingPathComponent("Web", isDirectory: true)
        offlineRoot = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: offlineRoot, withIntermediateDirectories: true)
    }

    var origin: String { "http://127.0.0.1:\(Self.port)" }

    func start() {
        guard listener == nil, let port = NWEndpoint.Port(rawValue: Self.port) else { return }
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters, on: port)
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            NSLog("vibe: local server failed: \(error)")
        }
    }

    // MARK: - Connection handling

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let chunk { buffer.append(chunk) }
            if error != nil {
                connection.cancel()
                return
            }
            if let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
                self.respond(head: head, connection: connection)
                return
            }
            if isComplete || buffer.count > 1024 * 1024 {
                connection.cancel()
                return
            }
            self.read(connection, buffer: buffer)
        }
    }

    private func respond(head: String, connection: NWConnection) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").components(separatedBy: " ")
        guard parts.count >= 2 else {
            connection.cancel()
            return
        }
        let method = parts[0]
        var path = parts[1].components(separatedBy: "?")[0]
        path = path.removingPercentEncoding ?? path

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        if path.hasPrefix(OfflineStore.route) {
            let name = String(path.dropFirst(OfflineStore.route.count))
            guard let file = OfflineStore.file(named: name) else {
                send(status: "404 Not Found", mime: "text/plain", body: Data("not saved".utf8), method: method, connection: connection)
                return
            }
            serve(file: file, mime: OfflineStore.mime(for: name), range: headers["range"], method: method, connection: connection)
            return
        }

        if path == "/" { path = "/index.html" }
        guard path.hasPrefix("/"), !path.contains("..") else {
            send(status: "403 Forbidden", mime: "text/plain", body: Data("no".utf8), method: method, connection: connection)
            return
        }
        let file = webRoot.appendingPathComponent(String(path.dropFirst()))
        guard FileManager.default.fileExists(atPath: file.path) else {
            // Single-page app: unknown paths fall back to the shell.
            let shell = webRoot.appendingPathComponent("index.html")
            serve(file: shell, mime: "text/html; charset=utf-8", range: nil, method: method, connection: connection)
            return
        }
        serve(file: file, mime: Self.mime(for: file.pathExtension), range: headers["range"], method: method, connection: connection)
    }

    // MARK: - Responding

    private func serve(file: URL, mime: String, range: String?, method: String, connection: NWConnection) {
        guard let handle = try? FileHandle(forReadingFrom: file) else {
            send(status: "404 Not Found", mime: "text/plain", body: Data("missing".utf8), method: method, connection: connection)
            return
        }
        defer { try? handle.close() }

        let length = (try? handle.seekToEnd()) ?? 0
        var start: UInt64 = 0
        var end: UInt64 = length > 0 ? length - 1 : 0
        var partial = false

        if let range, range.lowercased().hasPrefix("bytes="), length > 0 {
            let spec = String(range.dropFirst(6).split(separator: ",")[0])
            let bounds = spec.split(separator: "-", omittingEmptySubsequences: false)
            if bounds.count == 2 {
                if let from = UInt64(String(bounds[0])) { start = from }
                if let to = UInt64(String(bounds[1])) { end = min(to, length - 1) }
                partial = true
            }
        }
        if start >= length {
            start = 0
            end = length > 0 ? length - 1 : 0
            partial = false
        }
        if end < start { end = length > 0 ? length - 1 : 0 }
        let count = length == 0 ? 0 : end - start + 1

        try? handle.seek(toOffset: start)
        let body = count > 0 ? ((try? handle.read(upToCount: Int(count))) ?? Data()) : Data()

        var response = "HTTP/1.1 \(partial ? "206 Partial Content" : "200 OK")\r\n"
        response += "Content-Type: \(mime)\r\n"
        response += "Content-Length: \(body.count)\r\n"
        response += "Accept-Ranges: bytes\r\n"
        response += "Access-Control-Allow-Origin: *\r\n"
        response += "Cache-Control: no-store\r\n"
        if partial { response += "Content-Range: bytes \(start)-\(end)/\(length)\r\n" }
        response += "Connection: close\r\n\r\n"

        send(text: response, body: method == "HEAD" ? Data() : body, connection: connection)
    }

    private func send(status: String, mime: String, body: Data, method: String, connection: NWConnection) {
        var response = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        response += method == "HEAD" ? "" : String(decoding: body, as: UTF8.self)
        send(text: response, body: Data(), connection: connection)
    }

    private func send(text: String, body: Data, connection: NWConnection) {
        var payload = Data(text.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "webm": return "audio/webm"
        default: return "application/octet-stream"
        }
    }
}
