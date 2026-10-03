import { useCallback, useEffect, useRef, useState } from 'react';
import { seedTracks } from '../data';
import { mergeTracks, randomOrder, trackKey } from '../services/catalog';
import type { Track } from '../types';
import { useStoredState } from './useStoredState';

interface PlayerOptions {
  getCatalog: () => Track[];
  getMore: (sceneId: string) => Promise<Track[]>;
  notify: (message: string) => void;
  onPlayed: (track: Track) => void;
}

const initialQueue = seedTracks.slice(0, 6);

export function useMusicPlayer(options: PlayerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<Track[]>(initialQueue);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(30);
  const [label, setLabel] = useState('Full Length');
  const [sceneId, setSceneId] = useState('fulllength');
  const [isRadio, setIsRadio] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [autoplay, storeAutoplay] = useStoredState('vibe.autoplay', true);
  const [volume, storeVolume] = useStoredState('vibe.volume', 70);

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
    setIsLoading(audio.readyState < 3);
    setIsPlaying(true);
    void audio.play().catch((error: DOMException) => {
      if (request !== playRequest.current || error.name === 'AbortError') return;
      setIsLoading(false);
      setIsPlaying(false);
      if (error.name === 'NotAllowedError') {
        wantsPlay.current = false;
        optionsRef.current.notify('Your browser paused playback. Press play to keep listening.');
      } else if (!audio.error) {
        wantsPlay.current = false;
        optionsRef.current.notify('That track would not start. Skipping to the next one.');
      }
    });
  }, []);

  const select = useCallback((nextIndex: number, play = true) => {
    const track = queueRef.current[nextIndex];
    const audio = audioRef.current;
    if (!track || !audio) return;
    ++playRequest.current;
    audio.pause();
    indexRef.current = nextIndex;
    setIndex(nextIndex);
    setTime(0);
    setDuration(track.duration);
    wantsPlay.current = play;
    audio.src = track.audioUrl;
    audio.load();
    setIsPlaying(play);
    if (play) {
      seen.current.add(trackKey(track));
      playAudio();
    }
  }, [playAudio]);

  const pause = useCallback(() => {
    ++playRequest.current;
    wantsPlay.current = false;
    audioRef.current?.pause();
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const toggle = useCallback(() => {
    if (wantsPlay.current) pause();
    else playAudio();
  }, [pause, playAudio]);

  const playTracks = useCallback((tracks: Track[], startIndex = 0, nextLabel = 'Your mix', nextScene = 'fulllength') => {
    const nextQueue = mergeTracks(tracks);
    if (!nextQueue.length) {
      optionsRef.current.notify('Nothing to play yet. Give the chart a second to land.');
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
      optionsRef.current.notify('End of this list. Pick another Top 50 to keep going.');
      return;
    }
    advancing.current = true;
    setIsLoading(true);
    wantsPlay.current = true;
    const currentSession = session.current;
    const currentRequest = playRequest.current;
    const scene = sceneRef.current;
    const excluded = new Set([...originals.current, ...seen.current, ...queueRef.current.map(trackKey)]);
    const candidates = () => optionsRef.current.getCatalog().filter((track) => track.sceneId === scene && !excluded.has(trackKey(track)) && !unavailable.current.has(track.id));
    try {
      // Keep digging for unheard tracks in the same scene instead of replaying the list.
      let found = candidates();
      let offline = false;
      for (let attempt = 0; found.length < 5 && attempt < 4; attempt++) {
        try { await optionsRef.current.getMore(scene); } catch { offline = true; break; }
        if (currentSession !== session.current || currentRequest !== playRequest.current || !wantsPlay.current) return;
        found = candidates();
      }
      if (currentSession !== session.current || currentRequest !== playRequest.current || !wantsPlay.current) return;
      if (!found.length) {
        pause();
        optionsRef.current.notify(offline ? 'Could not reach the charts for more tracks. Press next to try again.' : 'You heard everything in this chart so far. Try another Top 50.');
        return;
      }
      const fresh = randomOrder(found.slice(0, 40)).slice(0, 12);
      const start = queueRef.current.length;
      commitQueue([...queueRef.current, ...fresh]);
      setIsRadio(true);
      select(start);
      optionsRef.current.notify('Still the same scene, still unheard. The list keeps going.');
    } finally {
      if (currentSession === session.current) {
        advancing.current = false;
        setIsLoading(false);
      }
    }
  }, [commitQueue, pause, select]);
  advanceRef.current = next;

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.currentTime > 3 || indexRef.current === 0) {
      audio.currentTime = 0;
      setTime(0);
    } else {
      select(indexRef.current - 1, wantsPlay.current);
    }
  }, [select]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
    setTime(audio.currentTime);
  }, []);

  const setVolume = useCallback((value: number) => {
    const nextVolume = Math.max(0, Math.min(100, value));
    if (nextVolume > 0) lastVolume.current = nextVolume;
    storeVolume(nextVolume);
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
      title: current.title, artist: current.artist, album: current.album,
      artwork: current.artwork ? [{ src: current.artwork, sizes: '500x500', type: 'image/jpeg' }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', playAudio], ['pause', pause], ['previoustrack', previous],
      ['nexttrack', () => { void next(); }],
      ['seekto', (event) => { if (event.seekTime !== undefined) seek(event.seekTime); }],
    ];
    handlers.forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Only basic actions are guaranteed. */ } });
    return () => handlers.forEach(([action]) => { try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Optional API. */ } });
  }, [current, next, pause, playAudio, previous, seek]);

  return {
    audioRef, queue, index, current, isPlaying, isLoading, time, duration, label, sceneId, isRadio,
    shuffle, autoplay, volume, playTracks, toggle, pause, next, previous, seek, setVolume,
    setAutoplay, toggleShuffle, addNext, removeQueued,
    getPlaybackRequest: () => playRequest.current,
    playQueued: (position: number) => select(position),
    toggleMute: () => setVolume(volume === 0 ? lastVolume.current : 0),
    audioEvents: {
      onPlay: () => { setIsPlaying(true); wantsPlay.current = true; },
      onPlaying: () => {
        setIsLoading(false);
        failures.current = 0;
        const track = queueRef.current[indexRef.current];
        if (!track) return;
        seen.current.add(trackKey(track));
        optionsRef.current.onPlayed(track);
      },
      onPause: () => {
        if (audioRef.current?.paused) {
          setIsPlaying(false);
          if (!audioRef.current.ended && !audioRef.current.error && audioRef.current.readyState >= 3) wantsPlay.current = false;
        }
      },
      onTimeUpdate: () => setTime(audioRef.current?.currentTime || 0),
      onDurationChange: () => {
        const actual = audioRef.current?.duration;
        if (actual && Number.isFinite(actual)) setDuration(actual);
      },
      onWaiting: () => { if (wantsPlay.current) setIsLoading(true); },
      onCanPlay: () => setIsLoading(false),
      onEnded: () => { void advanceRef.current(); },
      onError: () => {
        setIsLoading(false);
        if (!wantsPlay.current) return;
        const track = queueRef.current[indexRef.current];
        if (track) unavailable.current.add(track.id);
        if (++failures.current <= 3) {
          optionsRef.current.notify('That track would not load. Moving on.');
          void advanceRef.current();
        } else {
          pause();
          optionsRef.current.notify('Playback is struggling. Check your connection, then press play.');
        }
      },
    },
  };
}

export type MusicPlayer = ReturnType<typeof useMusicPlayer>;
