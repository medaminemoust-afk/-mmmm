import { useCallback, useEffect, useRef, useState } from 'react';
import { seedTracks } from '../data';
import { mergeTracks, randomOrder, trackKey } from '../services/catalog';
import { ensureYouTubeIframeAPI, prefetchYouTubeTracks, resolveYouTubeTrack } from '../services/youtube';
import type { Track } from '../types';
import { useStoredState } from './useStoredState';

interface PlayerOptions {
  getCatalog: () => Track[];
  getMore: (sceneId: string) => Promise<Track[]>;
  notify: (message: string) => void;
  onPlayed: (track: Track) => void;
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
  }
}

const initialQueue = seedTracks.slice(0, 6);

export function useMusicPlayer(options: PlayerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const audioRef = useRef<HTMLAudioElement>(null);
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

  const [activeSource, setActiveSource] = useState<'youtube' | 'audio'>('youtube');
  const activeSourceRef = useRef<'youtube' | 'audio'>('youtube');

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
  const lastVolume = useRef(70);
  const advanceRef = useRef<() => Promise<void>>(async () => undefined);

  const commitQueue = useCallback((tracks: Track[]) => {
    queueRef.current = tracks;
    setQueue(tracks);
  }, []);

  const playAudio = useCallback(() => {
    const audio = audioRef.current;
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
          setIsPlaying(false);
          wantsPlay.current = false;
          optionsRef.current.notify('Press play to begin listening.');
        }
      });
    }
  }, []);

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
              const currentTrack = queueRef.current[indexRef.current];
              if (currentTrack?.youtubeId) {
                event.target.cueVideoById(currentTrack.youtubeId);
              }
            },
            onStateChange: (event: { data: number; target: YTPlayer }) => {
              if (event.data === 1) { // PLAYING
                setIsPlaying(true);
                setIsLoading(false);
                failures.current = 0;
                activeSourceRef.current = 'youtube';
                setActiveSource('youtube');

                const dur = event.target.getDuration();
                if (dur && Number.isFinite(dur) && dur > 0) {
                  setDuration(dur);
                }
                const track = queueRef.current[indexRef.current];
                if (track) {
                  seen.current.add(trackKey(track));
                  optionsRef.current.onPlayed(track);
                }
              } else if (event.data === 2) { // PAUSED
                if (activeSourceRef.current === 'youtube') {
                  setIsPlaying(false);
                  setIsLoading(false);
                }
              } else if (event.data === 0) { // ENDED
                if (activeSourceRef.current === 'youtube') {
                  void advanceRef.current();
                }
              }
            },
            onError: (event: { data: number }) => {
              console.warn('[YouTube Audio] Playback error code:', event.data);
              setIsLoading(false);
              // Move to next track if this video is restricted
              void advanceRef.current();
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
  }, [volume]);

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

    const currentRequest = ++playRequest.current;
    indexRef.current = nextIndex;
    setIndex(nextIndex);
    setTime(0);
    setDuration(track.duration || 210);
    wantsPlay.current = play;
    setIsPlaying(play);
    setIsLoading(false); // Never leave spinning

    // Check if Audius full track
    const isAudiusFull = track.id.startsWith('audius:') && track.audioUrl.startsWith('https://');

    if (isAudiusFull) {
      activeSourceRef.current = 'audio';
      setActiveSource('audio');
      if (ytPlayerRef.current) {
        try { ytPlayerRef.current.pauseVideo(); } catch {}
      }
      if (audioRef.current) {
        audioRef.current.src = track.audioUrl;
        audioRef.current.load();
        if (play) playAudio();
      }
    } else {
      // Standard track: stream 100% full song via YouTube audio engine
      activeSourceRef.current = 'youtube';
      setActiveSource('youtube');
      if (audioRef.current) {
        audioRef.current.pause();
      }

      const playYT = (videoId: string) => {
        if (ytPlayerRef.current && ytReadyRef.current) {
          try {
            ytPlayerRef.current.unMute();
            ytPlayerRef.current.setVolume(volume);
            ytPlayerRef.current.loadVideoById(videoId, 0);
            if (play) ytPlayerRef.current.playVideo();
          } catch {}
        }
      };

      if (track.youtubeId) {
        playYT(track.youtubeId);
      } else {
        resolveYouTubeTrack(track.artist, track.title).then((yt) => {
          if (currentRequest !== playRequest.current) return;
          if (yt?.videoId) {
            track.youtubeId = yt.videoId;
            track.fullLength = true;
            if (yt.duration && yt.duration > 0) {
              track.duration = yt.duration;
              setDuration(yt.duration);
            }
            if (wantsPlay.current) {
              playYT(yt.videoId);
            }
          }
        });
      }
    }

    // Prefetch upcoming tracks
    prefetchYouTubeTracks(queueRef.current.slice(nextIndex + 1, nextIndex + 5));

    if (play) {
      seen.current.add(trackKey(track));
    }
  }, [playAudio, volume]);

  const pause = useCallback(() => {
    ++playRequest.current;
    wantsPlay.current = false;
    setIsPlaying(false);
    setIsLoading(false);

    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.pauseVideo();
      } catch {}
    }
  }, []);

  const play = useCallback(() => {
    wantsPlay.current = true;
    setIsPlaying(true);
    setIsLoading(false);

    if (activeSourceRef.current === 'youtube' && ytPlayerRef.current && ytReadyRef.current) {
      try {
        ytPlayerRef.current.playVideo();
        return;
      } catch {}
    }

    if (activeSourceRef.current === 'audio' && audioRef.current) {
      playAudio();
    }
  }, [playAudio]);

  const toggle = useCallback(() => {
    if (wantsPlay.current) pause();
    else play();
  }, [pause, play]);

  const playTracks = useCallback((tracks: Track[], startIndex = 0, nextLabel = 'Your mix', nextScene = 'fulllength') => {
    const nextQueue = mergeTracks(tracks);
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
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
      }
      setTime(0);
    } else {
      select(indexRef.current - 1, wantsPlay.current);
    }
  }, [select, time]);

  const seek = useCallback((seconds: number) => {
    setTime(seconds);
    if (activeSourceRef.current === 'youtube' && ytPlayerRef.current) {
      try {
        ytPlayerRef.current.seekTo(seconds, true);
        return;
      } catch {}
    }
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
  }, []);

  const setVolume = useCallback((value: number) => {
    const nextVolume = Math.max(0, Math.min(100, value));
    if (nextVolume > 0) lastVolume.current = nextVolume;
    storeVolume(nextVolume);
    if (audioRef.current) {
      audioRef.current.volume = nextVolume / 100;
    }
    if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.setVolume(nextVolume);
      } catch {}
    }
  }, [storeVolume]);

  const setAutoplay = useCallback((value: boolean) => {
    autoplayRef.current = value;
    storeAutoplay(value);
  }, [storeAutoplay]);

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
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(100, volume)) / 100;
  }, [volume]);

  const current = queue[index] ?? seedTracks[0];

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

  return {
    audioRef,
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
    activeSource,
    playTracks,
    toggle,
    pause,
    play,
    next,
    previous,
    seek,
    setVolume,
    setAutoplay,
    toggleShuffle,
    addNext,
    removeQueued,
    getPlaybackRequest: () => playRequest.current,
    playQueued: (position: number) => select(position),
    toggleMute: () => setVolume(volume === 0 ? lastVolume.current : 0),
    audioEvents: {
      onPlay: () => {
        if (activeSourceRef.current === 'audio') {
          setIsPlaying(true);
          setIsLoading(false);
          wantsPlay.current = true;
        }
      },
      onPlaying: () => {
        setIsLoading(false);
        failures.current = 0;
        const track = queueRef.current[indexRef.current];
        if (!track) return;
        seen.current.add(trackKey(track));
        optionsRef.current.onPlayed(track);
      },
      onPause: () => {
        if (activeSourceRef.current === 'audio' && audioRef.current?.paused) {
          setIsPlaying(false);
          setIsLoading(false);
          if (!audioRef.current.ended && !audioRef.current.error && audioRef.current.readyState >= 3) {
            wantsPlay.current = false;
          }
        }
      },
      onTimeUpdate: () => {
        if (activeSourceRef.current === 'audio') {
          setTime(audioRef.current?.currentTime || 0);
        }
      },
      onDurationChange: () => {
        if (activeSourceRef.current === 'audio') {
          const actual = audioRef.current?.duration;
          if (actual && Number.isFinite(actual) && actual > 0) {
            setDuration(actual);
          }
        }
      },
      onWaiting: () => {},
      onCanPlay: () => {
        setIsLoading(false);
      },
      onEnded: () => {
        if (activeSourceRef.current === 'audio') {
          void advanceRef.current();
        }
      },
      onError: () => {
        setIsLoading(false);
        if (!wantsPlay.current) return;
        const track = queueRef.current[indexRef.current];
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
