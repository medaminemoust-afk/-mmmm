import UIKit
import WebKit

/// The shell: a full-screen WKWebView on the bundled site, with the same VibeNative bridge the
/// Android build exposes (searchYouTube, resolveStream, downloadSong, listDownloads, removeDownload).
final class VibeViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.03, green: 0.05, blue: 0.11, alpha: 1)

        LocalServer.shared.start()

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.bridgeSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(self, name: "vibe")

        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.bounces = false
        webView.customUserAgent = "\(webView.customUserAgent ?? "") VibeApp/1.2"
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        view.addSubview(webView)

        MediaBridge.shared.evaluate = { [weak self] script in
            DispatchQueue.main.async { self?.webView.evaluateJavaScript(script, completionHandler: nil) }
        }

        webView.load(URLRequest(url: URL(string: "\(LocalServer.shared.origin)/index.html")!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - Bridge

    /// Same synchronous API the page expects on Android, forwarded through the message handler.
    private static let bridgeSource = """
    window.__vibePlatform = 'ios';
    window.VibeNative = {
      searchYouTube: function (artist, title, id) {
        window.webkit.messageHandlers.vibe.postMessage({ method: 'searchYouTube', args: [artist, title], id: id });
      },
      resolveStream: function (videoId, id) {
        window.webkit.messageHandlers.vibe.postMessage({ method: 'resolveStream', args: [videoId], id: id });
      },
      downloadSong: function (url, key, meta, id) {
        window.webkit.messageHandlers.vibe.postMessage({ method: 'downloadSong', args: [url, key, meta], id: id });
      },
      listDownloads: function (id) {
        window.webkit.messageHandlers.vibe.postMessage({ method: 'listDownloads', args: [], id: id });
      },
      removeDownload: function (key, id) {
        window.webkit.messageHandlers.vibe.postMessage({ method: 'removeDownload', args: [key], id: id });
      }
    };
    """

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        let callbackId = body["id"] as? Int ?? 0

        func text(_ index: Int) -> String {
            guard index < args.count, let value = args[index] as? String else { return "" }
            return value
        }

        switch method {
        case "searchYouTube":
            let query = "\(text(0)) \(text(1)) official audio"
            work {
                var answer = InnerTube.shared.searchJSON(query)
                if answer.contains("\"error\"") {
                    answer = InnerTube.shared.searchJSON("\(text(0)) \(text(1))")
                }
                self.deliver(callbackId, answer)
            }

        case "resolveStream":
            let videoId = text(0)
            work { self.deliver(callbackId, InnerTube.shared.audioJSON(videoId)) }

        case "downloadSong":
            OfflineStore.download(url: text(0), key: text(1), metaJSON: text(2)) { answer in
                self.deliver(callbackId, answer)
            }

        case "listDownloads":
            work { self.deliver(callbackId, OfflineStore.list()) }

        case "removeDownload":
            let key = text(0)
            work { self.deliver(callbackId, OfflineStore.remove(key: key)) }

        case "nowPlaying":
            let position = Double(text(4)) ?? 0
            let duration = Double(text(5)) ?? 0
            MediaBridge.shared.update(
                title: text(0), artist: text(1), artwork: text(2),
                playing: text(3) == "true", positionMs: position, durationMs: duration
            )

        default:
            deliver(callbackId, "{\"error\":\"unknown bridge method\"}")
        }
    }

    private func work(_ block: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async(execute: block)
    }

    /// Hands a JSON answer back to the page, the way MainActivity.deliver does.
    private func deliver(_ callbackId: Int, _ json: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [json]),
              let encoded = String(data: data, encoding: .utf8) else { return }
        let literal = String(encoded.dropFirst().dropLast())
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(
                "window.__vibeNativeCb && window.__vibeNativeCb(\(callbackId), \(literal))",
                completionHandler: nil
            )
        }
    }
}
