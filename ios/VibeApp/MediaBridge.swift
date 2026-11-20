import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Lock screen, Control Center and AirPods controls — the iOS counterpart of
/// VibePlaybackService.java. The page keeps owning playback; this only mirrors it and forwards
/// the buttons back into the web app.
final class MediaBridge {
    static let shared = MediaBridge()

    /// Set by VibeViewController: runs a line of JavaScript in the page.
    var evaluate: ((String) -> Void)?

    private var started = false

    private init() {}

    func start() {
        guard !started else { return }
        started = true

        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)

        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.play && window.__vibeMedia.play();")
            return .success
        }
        center.pauseCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.pause && window.__vibeMedia.pause();")
            return .success
        }
        center.togglePlayPauseCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.toggle && window.__vibeMedia.toggle();")
            return .success
        }
        center.nextTrackCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.next && window.__vibeMedia.next();")
            return .success
        }
        center.previousTrackCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.previous && window.__vibeMedia.previous();")
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let seconds = String(format: "%.2f", event.positionTime)
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.seek && window.__vibeMedia.seek(\(seconds));")
            return .success
        }
    }

    /// Called from the page's nowPlaying(title, artist, artwork, playing, positionMs, durationMs).
    func update(title: String, artist: String, artwork: String, playing: Bool, positionMs: Double, durationMs: Double) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: positionMs / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        if durationMs > 0 { info[MPMediaItemPropertyPlaybackDuration] = durationMs / 1000 }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        guard !artwork.isEmpty, let url = URL(string: artwork) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let image = UIImage(data: data) else { return }
            let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                var current = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                current[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = current
            }
        }.resume()
    }
}
