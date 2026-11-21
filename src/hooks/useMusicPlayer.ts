import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { seedTracks } from '../data';
import { randomOrder, trackKey } from '../services/catalog';
import { ensureYouTubeIframeAPI, getLastResolveError, prefetchYouTubeTracks, resolveYouTubeTrack } from '../services/youtube';
import { hasNativeYouTube, nativeStreamUrl } from '../services/nativeBridge';
import { markOfflineBroken, offlineSrc } from '../services/offline';
import type { Track } from '../types';
import { useStoredState } from './useStoredState';

interface PlayerOptions {
  getCatalog: () => Track[];
  getMore: (sceneId: string) => Promise<Track[]>;
  notify: (message: string) => void;
  onPlayed: (track: Track) => void;
  /** Called when the listener moves on before 30 seconds: the taste engine learns from it. */
  onSkipped?: (track: Track, positionMs?: number) => void;
}

interface YTPlayer {
  loadVideoById(id: string | { videoId: string; startSeconds?: number }, startSeconds?: number): void;
  cueVideoById(id: string | { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (elementId: string | HTMLElement, options: unknown) => YTPlayer;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
    /** Bridge exposed by the Android shell (apk/) for the media notification. */
    VibeNative?: {
      nowPlaying?: (title: string, artist: string, artwork: string, playing: string, positionMs: string, durationMs: string) => void;
      /** Android shell: InnerTube search, on the phone's own connection. */
      searchYouTube?: (artist: string, title: string, callbackId: number) => void;
      /** Android shell: direct audio URL for a video id. */
      resolveStream?: (videoId: string, callbackId: number) => void;
    };
    __vibeMedia?: {
      play: () => void;
      pause: () => void;
      toggle: () => void;
      next: () => void;
      previous: () => void;
      /** Called by the lock screen / headphone seek bar. */
      seek: (seconds: number) => void;
    };
  }
}

const initialQueue = seedTracks.slice(0, 6);

export interface PlaybackAttempt {
  source: string;
  status: 'ok' | 'failed';
  detail: string;
}

/** One running blend: the outgoing element, the incoming one and the next queue slot. */
interface Blend {
  from: HTMLAudioElement;
  to: HTMLAudioElement;
  nextIndex: number;
  offline: boolean;
  raf: number;
}

export function useMusicPlayer(options: PlayerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /**
   * Two audio elements take turns being the audible one, which is what makes a blend
   * possible: the next track starts on the idle element while the current one fades out.
   */
  const audioRef = useRef<HTMLAudioElement>(null);
  const mixRef = useRef<HTMLAudioElement>(null);
  const primarySide = useRef<'main' | 'mix'>('main');
  const activeAudio = useCallback(() => (primarySide.current === 'main' ? audioRef.current : mixRef.current), []);
  const idleAudio = useCallback(() => (primarySide.current === 'main' ? mixRef.current : audioRef.current), []);

  const ytPlayerRef = useRef<YTPlayer | null>(null);
  const ytReadyRef = useRef(false);

  const [queue, setQueue] = useState<Track[]>(initialQueue);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(210);
  const [label, setLabel] = useState('Full Length');
  const [sceneId, setSceneId] = useState('fulllength');
  const [isRadio, setIsRadio] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [autoplay, storeAutoplay] = useStoredState('vibe.autoplay', true);
  const [volume, storeVolume] = useStoredState('vibe.volume', 70);
  /** Seconds of overlap between two songs. 0 turns blending off. */
  const [crossfade, storeCrossfade] = useStoredState('vibe.crossfade', 10);
  /** AutoMix: vibe picks the blend length per song, the way a DJ reads the track. */
  const [automix, storeAutomix] = useStoredState('vibe.automix', false);
  /** Karaoke/lrc timing nudge in seconds: positive delays the words, negative pulls them earlier. */
  const [lyricsOffset, storeLyricsOffset] = useStoredState('vibe.lyrics_offset', 0);
  /** Every song keeps its own nudge, so a badly timed LRC file is fixed once and stays fixed. */
  const [lyricsOffsets, storeLyricsOffsets] = useStoredState<Record<string, number>>('vibe.lyrics_offsets', {});

  const [activeSource, setActiveSource] = useState<'youtube' | 'audio'>('youtube');
  const activeSourceRef = useRef<'youtube' | 'audio'>('youtube');
  /** True when the direct stream is only a 30 second preview (Deezer), not the whole song. */
  const [isPreview, setIsPreview] = useState(false);
  /** True while the current track is playing from the phone's own storage. */
  const [isOffline, setIsOffline] = useState(false);

  const queueRef = useRef(queue);
  const indexRef = useRef(index);
  const sceneRef = useRef('fulllength');
  const autoplayRef = useRef(autoplay);
  const wantsPlay = useRef(false);
  const session = useRef(0);
  const playRequest = useRef(0);
  const advancing = useRef(false);
  const seen = useRef(new Set<string>());
  const originals = useRef(new Set(initialQueue.map(trackKey)));
  const unavailable = useRef(new Set<string>());
  const unshuffled = useRef(initialQueue);
  const failures = useRef(0);
  const pendingVideo = useRef<{ videoId: string; play: boolean } | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ytStarted = useRef(false);
  /** The track already reported as played, so a pause/resume is not a second play. */
  const reportedPlay = useRef('');
  /** Fresh stream URLs requested after YouTube cut the previous one mid-track. */
  const streamRecovery = useRef(0);
  /** Which source is being tried for the current track. */
  const attempt = useRef<'audius' | 'proxy' | 'youtube' | 'preview' | 'offline' | null>(null);
  const ytAttempt = useRef<((videoId: string) => void) | null>(null);
  const lastVolume = useRef(70);
  const advanceRef = useRef<() => Promise<void>>(async () => undefined);
  const selectRef = useRef<(nextIndex: number, play?: boolean) => void>(() => undefined);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const crossfadeRef = useRef(crossfade);
  crossfadeRef.current = crossfade;
  const automixRef = useRef(automix);
  automixRef.current = automix;
  /** Stream URLs already extracted on this phone, so the next song starts at once. */
  const streamCache = useRef(new Map<string, string>());
  const blendRef = useRef<Blend | null>(null);
  const incoming = useRef<{ key: string; url: string | null; promise: Promise<string | null> } | null>(null);

  const commitQueue = useCallback((tracks: Track[]) => {
    queueRef.current = tracks;
    setQueue(tracks);
  }, []);

  const playAudio = useCallback(() => {
    const audio = activeAudio();
    if (!audio) return;
    const request = ++playRequest.current;
    wantsPlay.current = true;
    setIsLoading(false);
    setIsPlaying(true);
    const p = audio.play();
    if (p !== undefined) {
      p.catch((error: DOMException) => {
        if (request !== playRequest.current || error.name === 'AbortError') return;
        setIsLoading(false);
        if (error.name === 'NotAllowedError') {
          // Keep the intent: the next tap on play retries instead of flipping to pause.
          setIsPlaying(false);
          optionsRef.current.notify('Press play to begin listening.');
        }
      });
    }
  }, [activeAudio]);

  /** Every source tried for the current track, with the reason it failed. */
  const [diagnostics, setDiagnostics] = useState<PlaybackAttempt[]>([]);
  const attemptLog = useRef<PlaybackAttempt[]>([]);
  const noteAttempt = useCallback((source: string, status: 'ok' | 'failed', detail: string) => {
    attemptLog.current = [...attemptLog.current, { source, status, detail }];
    setDiagnostics(attemptLog.current);
  }, []);

  /** Tells the app a track really started once, which is what the taste engine counts. */
  const reportPlay = useCallback((track: Track) => {
    const key = trackKey(track);
    if (reportedPlay.current === key) return;
    reportedPlay.current = key;
    seen.current.add(key);
    optionsRef.current.onPlayed(track);
  }, []);

    /**
   * Last real source: the track's own complete stream (Audius).
   * A 30 second catalog preview is never played — if there is no full track, the list moves on.
   */
  const playFallback = useCallback(() => {
    const track = queueRef.current[indexRef.current];
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    const fullStream = Boolean(track && track.id.startsWith('audius:') && track.audioUrl.startsWith('https://'));
    if (!track || !fullStream) {
      noteAttempt('Preview', 'failed', 'previews are off, so this track is skipped');
      if (track) unavailable.current.add(track.id);
      setIsPreview(false);
      if (!wantsPlay.current) return;
      if (++failures.current <= 3) {
        void advanceRef.current();
      } else {
        failures.current = 0;
        wantsPlay.current = false;
        setIsPlaying(false);
        setIsLoading(false);
        // Say why, so a stuck queue is diagnosable instead of just silent.
        const lastFailure = [...attemptLog.current].reverse().find((entry) => entry.status === 'failed');
        optionsRef.current.notify(lastFailure
          ? `No full track available right now — ${lastFailure.source}: ${lastFailure.detail}`
          : 'No full track available for the songs left in this list.');
      }
      return;
    }
    attempt.current = 'audius';
    noteAttempt('Audius', 'ok', 'full length stream');
    activeSourceRef.current = 'audio';
    setActiveSource('audio');
    setIsPreview(false);
    try { ytPlayerRef.current?.pauseVideo(); } catch {}
    const audio = activeAudio();
    if (!audio) return;
    audio.src = track.audioUrl;
    audio.load();
    if (wantsPlay.current) playAudio();
  }, [activeAudio, noteAttempt, playAudio]);

  /* ------------------------------------------------------------------ blending */

  /**
   * How long the next song rides under this one. AutoMix reads the track length, so a
   * three minute song and a six minute song do not get the same tail.
   */
  const blendLength = useCallback((trackSeconds: number) => {
    if (!Number.isFinite(trackSeconds) || trackSeconds <= 0) return 0;
    const ceiling = Math.min(20, trackSeconds * 0.4);
    if (automixRef.current) return Math.min(ceiling, Math.max(9, Math.min(18, trackSeconds * 0.07 + 6)));
    const configured = crossfadeRef.current;
    return configured > 0 ? Math.min(ceiling, configured) : 0;
  }, []);

  /** A playable URL for any track, resolved on the phone when it is not cached yet. */
  const sourceUrlFor = useCallback(async (track: Track): Promise<string | null> => {
    const saved = offlineSrc(track);
    if (saved) return saved;
    const cached = streamCache.current.get(trackKey(track));
    if (cached) return cached;
    if (track.id.startsWith('audius:') && track.audioUrl.startsWith('https://')) return track.audioUrl;

    let videoId = track.youtubeId;
    if (!videoId) {
      const yt = await resolveYouTubeTrack(track.artist, track.title, track.duration);
      if (!yt?.videoId) return null;
      videoId = yt.videoId;
      track.youtubeId = videoId;
      if (yt.duration && yt.duration > 0) track.duration = yt.duration;
    }

    const url = hasNativeYouTube()
      ? (await nativeStreamUrl(videoId)).value
      : `/api/stream?videoId=${encodeURIComponent(videoId)}&artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`;
    if (url) streamCache.current.set(trackKey(track), url);
    return url;
  }, []);

  /** Warms the next song's audio so a blend (or a tap on next) has nothing to wait for. */
  const prepareNext = useCallback((track: Track) => {
    const key = trackKey(track);
    if (incoming.current?.key === key) return incoming.current.promise;
    const entry: { key: string; url: string | null; promise: Promise<string | null> } = {
      key, url: null, promise: Promise.resolve(null),
    };
    entry.promise = sourceUrlFor(track)
      .then((url) => { entry.url = url; return url; })
      .catch(() => null);
    incoming.current = entry;
    return entry.promise;
  }, [sourceUrlFor]);

  const abortBlend = useCallback(() => {
    const blend = blendRef.current;
    if (!blend) return;
    blendRef.current = null;
    if (blend.raf) cancelAnimationFrame(blend.raf);
    try {
      blend.to.pause();
      blend.to.removeAttribute('src');
      blend.to.load();
    } catch { /* The element may already be gone. */ }
    blend.from.volume = volumeRef.current / 100;
    blend.to.volume = volumeRef.current / 100;
  }, []);

  /** The incoming element becomes the audible one, with no gap at all. */
  const commitBlend = useCallback(() => {
    const blend = blendRef.current;
    if (!blend) return;
    blendRef.current = null;
    if (blend.raf) cancelAnimationFrame(blend.raf);
    const { from, to, nextIndex, offline } = blend;
    primarySide.current = primarySide.current === 'main' ? 'mix' : 'main';
    try {
      from.pause();
      from.removeAttribute('src');
      from.load();
    } catch { /* Nothing to release. */ }
    const master = volumeRef.current / 100;
    from.volume = master;
    to.volume = master;

    indexRef.current = nextIndex;
    setIndex(nextIndex);
    setTime(to.currentTime || 0);
    if (Number.isFinite(to.duration) && to.duration > 0) setDuration(to.duration);
    activeSourceRef.current = 'audio';
    setActiveSource('audio');
    setIsPreview(false);
    setIsOffline(offline);
    wantsPlay.current = true;
    setIsPlaying(true);
    setIsLoading(false);
    attempt.current = offline ? 'offline' : 'proxy';
    attemptLog.current = [];
    setDiagnostics([]);
    ytStarted.current = false;
    streamRecovery.current = 0;
    reportedPlay.current = '';
    incoming.current = null;
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    const track = queueRef.current[nextIndex];
    if (track) {
      seen.current.add(trackKey(track));
      reportPlay(track);
      prefetchYouTubeTracks(queueRef.current.slice(nextIndex + 1, nextIndex + 4));
    }
  }, [reportPlay]);

  /** Starts the next song on the idle element and ramps both volumes into each other. */
  const startBlend = useCallback((url: string, nextIndex: number) => {
    if (blendRef.current) return;
    const from = activeAudio();
    const to = idleAudio();
    if (!from || !to || from === to) return;
    if (activeSourceRef.current !== 'audio' || !wantsPlay.current) return;
    const track = queueRef.current[nextIndex];
    if (!track) return;
    const trackSeconds = from.duration;
    if (!Number.isFinite(trackSeconds) || trackSeconds <= 0) return;
    const remaining = trackSeconds - (from.currentTime || 0);
    if (remaining <= 0.4) return;

    const span = Math.max(1.2, Math.min(blendLength(trackSeconds) || 10, remaining));
    const blend: Blend = { from, to, nextIndex, offline: Boolean(offlineSrc(track)), raf: 0 };
    blendRef.current = blend;

    try {
      to.pause();
      to.src = url;
      to.volume = 0;
      const started = to.play();
      if (started) started.catch(() => abortBlend());
    } catch {
      abortBlend();
      return;
    }

    const began = performance.now();
    const step = () => {
      if (blendRef.current !== blend) return;
      const progress = Math.min(1, (performance.now() - began) / (span * 1000));
      const level = volumeRef.current / 100;
      // Equal-power curves: the sum stays even, so the blend never dips in volume.
      from.volume = Math.max(0, Math.min(1, level * Math.cos(progress * Math.PI / 2)));
      to.volume = Math.max(0, Math.min(1, level * Math.sin(progress * Math.PI / 2)));
      if (progress >= 1) {
        commitBlend();
        return;
      }
      blend.raf = requestAnimationFrame(step);
    };
    blend.raf = requestAnimationFrame(step);
  }, [abortBlend, activeAudio, blendLength, commitBlend, idleAudio]);

  /** Called a few times a second while audio plays: warms, then starts, the next blend. */
  const maybeBlend = useCallback(() => {
    if (blendRef.current) return;
    const audio = activeAudio();
    if (!audio || activeSourceRef.current !== 'audio' || audio.paused || audio.ended || !wantsPlay.current) return;
    const trackSeconds = audio.duration;
    if (!Number.isFinite(trackSeconds) || trackSeconds <= 0) return;
    const length = blendLength(trackSeconds);
    if (!length) return;
    const remaining = trackSeconds - (audio.currentTime || 0);
    const nextIndex = indexRef.current + 1;
    const nextTrack = queueRef.current[nextIndex];
    if (!nextTrack || remaining <= 0) return;

    const entry = prepareNext(nextTrack);
    if (remaining > length) return;

    const ready = incoming.current?.key === trackKey(nextTrack) ? incoming.current.url : null;
    if (ready) {
      startBlend(ready, nextIndex);
      return;
    }
    const at = indexRef.current;
    void entry.then((url) => {
      if (!url || indexRef.current !== at || blendRef.current) return;
      startBlend(url, nextIndex);
    });
  }, [activeAudio, blendLength, prepareNext, startBlend]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(maybeBlend, 700);
    return () => clearInterval(timer);
  }, [isPlaying, maybeBlend]);

  // Initialize background YouTube audio player
  useEffect(() => {
    let unmounted = false;

    ensureYouTubeIframeAPI().then(() => {
      if (unmounted) return;
      if (!window.YT?.Player) return;

      const host = document.getElementById('vibe-yt-player-host');
      if (!host) return;

      try {
        ytPlayerRef.current = new window.YT.Player('vibe-yt-player-host', {
          height: '100%',
          width: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event: { target: YTPlayer }) => {
              ytReadyRef.current = true;
              try {
                event.target.unMute();
                event.target.setVolume(volume);
              } catch {}
              // A track pressed before the player was ready waits here, then plays.
              const pending = pendingVideo.current;
              if (pending) {
                pendingVideo.current = null;
                try {
                  event.target.loadVideoById(pending.videoId, 0);
                  if (pending.play) event.target.playVideo();
                  else event.target.pauseVideo();
                } catch {
                  playFallback();
                }
              }
            },
            onStateChange: (event: { data: number; target: YTPlayer }) => {
              if (event.data === 1) { // PLAYING
                // We already fell back to the direct stream: never play both at once.
                if (activeSourceRef.current !== 'youtube') {
                  try { event.target.pauseVideo(); } catch {}
                  return;
                }
                setIsPlaying(true);
                setIsLoading(false);
                failures.current = 0;
                ytStarted.current = true;
                noteAttempt('YouTube player', 'ok', 'iframe playback started');
                setIsPreview(false);
                if (fallbackTimer.current) {
                  clearTimeout(fallbackTimer.current);
                  fallbackTimer.current = null;
                }
                activeSourceRef.current = 'youtube';
                setActiveSource('youtube');

                const dur = event.target.getDuration();
                if (dur && Number.isFinite(dur) && dur > 0) {
                  setDuration(dur);
                }
                const track = queueRef.current[indexRef.current];
                if (track) reportPlay(track);
              } else if (event.data === 2) { // PAUSED
                if (activeSourceRef.current === 'youtube') {
                  setIsPlaying(false);
                  setIsLoading(false);
                  wantsPlay.current = false;
                }
              } else if (event.data === 0) { // ENDED
                if (activeSourceRef.current === 'youtube') {
                  void advanceRef.current();
                }
              }
            },
            onError: (event: { data: number }) => {
              console.warn('[YouTube Audio] Playback error code:', event.data);
              noteAttempt('YouTube player', 'failed', `player error ${event.data}`);
              setIsLoading(false);
              // Restricted or unplayable video: keep the music going from the direct stream.
              playFallback();
            },
          },
        });
      } catch (err) {
        console.warn('[YouTube Audio] Init error:', err);
      }
    });

    return () => {
      unmounted = true;
      try {
        ytPlayerRef.current?.destroy();
      } catch {}
    };
  }, [noteAttempt, playFallback, reportPlay, volume]);

  // Sync YouTube playback progress
  useEffect(() => {
    if (!isPlaying || activeSource !== 'youtube') return;

    const interval = setInterval(() => {
      if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === 'function') {
        const currentTime = ytPlayerRef.current.getCurrentTime();
        if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
          setTime(currentTime);
        }
        const currentDur = ytPlayerRef.current.getDuration();
        if (typeof currentDur === 'number' && Number.isFinite(currentDur) && currentDur > 0) {
          setDuration(currentDur);
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isPlaying, activeSource]);

  const select = useCallback((nextIndex: number, play = true) => {
    const track = queueRef.current[nextIndex];
    if (!track) return;

    abortBlend();
    incoming.current = null;
    const currentRequest = ++playRequest.current;
    indexRef.current = nextIndex;
    setIndex(nextIndex);
    setTime(0);
    setDuration(track.duration || 210);
    wantsPlay.current = play;
    setIsPlaying(play);
    setIsLoading(false); // Never leave spinning
    setIsPreview(false);
    setIsOffline(false);
    ytStarted.current = false;
    reportedPlay.current = '';
    streamRecovery.current = 0;
    pendingVideo.current = null;
    attempt.current = null;
    attemptLog.current = [];
    setDiagnostics([]);
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }

    // Whatever the other element was doing is over; one sound at a time.
    const spare = idleAudio();
    if (spare) {
      try {
        spare.pause();
        spare.removeAttribute('src');
        spare.load();
      } catch { /* Nothing loaded. */ }
      spare.volume = volumeRef.current / 100;
    }
    const audio = activeAudio();
    if (audio) audio.volume = volumeRef.current / 100;

    // A song saved on the phone plays straight from storage: no network, no waiting.
    const saved = offlineSrc(track);
    if (saved) {
      attempt.current = 'offline';
      activeSourceRef.current = 'audio';
      setActiveSource('audio');
      setIsOffline(true);
      setIsPreview(false);
      noteAttempt('Offline', 'ok', 'saved on this phone, needs no connection');
      if (audio) {
        audio.pause();
        audio.src = saved;
        audio.load();
        if (play) playAudio();
      }
      return;
    }

    // Check if Audius full track
    const isAudiusFull = track.id.startsWith('audius:') && track.audioUrl.startsWith('https://');

    if (isAudiusFull) {
      playFallback();
    } else {
      // Standard track: stream the full song through the YouTube audio engine
      activeSourceRef.current = 'youtube';
      setActiveSource('youtube');
      if (audio) {
        audio.pause();
      }

      const playYT = (videoId: string) => {
        // Remembered until the player is ready, so an early tap still plays.
        if (!ytPlayerRef.current || !ytReadyRef.current) {
          pendingVideo.current = { videoId, play };
          return;
        }
        try {
          ytPlayerRef.current.unMute();
          ytPlayerRef.current.setVolume(volumeRef.current);
          ytPlayerRef.current.loadVideoById(videoId, 0);
          if (play) ytPlayerRef.current.playVideo();
          else ytPlayerRef.current.pauseVideo();
        } catch {
          playFallback();
        }
      };
      ytAttempt.current = playYT;

      const startAudio = (url: string) => {
        const element = activeAudio();
        if (!element) return false;
        attempt.current = 'proxy';
        activeSourceRef.current = 'audio';
        setActiveSource('audio');
        setIsPreview(false);
        element.src = url;
        element.volume = volumeRef.current / 100;
        element.load();
        if (wantsPlay.current) playAudio();
        return true;
      };

      // The server can hand us the whole song as plain audio: try it before the embed.
      const tryStream = (videoId: string) => {
        const element = activeAudio();
        if (!element) {
          playYT(videoId);
          return;
        }

        // In the Android shell the phone extracts the audio itself, exactly like InnerTune.
        if (hasNativeYouTube()) {
          // Already extracted a moment ago: a tap on next starts without any wait.
          const warmed = streamCache.current.get(trackKey(track));
          if (warmed) {
            noteAttempt('Device (InnerTube)', 'ok', 'stream url already extracted');
            startAudio(warmed);
            return;
          }
          attempt.current = 'proxy';
          activeSourceRef.current = 'audio';
          setActiveSource('audio');
          setIsPreview(false);
          void nativeStreamUrl(videoId).then((result) => {
            if (currentRequest !== playRequest.current) return;
            if (!result.value) {
              noteAttempt('Device (InnerTube)', 'failed', result.error ?? 'the phone returned no audio url');
              attempt.current = 'youtube';
              if (wantsPlay.current) playYT(videoId);
              return;
            }
            noteAttempt('Device (InnerTube)', 'ok', `full audio extracted on the phone${result.client ? ` (${result.client})` : ''}`);
            streamCache.current.set(trackKey(track), result.value);
            startAudio(result.value);
          });
          return;
        }

        attempt.current = 'proxy';
        activeSourceRef.current = 'audio';
        setActiveSource('audio');
        setIsPreview(false);
        const streamUrl = `/api/stream?videoId=${encodeURIComponent(videoId)}&artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`;
        // Probe first so the diagnostics can show the server's real reason when it refuses.
        void fetch(streamUrl, { headers: { Range: 'bytes=0-1' } })
          .then(async (response) => {
            if (currentRequest !== playRequest.current) return;
            if (!response.ok) {
              let detail = `HTTP ${response.status}`;
              try {
                const body = await response.json() as { error?: string; detail?: string };
                detail = [body.error, body.detail].filter(Boolean).join(': ') || detail;
              } catch {
                // Not a JSON error body.
              }
              noteAttempt('Server stream', 'failed', detail);
              attempt.current = 'youtube';
              if (wantsPlay.current) playYT(videoId);
              return;
            }
            noteAttempt('Server stream', 'ok', `${response.status} ${response.headers.get('content-type') ?? 'audio'}`);
            startAudio(streamUrl);
          })
          .catch((error: unknown) => {
            if (currentRequest !== playRequest.current) return;
            noteAttempt('Server stream', 'failed', error instanceof Error ? error.message : 'request failed');
            attempt.current = 'youtube';
            if (wantsPlay.current) playYT(videoId);
          });
      };

      // If nothing has actually started in a few seconds, use the direct preview stream.
      fallbackTimer.current = setTimeout(() => {
        if (currentRequest !== playRequest.current) return;
        const element = activeAudio();
        const audioLive = Boolean(element && !element.paused && element.readyState >= 2 && !element.error);
        if (!audioLive && !ytStarted.current) {
          noteAttempt('YouTube player', 'failed', 'nothing played within 9 seconds');
          playFallback();
        }
      }, 9000);

      if (track.youtubeId) {
        tryStream(track.youtubeId);
      } else {
        resolveYouTubeTrack(track.artist, track.title, track.duration).then((yt) => {
          if (currentRequest !== playRequest.current) return;
          if (yt?.videoId) {
            track.youtubeId = yt.videoId;
            track.fullLength = true;
            if (yt.duration && yt.duration > 0) {
              track.duration = yt.duration;
              setDuration(yt.duration);
            }
            if (wantsPlay.current) {
              tryStream(yt.videoId);
            }
          } else {
            // No resolver available (bundled app): play the track's own stream.
            noteAttempt('Search', 'failed', getLastResolveError() ?? 'no YouTube video found');
            playFallback();
          }
        }).catch(() => {
          if (currentRequest === playRequest.current) playFallback();
        });
      }
    }

    // Prefetch upcoming tracks
    prefetchYouTubeTracks(queueRef.current.slice(nextIndex + 1, nextIndex + 5));

    if (play) {
      seen.current.add(trackKey(track));
    }
  }, [abortBlend, activeAudio, idleAudio, noteAttempt, playAudio, playFallback]);
  selectRef.current = select;

  const pause = useCallback(() => {
    ++playRequest.current;
    wantsPlay.current = false;
    abortBlend();
    setIsPlaying(false);
    setIsLoading(false);

    const audio = activeAudio();
    if (audio) {
      audio.pause();
    }
    if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.pauseVideo();
      } catch {}
    }
  }, [abortBlend, activeAudio]);

  /** True only when sound is really coming out, whichever engine owns it. */
  const isAudible = useCallback(() => {
    if (activeSourceRef.current === 'audio') {
      const audio = activeAudio();
      return Boolean(audio && !audio.paused && !audio.ended);
    }
    const yt = ytPlayerRef.current;
    if (yt && typeof yt.getPlayerState === 'function') {
      try { return yt.getPlayerState() === 1; } catch { /* Player not ready yet. */ }
    }
    return false;
  }, [activeAudio]);

  const play = useCallback(() => {
    wantsPlay.current = true;
    setIsPlaying(true);
    setIsLoading(false);

    if (activeSourceRef.current === 'youtube' && ytPlayerRef.current && ytReadyRef.current) {
      try {
        const state = typeof ytPlayerRef.current.getPlayerState === 'function' ? ytPlayerRef.current.getPlayerState() : -1;
        ytPlayerRef.current.playVideo();
        // Finished songs sit at the end: restart them instead of staying silent.
        if (state === 0) ytPlayerRef.current.seekTo(0, true);
        return;
      } catch {}
    }

    const audio = activeAudio();
    if (audio && audio.currentSrc && !audio.error) {
      audio.volume = volumeRef.current / 100;
      playAudio();
      // A stream URL that quietly expired is reloaded instead of leaving a dead play button.
      const request = playRequest.current;
      window.setTimeout(() => {
        if (request !== playRequest.current || !wantsPlay.current) return;
        const element = activeAudio();
        if (!element || element.ended) return;
        if (element.paused || element.error) {
          streamCache.current.delete(trackKey(queueRef.current[indexRef.current]));
          selectRef.current(indexRef.current, true);
        }
      }, 1200);
      return;
    }

    // Nothing loaded yet (or the stream failed): resolve the current track again.
    streamCache.current.delete(trackKey(queueRef.current[indexRef.current]));
    selectRef.current(indexRef.current, true);
  }, [activeAudio, playAudio]);

  const toggle = useCallback(() => {
    // Read the real state, not the intent: after a blend or a stalled stream the two differ.
    if (isAudible()) pause();
    else play();
  }, [isAudible, pause, play]);

  const playTracks = useCallback((tracks: Track[], startIndex = 0, nextLabel = 'Your mix', nextScene = 'fulllength') => {
    // A song saved on the phone carries no stream URL — its audio is a file in the app's own
    // storage — so mergeTracks (which keeps only streamable tracks) would empty the Offline
    // music page. Playable here means: a stream URL, or a file this phone already holds.
    const seen = new Set<string>();
    const nextQueue = tracks.filter((track) => {
      const key = trackKey(track);
      if (seen.has(key)) return false;
      if (!track.audioUrl && !offlineSrc(track)) return false;
      seen.add(key);
      return true;
    });
    if (!nextQueue.length) {
      optionsRef.current.notify('Nothing to play yet.');
      return;
    }
    ++session.current;
    advancing.current = false;
    failures.current = 0;
    const start = Math.max(0, Math.min(startIndex, nextQueue.length - 1));
    sceneRef.current = nextScene;
    setSceneId(nextScene);
    originals.current = new Set(nextQueue.map(trackKey));
    unshuffled.current = nextQueue;
    setShuffle(false);
    setIsRadio(false);
    setLabel(nextLabel);
    commitQueue(nextQueue);
    select(start);
  }, [commitQueue, select]);

  const next = useCallback(async () => {
    if (advancing.current) return;
    // Leaving a song before half a minute is a skip, and says as much as a finished play.
    const playing = queueRef.current[indexRef.current];
    const elapsed = activeSourceRef.current === 'youtube'
      ? ytPlayerRef.current?.getCurrentTime()
      : activeAudio()?.currentTime;
    if (playing && wantsPlay.current && typeof elapsed === 'number' && elapsed > 0 && elapsed < 30) {
      optionsRef.current.onSkipped?.(playing, Math.round(elapsed));
    }
    const nextIndex = indexRef.current + 1;
    if (nextIndex < queueRef.current.length) {
      select(nextIndex);
      return;
    }
    if (!autoplayRef.current) {
      pause();
      return;
    }
    advancing.current = true;
    wantsPlay.current = true;
    const currentSession = session.current;
    const currentRequest = playRequest.current;
    const scene = sceneRef.current;
    const excluded = new Set([...originals.current, ...seen.current, ...queueRef.current.map(trackKey)]);
    const candidates = () => optionsRef.current.getCatalog().filter((track) => track.sceneId === scene && !excluded.has(trackKey(track)) && !unavailable.current.has(track.id));
    try {
      let found = candidates();
      for (let attempt = 0; found.length < 5 && attempt < 4; attempt++) {
        try { await optionsRef.current.getMore(scene); } catch { break; }
        if (currentSession !== session.current || currentRequest !== playRequest.current || !wantsPlay.current) return;
        found = candidates();
      }
      if (currentSession !== session.current || currentRequest !== playRequest.current || !wantsPlay.current) return;
      if (!found.length) {
        pause();
        return;
      }
      const fresh = randomOrder(found.slice(0, 40)).slice(0, 12);
      const start = queueRef.current.length;
      commitQueue([...queueRef.current, ...fresh]);
      setIsRadio(true);
      select(start);
    } finally {
      if (currentSession === session.current) {
        advancing.current = false;
      }
    }
  }, [commitQueue, pause, select]);
  advanceRef.current = next;

  const previous = useCallback(() => {
    if (time > 3 || indexRef.current === 0) {
      if (activeSourceRef.current === 'youtube' && ytPlayerRef.current) {
        try { ytPlayerRef.current.seekTo(0, true); } catch {}
      }
      const audio = activeAudio();
      if (audio) {
        audio.currentTime = 0;
      }
      setTime(0);
    } else {
      select(indexRef.current - 1, wantsPlay.current);
    }
  }, [activeAudio, select, time]);

  const seek = useCallback((seconds: number) => {
    setTime(seconds);
    if (activeSourceRef.current === 'youtube' && ytPlayerRef.current) {
      try {
        ytPlayerRef.current.seekTo(seconds, true);
        return;
      } catch {}
    }
    const audio = activeAudio();
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
  }, [activeAudio]);

  const setVolume = useCallback((value: number) => {
    const nextVolume = Math.max(0, Math.min(100, value));
    if (nextVolume > 0) lastVolume.current = nextVolume;
    storeVolume(nextVolume);
    // While a blend runs the ramp owns the levels; the new master is read on the next frame.
    if (!blendRef.current) {
      const audio = activeAudio();
      if (audio) audio.volume = nextVolume / 100;
      const spare = idleAudio();
      if (spare) spare.volume = nextVolume / 100;
    }
    if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.setVolume(nextVolume);
      } catch {}
    }
  }, [activeAudio, idleAudio, storeVolume]);

  const setAutoplay = useCallback((value: boolean) => {
    autoplayRef.current = value;
    storeAutoplay(value);
  }, [storeAutoplay]);

  const setCrossfade = useCallback((value: number) => {
    storeCrossfade(Math.max(0, Math.min(20, Math.round(value))));
  }, [storeCrossfade]);

  const setAutomix = useCallback((value: boolean) => {
    automixRef.current = value;
    storeAutomix(value);
  }, [storeAutomix]);

  const cleanOffset = (value: number) => Math.round(Math.max(-10, Math.min(10, value)) * 10) / 10;

  const setLyricsOffset = useCallback((value: number) => {
    storeLyricsOffset(cleanOffset(value));
  }, [storeLyricsOffset]);

  /** The timing for this track: its own saved nudge, or the default from settings. */
  const lyricsOffsetFor = useCallback((track: Track) => {
    const own = lyricsOffsets[trackKey(track)];
    return typeof own === 'number' ? own : lyricsOffset;
  }, [lyricsOffset, lyricsOffsets]);

  /** Saves a nudge for one song only. Back to zero removes the entry. */
  const setLyricsFor = useCallback((track: Track, value: number) => {
    const key = trackKey(track);
    const timing = cleanOffset(value);
    storeLyricsOffsets((previous) => {
      const next = { ...previous };
      if (timing === 0) delete next[key];
      else next[key] = timing;
      return next;
    });
  }, [storeLyricsOffsets]);

  const nudgeLyrics = useCallback((track: Track, delta: number) => {
    setLyricsFor(track, (lyricsOffsets[trackKey(track)] ?? lyricsOffset) + delta);
  }, [lyricsOffset, lyricsOffsets, setLyricsFor]);

  const toggleShuffle = useCallback(() => {
    const played = queueRef.current.slice(0, indexRef.current + 1);
    const upcoming = queueRef.current.slice(indexRef.current + 1);
    if (!shuffle) {
      unshuffled.current = [...queueRef.current];
      commitQueue([...played, ...randomOrder(upcoming)]);
    } else {
      const order = new Map(unshuffled.current.map((track, position) => [track.id, position]));
      commitQueue([...played, ...upcoming.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999))]);
    }
    setShuffle(!shuffle);
  }, [commitQueue, shuffle]);

  const addNext = useCallback((track: Track) => {
    const upcoming = queueRef.current.slice(indexRef.current + 1).filter((item) => trackKey(item) !== trackKey(track));
    commitQueue([...queueRef.current.slice(0, indexRef.current + 1), track, ...upcoming]);
    originals.current.add(trackKey(track));
    optionsRef.current.notify(`${track.title} plays next.`);
  }, [commitQueue]);

  const removeQueued = useCallback((position: number) => {
    if (position <= indexRef.current) return;
    commitQueue(queueRef.current.filter((_, itemIndex) => itemIndex !== position));
  }, [commitQueue]);

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      select(0, false);
    }
  }, [select]);

  useEffect(() => {
    const audio = activeAudio();
    if (audio) audio.volume = Math.max(0, Math.min(100, volume)) / 100;
  }, [activeAudio, volume]);

  const current = queue[index] ?? seedTracks[0];
  /** Latest progress, readable from the notification timer without re-running the effect. */
  const progressRef = useRef({ time, duration });
  progressRef.current = { time, duration };

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork: current.artwork ? [{ src: current.artwork, sizes: '500x500', type: 'image/jpeg' }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', play],
      ['pause', pause],
      ['previoustrack', previous],
      ['nexttrack', () => { void next(); }],
      ['seekto', (event) => { if (event.seekTime !== undefined) seek(event.seekTime); }],
    ];
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} });
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null); } catch {} });
  }, [current, next, pause, play, previous, seek]);

  // The Android shell draws the media notification from this; the browser ignores it.
  // While playing, the position is pushed along with it so the notification's bar moves.
  useEffect(() => {
    const bridge = window.VibeNative;
    if (typeof bridge?.nowPlaying !== 'function') return;
    const push = () => {
      const { time: at, duration: total } = progressRef.current;
      try {
        bridge.nowPlaying!(
          current.title,
          current.artist,
          current.artwork || '',
          isPlaying ? 'true' : 'false',
          String(Math.max(0, Math.round(at * 1000))),
          String(Math.max(0, Math.round(total * 1000))),
        );
      } catch { /* No native shell attached. */ }
    };
    push();
    if (!isPlaying) return;
    const timer = setInterval(push, 4000);
    return () => clearInterval(timer);
  }, [current, isPlaying]);

  // Notification and lock-screen buttons call straight back into the player.
  useEffect(() => {
    window.__vibeMedia = {
      play,
      pause,
      toggle,
      next: () => { void next(); },
      previous,
      seek: (seconds: number) => seek(seconds),
    };
    return () => { delete window.__vibeMedia; };
  }, [next, pause, play, previous, toggle]);

  /** Events from the idle element belong to a running blend, never to the UI. */
  const isMine = (event: SyntheticEvent<HTMLAudioElement>) => event.target === activeAudio();

  return {
    audioRef,
    mixRef,
    ytPlayerRef,
    queue,
    index,
    current,
    isPlaying,
    isLoading,
    time,
    duration,
    label,
    sceneId,
    isRadio,
    shuffle,
    autoplay,
    volume,
    crossfade,
    automix,
    lyricsOffset,
    activeSource,
    isPreview,
    offline: isOffline,
    diagnostics,
    playTracks,
    toggle,
    pause,
    play,
    next,
    previous,
    seek,
    setVolume,
    setAutoplay,
    setCrossfade,
    setAutomix,
    setLyricsOffset,
    lyricsOffsetFor,
    setLyricsFor,
    nudgeLyrics,
    toggleShuffle,
    addNext,
    removeQueued,
    getPlaybackRequest: () => playRequest.current,
    playQueued: (position: number) => select(position),
    toggleMute: () => setVolume(volume === 0 ? lastVolume.current : 0),
    audioEvents: {
      onPlay: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event) || activeSourceRef.current !== 'audio') return;
        setIsPlaying(true);
        setIsLoading(false);
        wantsPlay.current = true;
      },
      onPlaying: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        setIsLoading(false);
        failures.current = 0;
        streamRecovery.current = 0;
        if (attempt.current === 'proxy') {
          activeSourceRef.current = 'audio';
          setActiveSource('audio');
          setIsPreview(false);
          if (fallbackTimer.current) {
            clearTimeout(fallbackTimer.current);
            fallbackTimer.current = null;
          }
        }
        const track = queueRef.current[indexRef.current];
        if (!track) return;
        reportPlay(track);
      },
      onPause: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        // A source swap pauses the element for a moment: that is not the listener pausing.
        if (!wantsPlay.current || blendRef.current) return;
        const audio = activeAudio();
        if (activeSourceRef.current === 'audio' && audio?.paused) {
          setIsPlaying(false);
          setIsLoading(false);
          if (!audio.ended && !audio.error && audio.readyState >= 3) {
            wantsPlay.current = false;
          }
        }
      },
      onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        if (activeSourceRef.current === 'audio') {
          setTime(activeAudio()?.currentTime || 0);
          maybeBlend();
        }
      },
      onDurationChange: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        if (activeSourceRef.current === 'audio') {
          const actual = activeAudio()?.duration;
          if (actual && Number.isFinite(actual) && actual > 0) {
            setDuration(actual);
          }
        }
      },
      onWaiting: (event: SyntheticEvent<HTMLAudioElement>) => { if (!isMine(event)) return; },
      onCanPlay: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        setIsLoading(false);
      },
      onEnded: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event) || activeSourceRef.current !== 'audio') return;
        // Already blending: hand over to the song that is playing under this one.
        if (blendRef.current) {
          commitBlend();
          return;
        }
        void advanceRef.current();
      },
      onError: (event: SyntheticEvent<HTMLAudioElement>) => {
        if (!isMine(event)) return;
        setIsLoading(false);
        const track = queueRef.current[indexRef.current];
        // A saved file that will not read is dropped, and the song streams instead.
        if (attempt.current === 'offline') {
          noteAttempt('Offline', 'failed', 'the saved file would not play, streaming instead');
          attempt.current = null;
          setIsOffline(false);
          if (track) markOfflineBroken(track);
          select(indexRef.current, wantsPlay.current);
          return;
        }
        // The server could not extract this song: fall back to the embed, then the preview.
        if (attempt.current === 'proxy') {
          const audio = activeAudio();
          const mediaError = audio?.error;
          const position = audio?.currentTime || 0;
          noteAttempt('Audio stream', 'failed', mediaError ? `media error ${mediaError.code}` : 'playback failed');
          if (track) streamCache.current.delete(trackKey(track));

          // YouTube hands out stream URLs that stop working partway through (403, ~1 MB on
          // token-free clients). Ask for a fresh one and keep playing from where it stopped.
          const videoId = track?.youtubeId;
          if (videoId && hasNativeYouTube() && streamRecovery.current < 2 && audio && !audio.ended) {
            streamRecovery.current += 1;
            const request = playRequest.current;
            const resume = (value: string) => {
              if (request !== playRequest.current) return;
              if (track) streamCache.current.set(trackKey(track), value);
              noteAttempt('Device (InnerTube)', 'ok', `fresh stream url, resumed at ${Math.round(position)}s`);
              const element = activeAudio();
              if (!element) return;
              element.src = value;
              element.load();
              const jump = () => {
                try { element.currentTime = position; } catch {}
                if (wantsPlay.current) playAudio();
              };
              if (element.readyState >= 1) jump();
              else element.addEventListener('loadedmetadata', jump, { once: true });
            };
            void nativeStreamUrl(videoId).then((result) => {
              if (result.value) {
                resume(result.value);
                return;
              }
              if (request !== playRequest.current) return;
              noteAttempt('Device (InnerTube)', 'failed', result.error ?? 'no fresh audio url');
              attempt.current = 'youtube';
              if (!wantsPlay.current) return;
              ytAttempt.current?.(videoId);
            });
            return;
          }

          attempt.current = 'youtube';
          if (!wantsPlay.current) return;
          if (track?.youtubeId) ytAttempt.current?.(track.youtubeId);
          else playFallback();
          return;
        }
        if (!wantsPlay.current) return;
        if (track) unavailable.current.add(track.id);
        if (++failures.current <= 2) {
          void advanceRef.current();
        } else {
          pause();
        }
      },
    },
  };
}

export type MusicPlayer = ReturnType<typeof useMusicPlayer>;
