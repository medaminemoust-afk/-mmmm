import Foundation

/// Music saved on the phone, mirroring OfflineStore.java.
///
/// A download is the full audio stream written to Documents/offline plus a small index entry.
/// LocalServer answers /dl/<file> so the <audio> element gets a normal same-origin response with
/// byte ranges — playback keeps working in airplane mode.
enum OfflineStore {
    static let route = "/dl/"

    static var directory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static let lock = NSLock()

    // MARK: - Index

    private static var indexURL: URL { directory.appendingPathComponent("index.json") }

    private static func readIndex() -> [String: [String: Any]] {
        guard let data = try? Data(contentsOf: indexURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else {
            return [:]
        }
        return root
    }

    private static func writeIndex(_ index: [String: [String: Any]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    static func safeKey(_ key: String) -> String {
        var out = ""
        for character in key {
            guard out.count < 64 else { break }
            if character.isLetter || character.isNumber || character == "_" || character == "-" {
                out.append(character)
            }
        }
        return out
    }

    // MARK: - Download

    /// Downloads a whole stream. Completion runs on the main queue with the bridge's JSON answer.
    static func download(url: String, key: String, metaJSON: String, completion: @escaping (String) -> Void) {
        guard let source = URL(string: url), !url.isEmpty else {
            completion(failure("no audio url to download"))
            return
        }
        let safe = safeKey(key)
        guard !safe.isEmpty else {
            completion(failure("bad track key"))
            return
        }

        var request = URLRequest(url: source, timeoutInterval: 60)
        request.setValue("vibe/1.8 (iOS; offline cache)", forHTTPHeaderField: "User-Agent")
        request.setValue("*/*", forHTTPHeaderField: "Accept")

        URLSession.shared.downloadTask(with: request) { temporary, response, problem in
            guard let temporary else {
                completion(failure("download failed: \(problem?.localizedDescription ?? "no answer")"))
                return
            }
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            guard status == 200 || status == 206 else {
                completion(failure("download HTTP \(status)"))
                return
            }
            var mime = http?.value(forHTTPHeaderField: "Content-Type") ?? "audio/mp4"
            if !mime.hasPrefix("audio/") { mime = "audio/mp4" }
            if let semicolon = mime.firstIndex(of: ";") { mime = String(mime[..<semicolon]).trimmingCharacters(in: .whitespaces) }
            let ext = mime.contains("webm") ? ".webm" : mime.contains("ogg") ? ".ogg" : mime.contains("mpeg") ? ".mp3" : ".m4a"

            let attributes = try? FileManager.default.attributesOfItem(atPath: temporary.path)
            let bytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0
            guard bytes >= 100_000 else {
                // A truncated fragment plays ten seconds and stops: better to save nothing.
                try? FileManager.default.removeItem(at: temporary)
                completion(failure("the stream stopped after \(bytes) bytes"))
                return
            }

            let target = directory.appendingPathComponent(safe + ext)
            try? FileManager.default.removeItem(at: target)
            do {
                try FileManager.default.moveItem(at: temporary, to: target)
            } catch {
                completion(failure("download failed: \(error.localizedDescription)"))
                return
            }
            for other in [".m4a", ".webm", ".ogg", ".mp3"] where other != ext {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(safe + other))
            }

            var entry = (try? JSONSerialization.jsonObject(with: Data(metaJSON.utf8)) as? [String: Any]) ?? [:]
            entry["key"] = safe
            entry["file"] = target.lastPathComponent
            entry["mime"] = mime
            entry["bytes"] = bytes
            entry["savedAt"] = Int(Date().timeIntervalSince1970 * 1000)

            lock.lock()
            var index = readIndex()
            index[safe] = entry
            writeIndex(index)
            lock.unlock()

            completion(json(["ok": true, "key": safe, "file": target.lastPathComponent, "mime": mime, "bytes": bytes]))
        }.resume()
    }

    // MARK: - List / remove

    static func list() -> String {
        lock.lock()
        defer { lock.unlock() }
        let index = readIndex()
        var kept: [String: [String: Any]] = [:]
        var out: [[String: Any]] = []
        for (key, stored) in index {
            var entry = stored
            guard let name = entry["file"] as? String else { continue }
            let file = directory.appendingPathComponent(name)
            let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
            let bytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0
            guard bytes > 0 else { continue }
            entry["bytes"] = bytes
            kept[key] = entry
            out.append(entry)
        }
        if kept.count != index.count { writeIndex(kept) }
        out.sort { (($0["savedAt"] as? Int) ?? 0) > (($1["savedAt"] as? Int) ?? 0) }
        guard let data = try? JSONSerialization.data(withJSONObject: out),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    static func remove(key: String) -> String {
        let safe = safeKey(key)
        lock.lock()
        var index = readIndex()
        if let entry = index[safe], let name = entry["file"] as? String {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
            index.removeValue(forKey: safe)
            writeIndex(index)
        }
        lock.unlock()
        return "{\"ok\":true}"
    }

    // MARK: - Serving

    static func mime(for name: String) -> String {
        lock.lock()
        let index = readIndex()
        lock.unlock()
        for entry in index.values where (entry["file"] as? String) == name {
            if let mime = entry["mime"] as? String, !mime.isEmpty { return mime }
        }
        if name.hasSuffix(".webm") { return "audio/webm" }
        if name.hasSuffix(".ogg") { return "audio/ogg" }
        if name.hasSuffix(".mp3") { return "audio/mpeg" }
        return "audio/mp4"
    }

    static func file(named name: String) -> URL? {
        guard !name.isEmpty, !name.contains("/"), !name.contains("..") else { return nil }
        let file = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return file
    }

    private static func failure(_ message: String) -> String {
        json(["error": message])
    }

    private static func json(_ fields: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: fields),
              let text = String(data: data, encoding: .utf8) else { return "{\"error\":\"download failed\"}" }
        return text
    }
}
