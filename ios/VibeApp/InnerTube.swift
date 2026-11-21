import Foundation

/// Keyless InnerTube client, ported from the Android shell (InnerTube.java).
///
/// Resolution happens on the phone's own connection, which is why YouTube does not treat it as a
/// datacenter bot. VISIONOS (client 101) is first: it still gets whole tracks without a PO token.
final class InnerTube {
    static let shared = InnerTube()

    private struct Client {
        let name: String
        let version: String
        let id: String
        let userAgent: String
        let extra: String
    }

    private static let player = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
    private static let search = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
    private static let visitorEndpoint = "https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false"

    private let clients: [Client] = [
        Client(
            name: "VISIONOS", version: "1.02", id: "101",
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
            extra: "\"deviceMake\":\"Apple\",\"deviceModel\":\"RealityDevice17,1\",\"osName\":\"visionOS\",\"osVersion\":\"26.5.23O471\""
        ),
        Client(
            name: "IOS", version: "21.26.3", id: "5",
            userAgent: "com.google.ios.youtube/21.26.3 (iPhone16,2; U; CPU iOS 18_5 like Mac OS X)",
            extra: "\"deviceMake\":\"Apple\",\"deviceModel\":\"iPhone16,2\",\"osName\":\"iPhone\",\"osVersion\":\"18.5.0.22F76\""
        ),
        Client(
            name: "ANDROID_VR", version: "1.65.10", id: "28",
            userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
            extra: "\"deviceMake\":\"Oculus\",\"deviceModel\":\"Quest 3\",\"osName\":\"Android\",\"osVersion\":\"12L\",\"androidSdkVersion\":32"
        ),
    ]

    private var visitor: String?
    private let visitorLock = NSLock()

    private init() {}

    // MARK: - Public answers (JSON strings, same shape as the Java bridge)

    /// The video id that actually holds this song, for a free-text query.
    ///
    /// `expectedSeconds` is the catalog length of the track. Without it YouTube's first result can
    /// be a slowed take, a loop or a compilation, which is how a 4:03 song ends up playing 8:14.
    func searchJSON(_ query: String, expectedSeconds: Int = 0) -> String {
        var reasons: [String] = []
        for client in clients {
            let body = "{\"context\":{\"client\":\(clientJSON(client))},\"query\":\(quoted(query))}"
            guard let text = post(Self.search, body: body, client: client) else {
                reasons.append("\(client.name) HTTP error")
                continue
            }
            rememberVisitor(text)
            if let chosen = bestVideo(in: text, query: query, expectedSeconds: expectedSeconds) {
                return json(["videoId": chosen.id, "client": client.name, "duration": chosen.seconds])
            }
            if let id = firstMatch(text, pattern: "\"videoId\":\"([A-Za-z0-9_-]{11})\"") {
                return json(["videoId": id, "client": client.name])
            }
            reasons.append("\(client.name) no results")
        }
        return failure(reasons)
    }

    // MARK: - Choosing the right upload

    private struct Candidate {
        let id: String
        let title: String
        let seconds: Int
    }

    /// Uploads that are not the song itself. A query that asks for one of them keeps it.
    private static let otherVersions = [
        "remix", "sped up", "spedup", "slowed", "nightcore", "8d", "1 hour", "hour loop",
        "loop", "extended", "instrumental", "karaoke", "reaction", "cover", "mashup",
        "full album", "playlist", "reverb", "bass boosted", "acapella", "tribute", "compilation",
    ]

    private func bestVideo(in text: String, query: String, expectedSeconds: Int) -> Candidate? {
        let all = candidates(in: text)
        guard !all.isEmpty else { return nil }
        let asked = query.lowercased()
        let clean = all.filter { !Self.isOtherVersion($0.title, asked: asked) }
        var pool = clean.isEmpty ? all : clean

        if expectedSeconds > 0 {
            let tolerance = max(20, Int(Double(expectedSeconds) * 0.15))
            let near = pool.filter { abs($0.seconds - expectedSeconds) <= tolerance }
            if !near.isEmpty {
                pool = near
            } else if let closest = pool.min(by: { abs($0.seconds - expectedSeconds) < abs($1.seconds - expectedSeconds) }) {
                pool = [closest]
            }
        }

        let words = Set(asked.split(separator: " ").map(String.init).filter { $0.count > 2 })
        var best: Candidate?
        var bestScore = Int.min
        for candidate in pool {
            let title = candidate.title.lowercased()
            let hits = words.filter { title.contains($0) }.count
            let delta = expectedSeconds > 0 ? abs(candidate.seconds - expectedSeconds) : 0
            let score = hits * 1000 - delta
            if score > bestScore {
                bestScore = score
                best = candidate
            }
        }
        return best
    }

    private static func isOtherVersion(_ title: String, asked: String) -> Bool {
        let lower = title.lowercased()
        return otherVersions.contains { lower.contains($0) && !asked.contains($0) }
    }

    /// Every result YouTube returned, with its real length.
    private func candidates(in text: String) -> [Candidate] {
        guard let data = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) else { return [] }
        var found: [Candidate] = []
        var seen = Set<String>()
        func walk(_ node: Any) {
            if let list = node as? [Any] {
                for item in list { walk(item) }
                return
            }
            guard let dict = node as? [String: Any] else { return }
            if let id = dict["videoId"] as? String, id.count == 11,
               let length = dict["lengthText"] as? [String: Any],
               let label = length["simpleText"] as? String,
               let seconds = Self.seconds(label),
               seen.insert(id).inserted {
                found.append(Candidate(id: id, title: Self.videoTitle(dict), seconds: seconds))
            }
            for value in dict.values { walk(value) }
        }
        walk(root)
        return found
    }

    private static func videoTitle(_ renderer: [String: Any]) -> String {
        guard let title = renderer["title"] as? [String: Any] else { return "" }
        if let text = title["simpleText"] as? String { return text }
        if let runs = title["runs"] as? [[String: Any]] {
            return runs.compactMap { $0["text"] as? String }.joined()
        }
        return ""
    }

    /// "4:03" or "1:02:03" to seconds.
    private static func seconds(_ label: String) -> Int? {
        let parts = label.split(separator: ":").compactMap { Int($0) }
        switch parts.count {
        case 2: return parts[0] * 60 + parts[1]
        case 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
        default: return nil
        }
    }

    /// Direct audio-only URL for a video id.
    func audioJSON(_ videoId: String) -> String {
        var reasons: [String] = []
        for client in clients {
            let body = "{\"context\":{\"client\":\(clientJSON(client))},\"videoId\":\"\(videoId)\",\"contentCheckOk\":true,\"racyCheckOk\":true}"
            guard let text = post(Self.player, body: body, client: client) else {
                reasons.append("\(client.name) HTTP error")
                continue
            }
            rememberVisitor(text)

            guard let root = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
                reasons.append("\(client.name) unreadable answer")
                continue
            }
            if let playability = root["playabilityStatus"] as? [String: Any],
               let status = playability["status"] as? String, status != "OK" {
                let reason = playability["reason"] as? String ?? status
                reasons.append("\(client.name): \(reason)")
                continue
            }
            guard let streaming = root["streamingData"] as? [String: Any] else {
                reasons.append("\(client.name): no streamingData")
                continue
            }
            if let chosen = chooseAudio(streaming["adaptiveFormats"] as? [[String: Any]])
                ?? chooseAudio(streaming["formats"] as? [[String: Any]]) {
                return json(["url": chosen.url, "client": client.name, "itag": chosen.itag])
            }
            if let sabr = streaming["serverAbrStreamingUrl"] as? String, !sabr.isEmpty {
                reasons.append("\(client.name): SABR only (no plain audio url)")
            } else {
                reasons.append("\(client.name): no audio format")
            }
        }
        return failure(reasons)
    }

    // MARK: - Internals

    /// AAC 128k (140) first, then Opus 160k (251), then the highest bitrate plain URL.
    private func chooseAudio(_ formats: [[String: Any]]?) -> (url: String, itag: Int)? {
        guard let formats else { return nil }
        var best: (url: String, itag: Int, bitrate: Int)?
        for format in formats {
            let mime = format["mimeType"] as? String ?? ""
            guard mime.hasPrefix("audio/"), let url = format["url"] as? String, !url.isEmpty else { continue }
            let itag = format["itag"] as? Int ?? 0
            if itag == 140 || itag == 251 { return (url, itag) }
            let bitrate = format["bitrate"] as? Int ?? 0
            if best == nil || bitrate > best!.bitrate { best = (url, itag, bitrate) }
        }
        guard let best else { return nil }
        return (best.url, best.itag)
    }

    private func clientJSON(_ client: Client) -> String {
        clientJSON(client, visitorText: visitorText())
    }

    private func clientJSON(_ client: Client, visitorText: String) -> String {
        var fields = "\"clientName\":\"\(client.name)\",\"clientVersion\":\"\(client.version)\",\"hl\":\"en\",\"gl\":\"US\""
        if !visitorText.isEmpty { fields += ",\"visitorData\":\(quoted(visitorText))" }
        if !client.extra.isEmpty { fields += ",\(client.extra)" }
        return "{\(fields)}"
    }

    private func post(_ endpoint: String, body: String, client: Client) -> String? {
        guard let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(client.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(client.id, forHTTPHeaderField: "X-Youtube-Client-Name")
        request.setValue(client.version, forHTTPHeaderField: "X-Youtube-Client-Version")
        request.setValue("2", forHTTPHeaderField: "X-Goog-Api-Format-Version")
        request.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")
        request.setValue("https://www.youtube.com", forHTTPHeaderField: "Origin")
        if let visitor, !visitor.isEmpty { request.setValue(visitor, forHTTPHeaderField: "X-Goog-Visitor-Id") }

        let semaphore = DispatchSemaphore(value: 0)
        var answer: String?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data else { return }
            answer = String(decoding: data, as: UTF8.self)
        }.resume()
        _ = semaphore.wait(timeout: .now() + 20)
        return answer
    }

    /// The anonymous session id: without it VISIONOS answers LOGIN_REQUIRED / bot check.
    private func visitorText() -> String {
        visitorLock.lock()
        defer { visitorLock.unlock() }
        if let visitor { return visitor }
        var found = parseVisitor(requestVisitor())
        if found == nil { found = parseVisitor(homePage()) }
        let value = found ?? ""
        visitor = value
        return value
    }

    private func requestVisitor() -> String? {
        let client = clients[0]
        let body = "{\"context\":{\"client\":\(clientJSON(client, visitorText: ""))}}"
        return post(Self.visitorEndpoint, body: body, client: client)
    }

    private func homePage() -> String? {
        guard let url = URL(string: "https://www.youtube.com/") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue(clients[0].userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")
        request.setValue("CONSENT=PENDING+742", forHTTPHeaderField: "Cookie")
        let semaphore = DispatchSemaphore(value: 0)
        var answer: String?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { semaphore.signal() }
            if let data { answer = String(decoding: data, as: UTF8.self) }
        }.resume()
        _ = semaphore.wait(timeout: .now() + 20)
        return answer
    }

    private func parseVisitor(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        if let data = text.data(using: .utf8),
           let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let context = root["responseContext"] as? [String: Any],
               let found = context["visitorData"] as? String, !found.isEmpty {
                return found
            }
            if let context = root["context"] as? [String: Any],
               let client = context["client"] as? [String: Any],
               let found = client["visitorData"] as? String, !found.isEmpty {
                return found
            }
        }
        return firstMatch(text, pattern: "\"visitorData\"\\s*:\\s*\"([^\"]{20,})\"")
    }

    private func rememberVisitor(_ text: String) {
        visitorLock.lock()
        defer { visitorLock.unlock() }
        if let visitor, !visitor.isEmpty { return }
        guard let found = parseVisitor(text), !found.isEmpty else { return }
        visitor = found
    }

    private func firstMatch(_ text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1,
              let found = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[found])
    }

    private func quoted(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    private func json(_ fields: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: fields),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"could not build result\"}"
        }
        return text
    }

    private func failure(_ reasons: [String]) -> String {
        json(["error": reasons.isEmpty ? "no InnerTube client answered" : reasons.joined(separator: "; "), "client": "none"])
    }
}
