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
    private var observers: [NSObjectProtocol] = []

    private init() {}

    func start() {
        guard !started else { return }
        started = true

        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)

        // Taking the AirPods out, or switching Bluetooth off, moves the sound to the phone's own
        // speaker. iOS does that for Safari but not for a WKWebView, so the shell stops the song
        // itself: the page pauses where it is, and the lock screen follows.
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
        ) { note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
            else { return }
            MediaBridge.shared.pauseForRouteLoss()
        })
        // A call, Siri or another app taking the session: pause instead of coming back playing.
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began
            else { return }
            MediaBridge.shared.pauseForRouteLoss()
        })

        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.play && window.__vibeMedia.play();")
            return .success
        }
        commands.pauseCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.pause && window.__vibeMedia.pause();")
            return .success
        }
        commands.togglePlayPauseCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.toggle && window.__vibeMedia.toggle();")
            return .success
        }
        commands.nextTrackCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.next && window.__vibeMedia.next();")
            return .success
        }
        commands.previousTrackCommand.addTarget { _ in
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.previous && window.__vibeMedia.previous();")
            return .success
        }
        commands.changePlaybackPositionCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let seconds = String(format: "%.2f", event.positionTime)
            MediaBridge.shared.evaluate?("window.__vibeMedia && window.__vibeMedia.seek && window.__vibeMedia.seek(\(seconds));")
            return .success
        }
    }

    /// The audio route disappeared while something was playing: pause, never rewind, never
    /// resume on its own, so putting the AirPods back in continues the same song.
    private func pauseForRouteLoss() {
        evaluate?("window.__vibeMedia && window.__vibeMedia.pause && window.__vibeMedia.pause();")
        // The page's next nowPlaying() would say the same a moment later; this keeps the lock
        // screen from showing a playing song in between.
        if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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
