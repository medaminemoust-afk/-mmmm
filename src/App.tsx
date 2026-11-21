import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, AudioLines, BarChart3, Bell, Check, ChevronRight, Compass, ExternalLink, Heart,
  History, Infinity as InfinityIcon, LibraryBig, ListMusic, LoaderCircle, Menu, Music2, Play,
  Plus, RefreshCw, Search, Settings2, Sparkles, TrendingUp, UserRound, X, Download,
} from 'lucide-react';
import heroUrl from './assets/hero.jpg';
import { Artwork, ChartTable, CollectionHero, Dialog, EmptyState, Marquee, SceneCard, SceneMasthead, SectionHeading, Toggle, TrackList } from './components/MusicUI';
import { PlaybackDrawer, PlayerBar } from './components/PlaybackUI';
import { formatReleaseDate, formatTime, newReleasesScene, sceneById, scenes } from './data';
import { useMusicPlayer } from './hooks/useMusicPlayer';
import { useStoredState } from './hooks/useStoredState';
import { configureAppShell } from './lib/appShell';
import { artistFromTrack, artistTracks as fetchArtistTracks, checkDailyPlaylistUpdate, dayLabel, isFreshTrack, loadMoreScene, loadScene, mergeTracks, newReleasesAreFresh, rankTracks, readInitialCatalog, readNewReleases, refreshNewReleases, saveCatalog, scenePlaylist, searchArtists, searchSongs, similarTracks, trackKey, topFifty } from './services/catalog';
import { buildFreshForYou, buildMotivation, buildTasteMix, emptyTaste, recordLike, recordPlay, recordSkip, tasteHighlights, type TasteProfile } from './services/taste';
import { mirrorFollow, mirrorLike, mirrorListening, mirrorPlay, mirrorPlaylistCreate, mirrorPlaylistTrack, mirrorSearch, mirrorSkip } from './services/cloud';
import { fetchInsights, runCloudSync, type ListeningInsights } from './services/sync';
import { downloadTrack, formatBytes, hasOfflineStorage, listDownloads, loadDownloads, offlineKey, removeDownload, type OfflineTrack } from './services/offline';
import type { Artist, InstallPromptEvent, Scene, Track, UserPlaylist, View } from './types';

type ModalState = { type: 'settings' | 'create' } | { type: 'track' | 'add'; track: Track } | null;
type LibraryTab = 'playlists' | 'songs' | 'artists';

const pageTitles: Record<View, string> = {
  discover: 'Discover', charts: 'Top 50', new: 'New music', search: 'Search', library: 'Your library',
  liked: 'Liked songs', recent: 'Recently played', playlist: 'Your playlist', artist: 'Artist',
  insights: 'Listening', downloads: 'Offline music',
};

const REGION_SCENES = ['morocco', 'usa', 'europe', 'afro'];

/**
 * How well a song answers what was typed. A word on its own is the strongest signal:
 * typing "life" must put the songs called Life first, then songs that start with it,
 * then any song that carries the word, and only then everything else.
 */
function searchScore(track: Track, term: string): number {
  const title = track.title.toLowerCase();
  const artist = track.artist.toLowerCase();
  const album = (track.album || '').toLowerCase();
  const words = title.split(/[^a-z0-9\u00c0-\u024f']+/i).filter(Boolean);
  if (title === term) return 120;
  if (artist === term) return 110;
  let score = 0;
  if (title.startsWith(term)) score += 70;
  if (artist.startsWith(term)) score += 55;
  if (words.includes(term)) score += 45;
  if (title.includes(term)) score += 30;
  if (artist.includes(term)) score += 20;
  if (album.includes(term)) score += 5;
  return score;
}

/** Best match first, keeping the catalog's own order for songs that score the same. */
function rankForQuery<T extends Track>(tracks: T[], term: string): T[] {
  return tracks
    .map((track, order) => ({ track, order, score: searchScore(track, term) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map((entry) => entry.track);
}

export default function App() {
  const [view, setView] = useState<View>('discover');
  const [catalog, setCatalog] = useState<Track[]>(readInitialCatalog);
  const catalogRef = useRef(catalog);
  const [sceneId, setSceneId] = useState('global');
  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState('');
  const [newReleases, setNewReleases] = useState<Track[]>(() => readNewReleases()?.tracks ?? []);
  const [newMusicUpdatedAt, setNewMusicUpdatedAt] = useState(() => readNewReleases()?.updatedAt ?? 0);
  const [newMusicBusy, setNewMusicBusy] = useState(false);
  const [newMusicError, setNewMusicError] = useState('');
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [liked, setLiked] = useStoredState<Track[]>('vibe.likes', []);
  const [history, setHistory] = useStoredState<Track[]>('vibe.history', []);
  /** What the listener plays, skips and likes — the engine behind “Made for you”. */
  const [taste, setTaste] = useStoredState<TasteProfile>('vibe.taste', emptyTaste());
  const [userPlaylists, setUserPlaylists] = useStoredState<UserPlaylist[]>('vibe.playlists', []);
  const [followedArtists, setFollowedArtists] = useStoredState<Artist[]>('vibe.artists', []);
  const [profileName, setProfileName] = useStoredState('vibe.name', 'Music lover');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('playlists');
  /** Songs stored on the phone, ready to play with no connection. */
  const [downloads, setDownloads] = useState<OfflineTrack[]>(() => listDownloads());
  const [savingKeys, setSavingKeys] = useState<string[]>([]);
  const savedKeys = useMemo(() => new Set(downloads.map((entry) => entry.key)), [downloads]);
  const savedBytes = useMemo(() => downloads.reduce((total, entry) => total + (entry.bytes || 0), 0), [downloads]);
  const [query, setQuery] = useState('');
  const [foundTracks, setFoundTracks] = useState<Track[]>([]);
  const [foundArtists, setFoundArtists] = useState<Artist[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const [activeArtist, setActiveArtist] = useState<Artist | null>(null);
  const [artistBusy, setArtistBusy] = useState(false);
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [drawer, setDrawer] = useState<'queue' | 'playing' | 'lyrics' | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistDescription, setPlaylistDescription] = useState('');
  const [pendingTrack, setPendingTrack] = useState<Track | null>(null);
  const [toast, setToast] = useState('');
  const [sync, setSync] = useState<{ status: 'idle' | 'busy' | 'merged' | 'local-only'; pulled: number; pushed: number; at: number }>({ status: 'idle', pulled: 0, pushed: 0, at: 0 });
  const [insights, setInsights] = useState<ListeningInsights | null>(null);
  const [insightsBusy, setInsightsBusy] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncStarted = useRef(false);
  const libraryRef = useRef({ likes: liked, playlists: userPlaylists, follows: followedArtists });
  libraryRef.current = { likes: liked, playlists: userPlaylists, follows: followedArtists };
  const searchRef = useRef<HTMLInputElement>(null);
  const sceneRequests = useRef(new Map<string, number>());
  const artistRequest = useRef(0);
  const newMusicSync = useRef(false);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4300);
  }, []);

  const isSavedTrack = useCallback((track: Track) => savedKeys.has(offlineKey(track)), [savedKeys]);
  const isSavingTrack = useCallback((track: Track) => savingKeys.includes(offlineKey(track)), [savingKeys]);

  /** One tap in a track row: save the whole song on the phone, or take it back off. */
  const saveTrack = useCallback(async (track: Track) => {
    if (!hasOfflineStorage()) {
      notify('Offline music works in the vibe app on your phone. Open the APK and try there.');
      return;
    }
    const key = offlineKey(track);
    if (savingKeys.includes(key)) return;
    if (savedKeys.has(key)) {
      await removeDownload(track);
      setDownloads(listDownloads());
      notify(`“${track.title}” removed from this phone.`);
      return;
    }
    setSavingKeys((previous) => [...previous, key]);
    notify(`Downloading “${track.title}” for offline...`);
    const result = await downloadTrack(track);
    setDownloads(listDownloads());
    setSavingKeys((previous) => previous.filter((item) => item !== key));
    notify(result.ok ? `${track.title} — ${result.message}` : `${track.title}: ${result.message}`);
  }, [notify, savedKeys, savingKeys]);

  /**
   * Today's chart replaces yesterday's for one scene. Without this a song that led the
   * chart yesterday keeps its old chart position and outranks today's number one forever.
   */
  const replaceScene = useCallback((id: string, tracks: Track[]) => {
    const others = catalogRef.current.filter((track) => track.sceneId !== id);
    const merged = mergeTracks(tracks, others);
    catalogRef.current = merged;
    setCatalog(merged);
    saveCatalog(merged);
  }, []);

  const addToCatalog = useCallback((tracks: Track[]) => {
    // Newest wins the dedupe: a release that now belongs to a scene replaces its older copy.
    const merged = mergeTracks(tracks, catalogRef.current);
    catalogRef.current = merged;
    setCatalog(merged);
    return merged;
  }, []);

  /** Pulls today's releases on demand; the daily check uses the same path. */
  const refreshNewMusic = useCallback(async () => {
    if (newMusicSync.current) return;
    newMusicSync.current = true;
    setNewMusicBusy(true);
    setNewMusicError('');
    try {
      const { cache, added } = await refreshNewReleases();
      setNewReleases(cache.tracks);
      setNewMusicUpdatedAt(cache.updatedAt);
      addToCatalog(cache.tracks);
      notify(added.length ? `${added.length} new ${added.length === 1 ? 'track' : 'tracks'} added to New music.` : 'New music is already up to date.');
    } catch (error) {
      setNewMusicError(error instanceof Error ? error.message : 'New releases are unreachable right now.');
      notify('Could not reach new releases. Try again in a moment.');
    } finally {
      newMusicSync.current = false;
      setNewMusicBusy(false);
    }
  }, [addToCatalog, notify]);

  /** Autoplay: charts pull their next batch, everything else keeps going as a same-vibe radio. */
  const getMore = useCallback((scene: string) => {
    const isChart = Boolean(sceneById(scene)) && scene !== 'new' && scene !== 'radio';
    const request = isChart ? loadMoreScene(scene) : similarTracks(playerRef.current.current);
    return request.then((tracks) => { addToCatalog(tracks); return tracks; });
  }, [addToCatalog]);
  const onPlayed = useCallback((track: Track) => {
    setHistory((previous) => [track, ...previous.filter((item) => trackKey(item) !== trackKey(track))].slice(0, 120));
    setTaste((previous) => recordPlay(previous, track));
    mirrorPlay(track);
  }, [setHistory, setTaste]);

  const onSkipped = useCallback((track: Track, positionMs?: number) => {
    setTaste((previous) => recordSkip(previous, track));
    mirrorSkip(track, positionMs);
  }, [setTaste]);

  const player = useMusicPlayer({ getCatalog: () => catalogRef.current, getMore, notify, onPlayed, onSkipped });
  const playerRef = useRef(player);
  playerRef.current = player;

  useEffect(() => { configureAppShell(); }, []);

  // Read what is already saved on the phone, so the ticks are right on the first screen.
  useEffect(() => { void loadDownloads().then(setDownloads); }, []);

  // A phone app is one tap on the home screen: keep the browser's install offer to hand.
  useEffect(() => {
    const offer = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', offer);
    return () => window.removeEventListener('beforeinstallprompt', offer);
  }, []);

  /** Charts for every scene, pulled lazily and kept in one catalog. */
  const fetchScene = useCallback(async (id: string, announce = false) => {
    // One counter per scene, so pulling several scenes at once never cancels the others.
    const request = (sceneRequests.current.get(id) ?? 0) + 1;
    sceneRequests.current.set(id, request);
    const isLatest = () => sceneRequests.current.get(id) === request;
    setSceneBusy(id);
    setSceneError('');
    try {
      const tracks = await loadScene(id);
      if (!isLatest()) return [];
      addToCatalog(tracks);
      if (announce) notify(`${tracks.length} fresh tracks pulled into the chart.`);
      return tracks;
    } catch (error) {
      if (isLatest()) setSceneError(error instanceof Error ? error.message : 'The charts are unreachable right now.');
      return [];
    } finally {
      if (isLatest()) setSceneBusy(null);
    }
  }, [addToCatalog, notify]);

  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current) return;
    warmed.current = true;
    void fetchScene('global').then(() => {
      // Warm the scenes people open first so Discover is never empty.
      void Promise.allSettled(['morocco', 'usa', 'europe', 'afro', 'fulltracks'].map((id) => fetchScene(id)));
    });
  }, [fetchScene]);

  // Auto-update: once a day every Top 50 — not only Global — is pulled again and rebuilt
  // from today's chart, so the number one and the rest of the fifty are never yesterday's.
  useEffect(() => {
    let cancelled = false;

    const refreshEverything = async (first: boolean) => {
      const refresh = await checkDailyPlaylistUpdate();
      if (!refresh.changed || cancelled) return;
      notify(first ? 'Daily update: rebuilding every Top 50 with today’s charts.' : 'New day: rebuilding every Top 50.');
      // One scene at a time: the charts API rate-limits bursts, and the app stays usable meanwhile.
      for (const scene of scenes) {
        if (cancelled) return;
        const tracks = await fetchScene(scene.id);
        // Only a real answer replaces a chart: a stub or a failed pull keeps yesterday's list.
        if (tracks.length >= 10) replaceScene(scene.id, tracks);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!cancelled) notify('Every Top 50 is up to date for today.');
    };

    void refreshEverything(true);

    const dailyTimer = setInterval(() => { void refreshEverything(false); }, 30 * 60 * 1000);

    return () => { cancelled = true; clearInterval(dailyTimer); };
  }, [fetchScene, notify, replaceScene]);

  /** Two-way library sync. No login: the device id already used for the event mirror is the account. */
  useEffect(() => {
    if (syncStarted.current) return;
    syncStarted.current = true;
    setSync((previous) => ({ ...previous, status: 'busy' }));
    void runCloudSync(libraryRef.current).then((outcome) => {
      if (outcome.status === 'merged') {
        setLiked(outcome.likes);
        setUserPlaylists(outcome.playlists);
        setFollowedArtists(outcome.follows);
        addToCatalog([...outcome.likes, ...outcome.playlists.flatMap((playlist) => playlist.tracks)]);
      }
      setSync({ status: outcome.status, pulled: outcome.pulled, pushed: outcome.pushed, at: Date.now() });
      if (outcome.status === 'merged' && (outcome.pulled || outcome.pushed)) {
        notify(`Library synced: ${outcome.pulled} pulled, ${outcome.pushed} sent.`);
      }
    });
  }, [addToCatalog, notify, setFollowedArtists, setLiked, setUserPlaylists]);

  /** Listening insights: aggregates computed on the server from this device's real events. */
  useEffect(() => {
    if (view !== 'insights') return;
    let cancelled = false;
    setInsightsBusy(true);
    setInsightsError('');
    void fetchInsights()
      .then((data) => { if (!cancelled) setInsights(data); })
      .catch((error: unknown) => { if (!cancelled) setInsightsError(error instanceof Error ? error.message : 'Insights are unreachable right now.'); })
      .finally(() => { if (!cancelled) setInsightsBusy(false); });
    return () => { cancelled = true; };
  }, [view]);

  /**
   * Listening minutes are read from the audio's own position, never from the wall clock.
   * A player that says it is playing while the stream is stalled, silent after the last song
   * ended, or left running in the background therefore adds no time that was not listened to.
   */
  const listeningRef = useRef({ time: player.time, playing: player.isPlaying, track: player.current, key: trackKey(player.current) });
  listeningRef.current = { time: player.time, playing: player.isPlaying, track: player.current, key: trackKey(player.current) };

  useEffect(() => {
    let lastKey = '';
    let lastTime = 0;
    /** Milliseconds of real playback not yet sent, and the song they belong to. */
    let counted = 0;
    let countedTrack: Track | null = null;

    const flush = () => {
      if (countedTrack && counted >= 5_000) mirrorListening(countedTrack, Math.round(counted));
      counted = 0;
      countedTrack = null;
    };

    const timer = window.setInterval(() => {
      const { time, playing, track, key } = listeningRef.current;
      if (!track) return;
      if (!playing) {
        lastKey = key;
        lastTime = time;
        flush();
        return;
      }
      if (key !== lastKey) {
        // A new song only counts for itself; what was counted goes to the song it was heard in.
        flush();
        lastKey = key;
        lastTime = time;
        countedTrack = track;
        return;
      }
      const step = time - lastTime;
      lastTime = time;
      // A jump is a seek, a track swap or a throttled background tick, not listened time.
      if (!(step > 0) || step > 3) return;
      if (!countedTrack) countedTrack = track;
      counted += step * 1000;
      if (counted >= 30_000) flush();
    }, 1_000);

    return () => {
      window.clearInterval(timer);
      flush();
    };
  }, []);

  // Today's releases belong in their scenes even when the cache is already warm,
  // so every playlist shows its own new tracks on every visit.
  useEffect(() => {
    if (newReleases.length) addToCatalog(newReleases);
  }, [addToCatalog, newReleases]);

  /** New music: pulled automatically on the first visit of each day, then re-checked as the day rolls over. */
  useEffect(() => {
    const sync = async () => {
      if (newMusicSync.current || newReleasesAreFresh()) return;
      newMusicSync.current = true;
      setNewMusicBusy(true);
      setNewMusicError('');
      try {
        const { cache, added, firstRun } = await refreshNewReleases();
        setNewReleases(cache.tracks);
        setNewMusicUpdatedAt(cache.updatedAt);
        addToCatalog(cache.tracks);
        if (!firstRun && added.length) notify(`Daily refresh: ${added.length} new ${added.length === 1 ? 'track' : 'tracks'} out today.`);
      } catch (error) {
        setNewMusicError(error instanceof Error ? error.message : 'New releases are unreachable right now.');
      } finally {
        newMusicSync.current = false;
        setNewMusicBusy(false);
      }
    };
    void sync();
    const rollover = setInterval(() => { void sync(); }, 15 * 60 * 1000);
    return () => clearInterval(rollover);
  }, [addToCatalog, notify]);

  /** Every playlist holds its own music: fill the ones that were never opened. */
  const playlistsFilled = useRef(false);
  useEffect(() => {
    if (view !== 'library' || libraryTab !== 'playlists' || playlistsFilled.current) return;
    playlistsFilled.current = true;
    const missing = scenes.filter((scene) => !catalogRef.current.some((track) => track.sceneId === scene.id));
    let cancelled = false;
    // One scene at a time: the charts API rate-limits bursts, and a failure must not block the rest.
    void (async () => {
      let failures = 0;
      for (const scene of missing) {
        if (cancelled || failures >= 3) break;
        const tracks = await fetchScene(scene.id);
        failures = tracks.length ? 0 : failures + 1;
        await new Promise((resolve) => setTimeout(resolve, failures ? 2000 : 400));
      }
    })();
    return () => { cancelled = true; };
  }, [view, libraryTab, fetchScene]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('scene');
    const requestedView = params.get('view');
    if (requested && sceneById(requested)) { setSceneId(requested); setView('charts'); void fetchScene(requested); return; }
    if (requestedView && ['discover', 'charts', 'new', 'search', 'library'].includes(requestedView)) setView(requestedView as View);
  }, [fetchScene]);

  useEffect(() => {
    if (view !== 'search' || !query.trim()) {
      setSearchBusy(false); setFoundTracks([]); setFoundArtists([]); setSearchError('');
      return;
    }
    let cancelled = false;
    setSearchBusy(true); setSearchError('');
    const timer = setTimeout(() => {
      const term = query.trim();
      void Promise.allSettled([searchSongs(term), searchArtists(term)]).then((results) => {
        if (cancelled) return;
        const tracks = results[0];
        const artistsFound = results[1];
        if (tracks.status === 'fulfilled') { setFoundTracks(tracks.value); addToCatalog(tracks.value); mirrorSearch(term, tracks.value.length); }
        if (artistsFound.status === 'fulfilled') setFoundArtists(artistsFound.value);
        if (tracks.status === 'rejected' && artistsFound.status === 'rejected') setSearchError('Cannot reach the charts. Check your connection and try again.');
      }).finally(() => { if (!cancelled) setSearchBusy(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, view, addToCatalog, searchRetry]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || modal) return;
      if (event.key === '/') { event.preventDefault(); setView('search'); searchRef.current?.focus(); }
      if (event.code === 'Space' && target.tagName !== 'BUTTON' && target.tagName !== 'A') { event.preventDefault(); playerRef.current.toggle(); }
      if (event.key === 'Escape') { setDrawer(null); setSidebarOpen(false); setNotificationsOpen(false); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [modal]);

  useEffect(() => {
    document.title = `${player.isPlaying ? `${player.current.title} · ` : ''}vibe | Full tracks, twenty Top 50s, offline`;
  }, [player.current.title, player.isPlaying]);

  const navigate = (next: View) => {
    setView(next); setSidebarOpen(false); setNotificationsOpen(false);
    if (next !== 'search') setQuery('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const sceneTracks = useCallback((id: string) => scenePlaylist(catalogRef.current.filter((track) => track.sceneId === id)), []);

  const ranked = useMemo(() => scenePlaylist(catalog.filter((track) => track.sceneId === sceneId)), [catalog, sceneId]);
  const globalTop = useMemo(() => topFifty(catalog.filter((track) => track.sceneId === 'global')), [catalog]);
  const longest = useMemo(() => rankTracks(catalog.filter((track) => track.fullLength)).slice(0, 6), [catalog]);

  /**
   * The songs a search shows: what the scene catalog already holds for that word (so the
   * result lands before the network answers) plus the live search, best match on top.
   */
  const searchSongsRanked = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [] as Track[];
    const local = catalog.filter((track) => searchScore(track, term) > 0).slice(0, 24);
    const seen = new Set<string>();
    const merged: Track[] = [];
    foundTracks.forEach((track) => {
      const key = trackKey(track);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(track);
    });
    local.forEach((track) => {
      const key = trackKey(track);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(track);
    });
    return rankForQuery(merged, term);
  }, [catalog, foundTracks, query]);

  /** The three personal playlists, rebuilt whenever the taste or the catalog changes. */
  const mixes = useMemo(() => [
    { id: 'mix', title: 'Your mix', kicker: 'YOUR TASTE, YOUR ORDER', color: '#8a4fd0', tracks: buildTasteMix(catalog, taste) },
    { id: 'motivation', title: 'Motivation', kicker: 'KEEP THE WORK GOING', color: '#e9703f', tracks: buildMotivation(catalog, taste) },
    { id: 'foryou-new', title: 'Fresh for you', kicker: 'NEW MUSIC, RANKED BY YOU', color: '#5fd7b1', tracks: buildFreshForYou(newReleases, taste) },
  ], [catalog, newReleases, taste]);
  const tasteNote = useMemo(() => tasteHighlights(taste), [taste]);

  /** Saved songs as playable tracks: the player reads them off the phone's storage. */
  const downloadedTracks = useMemo<Track[]>(() => downloads.map((entry) => ({
    id: entry.key,
    title: entry.title,
    artist: entry.artist,
    artistId: `offline-${entry.key}`,
    artistHandle: '',
    artistPhoto: '',
    album: entry.album || 'Saved on this phone',
    artwork: entry.artwork || '',
    duration: entry.duration || 0,
    audioUrl: '',
    externalUrl: '',
    sceneId: 'downloads',
    plays: 0,
    favorites: 0,
    fullLength: true,
  })), [downloads]);

  /** Fourteen calm bars, one per day, from the server's counted plays. */
  const insightDays = useMemo(() => {
    if (!insights) return [] as { label: string; plays: number }[];
    const byDay = new Map(insights.days.map((entry) => [entry.day, entry.plays]));
    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.now() - (13 - index) * 86_400_000);
      return {
        label: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        plays: byDay.get(date.toISOString().slice(0, 10)) ?? 0,
      };
    });
  }, [insights]);
  const insightPeak = Math.max(1, ...insightDays.map((entry) => entry.plays));

  const chartArtists = useMemo(() => {
    const totals = new Map<string, Artist & { weight: number }>();
    catalog.forEach((track) => {
      const existing = totals.get(track.artistId);
      totals.set(track.artistId, {
        id: track.artistId, name: track.artist, handle: track.artistHandle,
        photo: track.artistPhoto || existing?.photo || '', genre: track.album,
        weight: (existing?.weight ?? 0) + (track.plays || 1),
      });
    });
    return [...totals.values()].filter((artist) => artist.photo).sort((a, b) => b.weight - a.weight).slice(0, 6);
  }, [catalog]);

  const regionPreviews = useMemo(() => REGION_SCENES.map((id) => ({
    scene: sceneById(id)!,
    rows: topFifty(catalog.filter((track) => track.sceneId === id)).slice(0, 4),
  })), [catalog]);

  useEffect(() => {
    const timer = setTimeout(() => saveCatalog(catalog), 900);
    return () => clearTimeout(timer);
  }, [catalog]);

  const toggleLike = (track: Track) => {
    const exists = liked.some((item) => trackKey(item) === trackKey(track));
    setLiked((previous) => exists ? previous.filter((item) => trackKey(item) !== trackKey(track)) : [track, ...previous]);
    if (!exists) setTaste((previous) => recordLike(previous, track));
    mirrorLike(track, !exists);
    notify(exists ? 'Taken out of your liked songs.' : 'Saved to your liked songs.');
  };

  const openScene = (id: string) => {
    setSceneId(id);
    setPlaylistId(null);
    setView('charts');
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (!catalog.some((track) => track.sceneId === id)) void fetchScene(id);
  };

  const playScene = async (id: string) => {
    const scene = sceneById(id);
    if (!scene) return;
    let tracks = sceneTracks(id).slice(0, 50);
    if (!tracks.length) tracks = (await fetchScene(id)).slice(0, 50);
    if (tracks.length) playerRef.current.playTracks(tracks, 0, scene.name, id);
    else notify('This chart has not landed yet. Give it another try in a moment.');
  };

  const openArtist = (artist: Artist) => {
    const request = ++artistRequest.current;
    setActiveArtist(artist);
    setView('artist');
    setArtistBusy(true);
    window.scrollTo({ top: 0, behavior: 'instant' });
    void fetchArtistTracks(artist).then((tracks) => {
      if (request !== artistRequest.current) return;
      addToCatalog(tracks);
    }).catch(() => {
      if (request === artistRequest.current) notify('This artist could not load right now.');
    }).finally(() => { if (request === artistRequest.current) setArtistBusy(false); });
  };

  const openCreate = (track: Track | null = null) => {
    setPlaylistName(''); setPlaylistDescription(''); setPendingTrack(track); setModal({ type: 'create' });
  };
  const closeModal = useCallback(() => setModal(null), []);

  const activeScene = sceneById(sceneId) ?? scenes[0];
  const selectedPlaylist = userPlaylists.find((playlist) => playlist.id === playlistId) ?? null;
  const artistTracks = useMemo(() => activeArtist ? catalog.filter((track) => track.artistId === activeArtist.id) : [], [catalog, activeArtist]);
  const newMusicStamp = newMusicUpdatedAt ? `Last refresh ${new Date(newMusicUpdatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not refreshed on this device yet';
  const releaseCard = (track: Track, position: number, list: Track[]) => <button className="release-card" key={track.id} onClick={() => player.playTracks(list, position, 'New music', track.sceneId)}>
    <span className="release-art"><Artwork src={track.artwork} alt={`${track.album} cover`} className="release-cover" /><span className="release-play"><Play size={14} fill="currentColor" /></span></span>
    <strong>{track.title}</strong>
    <span className="release-artist">{track.artist}</span>
    <small>{formatReleaseDate(track.releaseDate) || 'Just added'}</small>
  </button>;
  const trackList = (tracks: Track[], label: string, color: string) => <TrackList tracks={tracks} player={player} liked={liked} onLike={toggleLike} onArtist={(track) => openArtist(artistFromTrack(track))} onMore={(track) => setModal({ type: 'track', track })} label={label} color={color} isSaved={isSavedTrack} isSaving={isSavingTrack} onSave={saveTrack} />;
  const totalTime = (tracks: Track[]) => tracks.reduce((total, track) => total + (track.duration || 0), 0);
  const table = (tracks: Track[], label: string, color: string, options: { ranked?: boolean; compact?: boolean; radio?: boolean } = {}) => <ChartTable tracks={tracks} player={player} liked={liked} onLike={toggleLike} onArtist={(track) => openArtist(artistFromTrack(track))} onMore={(track) => setModal({ type: 'track', track })} label={label} sceneColor={color} ranked={options.ranked} compact={options.compact} radio={options.radio} isSaved={isSavedTrack} isSaving={isSavingTrack} onSave={saveTrack} />;
  const sceneRail = (list: Scene[], className = '') => <div className={`scene-rail ${className}`}>{list.map((scene, position) => <SceneCard key={scene.id} scene={scene} index={position} count={catalog.filter((track) => track.sceneId === scene.id).length} busy={sceneBusy === scene.id} onOpen={() => openScene(scene.id)} onPlay={() => { void playScene(scene.id); }} />)}</div>;
  const modalTitle = !modal ? '' : modal.type === 'settings' ? 'Your listening space' : modal.type === 'create' ? 'Make it your playlist' : modal.type === 'add' ? 'Add to a playlist' : 'This track';

  return <MotionConfig reducedMotion="user"><div className="app-shell" style={{ '--scene': activeScene.color } as CSSProperties}>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation">
      <button className="brand" onClick={() => navigate('discover')} aria-label="vibe home"><AudioLines className="brand-icon" size={29} strokeWidth={2.6} /><span>vibe<span className="brand-dot">.</span></span></button>
      <p className="brand-tagline">A Top 50 for everything.</p>
                <nav className="main-nav">{([{ id: 'discover', title: 'Discover', icon: Compass }, { id: 'charts', title: 'Top 50', icon: TrendingUp }, { id: 'new', title: 'New music', icon: Sparkles }, { id: 'search', title: 'Search', icon: Search }, { id: 'library', title: 'Your library', icon: LibraryBig }, { id: 'insights', title: 'Listening', icon: BarChart3 }] as const).map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'nav-selected' : ''}`} onClick={() => { if (item.id === 'charts') openScene(sceneId); else navigate(item.id); if (item.id === 'search') searchRef.current?.focus(); }}>
        {view === item.id && <motion.span className="nav-active-bg" layoutId="active-nav" transition={{ type: 'spring', stiffness: 350, damping: 32 }} />}<item.icon size={20} strokeWidth={1.8} /><span>{item.title}</span>
      </button>)}</nav>
      <div className="sidebar-divider" /><div className="sidebar-label">YOUR COLLECTION</div>
      <button className={`nav-item collection-item ${view === 'liked' ? 'nav-selected' : ''}`} onClick={() => navigate('liked')}><Heart size={19} strokeWidth={1.8} /><span>Liked songs</span>{liked.length > 0 && <span className="nav-count">{liked.length}</span>}</button>
      <button className={`nav-item collection-item ${view === 'recent' ? 'nav-selected' : ''}`} onClick={() => navigate('recent')}><History size={19} strokeWidth={1.8} /><span>Recently played</span></button>
      <button className={`nav-item collection-item ${view === 'downloads' ? 'nav-selected' : ''}`} onClick={() => navigate('downloads')}><Download size={19} strokeWidth={1.8} /><span>Offline music</span>{downloads.length > 0 && <span className="nav-count">{downloads.length}</span>}</button>
      <div className="sidebar-label mixes-label">TOP 50 SCENES<button className="sidebar-add" onClick={() => openCreate()} aria-label="Create playlist"><Plus size={16} /></button></div>
      <div className="sidebar-scenes">{scenes.slice(0, 7).map((scene) => <button key={scene.id} className={`sidebar-scene ${view === 'charts' && sceneId === scene.id ? 'selected-sidebar-scene' : ''}`} onClick={() => openScene(scene.id)}><span className="scene-dot" style={{ '--scene': scene.color } as CSSProperties} /><span className="sidebar-scene-name">{scene.short}</span>{catalog.some((track) => track.sceneId === scene.id) && <span className="scene-tick"><Check size={12} /></span>}</button>)}
        {userPlaylists.slice(0, 3).map((playlist) => <button className="sidebar-scene" key={playlist.id} onClick={() => { setPlaylistId(playlist.id); navigate('playlist'); }}><span className="scene-dot user-dot"><ListMusic size={12} /></span><span className="sidebar-scene-name">{playlist.name}</span></button>)}
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-autoplay"><div className="autoplay-label"><InfinityIcon size={19} /><span>Keep it going</span></div><Toggle label="Smart autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div>
        <p className="autoplay-caption">Unheard tracks from the same chart.</p>
        <div className="sidebar-profile"><span className="profile-avatar"><UserRound size={19} strokeWidth={1.6} /></span><div><strong>{profileName}</strong><span>{liked.length} liked · {history.length} played</span></div><button className="icon-button sidebar-settings" onClick={() => setModal({ type: 'settings' })} aria-label="Open settings"><Settings2 size={18} /></button></div>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="topbar-title"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={23} /></button>{(view === 'charts' || view === 'artist' || view === 'playlist') && <button className="icon-button back-button" onClick={() => navigate('discover')} aria-label="Back to Discover"><ArrowLeft size={19} /></button>}<h1>{view === 'charts' ? activeScene.name : pageTitles[view]}</h1></div>
        <div className="topbar-actions">
          <div className={`search-box ${view === 'search' ? 'search-focused' : ''}`}><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); if (view !== 'search') setView('search'); }} onFocus={() => { if (query.trim()) setView('search'); }} placeholder="Search real songs and artists" aria-label="Search music" onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); searchRef.current?.blur(); navigate('discover'); } }} />{query ? <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button> : <kbd>/</kbd>}</div>
          <div className="notification-wrap"><button className={`icon-button notifications-button ${notificationsOpen ? 'active-icon' : ''}`} onClick={() => setNotificationsOpen(!notificationsOpen)} aria-label="Notifications" aria-expanded={notificationsOpen}><Bell size={20} strokeWidth={1.7} /><span className="notification-dot" /></button>
            <AnimatePresence>{notificationsOpen && <motion.div className="notification-popover" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div><strong>{scenes.length} Top 50s, zero clips.</strong><button className="icon-button" onClick={() => setNotificationsOpen(false)} aria-label="Close notifications"><X size={15} /></button></div>
              <p>Global, Morocco, USA, Europe, Afro, Funk, Rap, R&B and more. Every track streams in full.</p>
              <button className="text-link" onClick={() => openScene('global')}>Open the Global Top 50<ArrowRight size={14} /></button>
            </motion.div>}</AnimatePresence>
          </div>
          <button className="topbar-profile" onClick={() => setModal({ type: 'settings' })} aria-label="Profile and preferences">{profileName.charAt(0).toUpperCase()}</button>
        </div>
      </header>

      <motion.div className="page-content" key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
        {view === 'discover' && <>
          <section className="discovery-hero" aria-label="Global Top 50">
            <motion.img className="hero-image" src={heroUrl} alt="A listener with headphones on a Casablanca rooftop at blue hour" initial={{ scale: 1.04 }} animate={{ scale: 1 }} transition={{ duration: 1.6, ease: 'easeOut' }} />
            <div className="hero-shade" />
            <div className="hero-copy">
              <div className="hero-eyebrow"><span />THE ARTISTS YOU ACTUALLY KNOW</div>
              <h2>Every Top 50,<br /><span>every scene.</span></h2>
              <p>ElGrandeToto, Drake, Burna Boy, Bruno Mars, Central Cee — eighteen charts of famous artists, plus a Full Tracks 50 that streams complete songs.</p>
              <div className="hero-actions">
                <button className="primary-button" onClick={() => { void playScene('global'); }}>{sceneBusy === 'global' ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}Play Global Top 50</button>
                <button className="hero-secondary" onClick={() => openScene('morocco')}>Morocco Top 50<ArrowRight size={16} /></button>
              </div>
            </div>
            <div className="hero-card">
              <div className="hero-card-head"><span className="eyebrow">GLOBAL · LIVE</span><button onClick={() => openScene('global')}>Full chart<ArrowRight size={13} /></button></div>
              {globalTop.length ? globalTop.slice(0, 4).map((track, position) => <button className="hero-card-row" key={track.id} onClick={() => player.playTracks(globalTop, position, 'Global Top 50', 'global')}>
                <span className="hero-card-rank">{String(position + 1).padStart(2, '0')}</span>
                <Artwork src={track.artwork} alt="" className="hero-card-art" />
                <span className="hero-card-names"><strong>{track.title}</strong><small>{track.artist}</small></span>
                <span className="hero-card-time">{formatTime(track.duration)}</span>
              </button>) : <div className="hero-card-loading"><LoaderCircle className="spin" size={20} /><span>Pulling the global chart...</span></div>}
            </div>
          </section>
          <Marquee items={globalTop.slice(0, 10).map((track, position) => `${String(position + 1).padStart(2, '0')} ${track.title} — ${track.artist}`)} color={scenes[0].color} />

          <div className="content-padding">
            <section className="mix-section" aria-label="Made for you">
              <SectionHeading title="Made for you" kicker="CHANGES AS YOU LISTEN"><span className="mix-note">{tasteNote}</span></SectionHeading>
              <p className="section-description">Built from what you play, skip and like — not from a fixed chart. Motivation keeps the tempo up for work, and Fresh for you ranks today’s releases against your taste. Skip a song early and it drops.</p>
              <div className="mix-grid">
                {mixes.map((mix) => <article className="mix-card" key={mix.id} style={{ '--scene': mix.color } as CSSProperties}>
                  <button className="mix-cover" disabled={!mix.tracks.length} onClick={() => player.playTracks(mix.tracks, 0, mix.title, mix.id)} aria-label={`Play ${mix.title}`}>
                    <Artwork src={mix.tracks[0]?.artwork || ''} alt={`${mix.title} cover`} className="mix-art" />
                    <span className="mix-play"><Play size={15} fill="currentColor" /></span>
                  </button>
                  <div className="mix-copy"><span className="eyebrow">{mix.kicker}</span><strong>{mix.title}</strong><span>{mix.tracks.length ? `${mix.tracks.length} tracks · ${mix.tracks[0]?.artist}` : 'Fills in as your music arrives'}</span></div>
                </article>)}
              </div>
              {mixes[0].tracks.length > 0 && table(mixes[0].tracks.slice(0, 6), 'Your mix', '#8a4fd0', { compact: true })}
            </section>

            <section className="new-music-section">
              <SectionHeading title="New music" kicker="REFRESHED EVERY DAY">
                <div className="new-music-tools">
                  <button className="text-link" onClick={() => { void refreshNewMusic(); }} disabled={newMusicBusy}>{newMusicBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh</button>
                  <button className="text-link muted-link" onClick={() => navigate('new')}>See all<ArrowRight size={15} /></button>
                </div>
              </SectionHeading>
              <p className="section-description">Today’s drops, newest release first. {newMusicStamp}{newReleases.length ? ` · ${newReleases.length} tracks` : ''}.</p>
              {newReleases.length ? <div className="release-grid" style={{ '--scene': newReleasesScene.color } as CSSProperties}>{newReleases.slice(0, 6).map(releaseCard)}</div>
                : newMusicBusy ? <div className="loading-state"><LoaderCircle className="spin" size={22} /><p>Checking today’s releases...</p></div>
                : <p className="new-music-empty">{newMusicError || 'No releases pulled in yet today.'} <button className="text-link" onClick={() => { void refreshNewMusic(); }}>Try again<ArrowRight size={14} /></button></p>}
            </section>

            <section className="scenes-section"><SectionHeading title="Every Top 50" kicker="PICK A SCENE">{sceneBusy && !ranked.length ? <LoaderCircle className="spin" size={18} /> : <button className="text-link muted-link" onClick={() => openScene('global')}>Open the charts<ArrowRight size={15} /></button>}</SectionHeading>{sceneRail(scenes)}</section>

            <div className="discovery-bottom">
              <section className="top-tracks-section">
                <SectionHeading title="Global Top 50" kicker="LIVE FROM THE WORLD CHART"><button className="text-link muted-link" onClick={() => openScene('global')}>See all fifty<ArrowRight size={15} /></button></SectionHeading>
                {globalTop.length ? table(globalTop.slice(0, 8), 'Global Top 50', scenes[0].color, { ranked: true }) : <div className="loading-state"><LoaderCircle className="spin" size={24} /><p>Counting the plays around the world...</p></div>}
              </section>
              <section className="artist-spotlight">
                <SectionHeading title="Behind the charts" kicker="MOST PLAYED HERE" />
                <div className="spotlight-list">{(chartArtists.length ? chartArtists : []).map((artist) => <button className="spotlight-artist" key={artist.id} onClick={() => openArtist(artist)}><Artwork src={artist.photo} alt={`${artist.name}`} className="spotlight-photo" portrait /><span className="spotlight-names"><strong>{artist.name}</strong><span>{artist.genre}</span></span><ChevronRight size={16} /></button>)}{!chartArtists.length && <p className="spotlight-empty">Artists appear here as the charts load.</p>}</div>
              </section>
            </div>

            <section className="region-section">
              <SectionHeading title="Places, ranked" kicker="ONLY ARTISTS FROM THERE" />
              <div className="region-grid">{regionPreviews.map(({ scene, rows }) => <div className="region-card" key={scene.id} style={{ '--scene': scene.color } as CSSProperties}>
                <div className="region-card-head">
                  <span className="region-card-fifty" aria-hidden="true">50</span>
                  <div><span className="eyebrow">{scene.region ?? scene.short}</span><h3>{scene.name}</h3><p>{scene.short} only · ranked by plays</p></div>
                  <button className="primary-button region-play" disabled={!rows.length} onClick={() => { void playScene(scene.id); }} aria-label={`Play ${scene.name}`}>{sceneBusy === scene.id ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}</button>
                </div>
                {rows.length ? table(rows, scene.name, scene.color, { compact: true }) : <div className="region-empty"><button className="text-link" onClick={() => openScene(scene.id)}>Open {scene.name}<ArrowRight size={14} /></button><span>{sceneBusy === scene.id ? 'Loading the artists...' : sceneError || 'Pulling this scene in now.'}</span></div>}
              </div>)}</div>
            </section>

            <section className="fresh-section">
              <SectionHeading title="Trending complete full songs" kicker="FULL SONGS ONLY"><button className="text-link muted-link" onClick={() => openScene('fulltracks')}>Full Tracks 50<ArrowRight size={15} /></button></SectionHeading>
              <p className="section-description">Every song on vibe streams in complete full-length version, from the first second to the last — and any of them can be saved for offline.</p>
              {longest.length ? table(longest, 'Full tracks', sceneById('fulltracks')!.color) : <button className="independent-loading" onClick={() => openScene('fulltracks')}><Music2 size={24} strokeWidth={1.5} /><span>Loading complete tracks...</span><ArrowRight size={17} /></button>}
            </section>
          </div>
        </>}

        {view === 'charts' && <div className="content-padding standalone-page">
          <div className="scene-pills" role="tablist" aria-label="Choose a Top 50">{scenes.map((scene) => <button role="tab" key={scene.id} aria-selected={sceneId === scene.id} className={`scene-pill ${sceneId === scene.id ? 'selected-pill' : ''}`} style={{ '--scene': scene.color } as CSSProperties} onClick={() => openScene(scene.id)}><span className="pill-dot" />{scene.short}</button>)}</div>
          <SceneMasthead scene={activeScene} count={ranked.length} loading={sceneBusy === activeScene.id} playing={player.sceneId === activeScene.id && player.isPlaying} onPlay={() => { void playScene(activeScene.id); }} onRefresh={() => { void fetchScene(activeScene.id, true); }} />
          {sceneError && !ranked.length && <p className="error-note">{sceneError} <button onClick={() => void fetchScene(activeScene.id)}>Try again</button></p>}
          {sceneBusy === activeScene.id && !ranked.length && <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Ranking {activeScene.name}...</p></div>}
          {ranked.length > 0 && table(ranked, activeScene.name, activeScene.color, { ranked: true })}
          {ranked.length > 0 && <div className="chart-footer">
            <span>{ranked.length} of 50 shown{ranked.length < 50 ? ' · more land as the chart fills' : ''} · Updated {dayLabel()}</span>
            <button className="outline-button" disabled={sceneBusy === activeScene.id} onClick={() => { void fetchScene(activeScene.id, true); }}>{sceneBusy === activeScene.id ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}Pull the next batch</button>
          </div>}
          {ranked.length === 0 && !sceneBusy && <EmptyState title="Nothing ranked here yet" description="This scene has not returned tracks. Pull it again, or open a chart that is already loaded." action="Pull this scene" onAction={() => void fetchScene(activeScene.id)} />}
          <section className="other-scenes"><SectionHeading title="Jump to another Top 50" kicker="EVERY SCENE" />{sceneRail(scenes.filter((scene) => scene.id !== activeScene.id).slice(0, 8))}</section>
        </div>}

        {view === 'new' && <div className="content-padding standalone-page">
          <div className="page-intro">
            <span className="eyebrow">FRESH EVERY DAY</span>
            <h2>New music, refreshed daily.</h2>
            <p>The app pulls today’s releases once a day on its own, so the newest drops are waiting every time you open it. Pull them in by hand whenever you are impatient.</p>
          </div>
          <div className="fresh-toolbar">
            <div><strong>{newReleases.length ? `${newReleases.length} tracks out now` : 'Nothing pulled in yet'}</strong><span>{newMusicStamp}</span></div>
            <button className="outline-button" disabled={newMusicBusy} onClick={() => { void refreshNewMusic(); }}>{newMusicBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}Refresh now</button>
          </div>
          {newMusicError && <p className="error-note">{newMusicError} <button onClick={() => { void refreshNewMusic(); }}>Try again</button></p>}
          {newReleases.length ? <>
            <div className="release-grid release-grid-wide" style={{ '--scene': newReleasesScene.color } as CSSProperties}>{newReleases.slice(0, 12).map(releaseCard)}</div>
            <div className="fresh-table"><SectionHeading title="Everything new" kicker="NEWEST FIRST" />{table(newReleases, 'New music', newReleasesScene.color)}</div>
          </> : newMusicBusy ? <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Pulling today’s releases...</p></div>
            : <EmptyState title="No releases landed yet" description="The daily refresh has not run on this device. Pull today’s releases in now." action="Refresh new music" onAction={() => { void refreshNewMusic(); }} />}
        </div>}

        {view === 'search' && <div className="content-padding standalone-page">{!query.trim() ? <>
          <div className="page-intro"><span className="eyebrow">SEARCH THE REAL CATALOG</span><h2>Find any song, any artist.</h2><p>Results come straight from the charts catalog: real releases, real artwork, real track lengths.</p></div>
          <SectionHeading title="Or start with a Top 50" kicker="EVERY SCENE" />{sceneRail(scenes.slice(0, 8))}
        </> : <>
          <div className="search-results-heading"><h2>Results for <span>"{query}"</span></h2>{searchBusy && <LoaderCircle size={19} className="spin" aria-label="Searching" />}</div>
          <p className="search-radio-hint"><Sparkles size={14} />Tap a track to start a radio in that vibe — next plays something similar, not the row below.</p>
          <SectionHeading title="Songs" kicker={searchSongsRanked.length ? `${searchSongsRanked.length} RESULTS` : undefined} />
          {searchSongsRanked.length ? table(searchSongsRanked.slice(0, 60), `Search: ${query}`, activeScene.color, { radio: true }) : searchBusy ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>Searching the catalog...</p></div> : <EmptyState icon={<Search size={32} />} title={searchError ? 'A little connection trouble' : 'Nothing found yet'} description={searchError || 'Try another spelling, a song title, or an artist name.'} action={searchError ? 'Try again' : 'Browse the Top 50s'} onAction={() => searchError ? setSearchRetry((value) => value + 1) : openScene('global')} />}
          {foundArtists.length > 0 && <section className="search-artist-section"><SectionHeading title="Artists" /><div className="search-artist-grid">{foundArtists.map((artist) => <button className="search-artist" key={artist.id} onClick={() => openArtist(artist)}><Artwork src={artist.photo} alt={`${artist.name}`} className="search-artist-photo" portrait /><strong>{artist.name}</strong><span>{artist.genre}</span></button>)}</div></section>}
        </>}</div>}

        {view === 'library' && <div className="content-padding standalone-page">
          <div className="library-intro"><div className="page-intro"><span className="eyebrow">YOUR OWN LITTLE WORLD</span><h2>Keep the good stuff close.</h2><p>Your playlists, liked songs and the artists you follow.</p></div><button className="outline-button" onClick={() => openCreate()}><Plus size={16} />Create playlist</button></div>
          <div className="filter-tabs library-tabs">{(['playlists', 'songs', 'artists'] as LibraryTab[]).map((tab) => <button className={libraryTab === tab ? 'selected-tab' : ''} key={tab} onClick={() => setLibraryTab(tab)}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}</div>
          {libraryTab === 'playlists' && <>
            <section className="library-downloads">
              <SectionHeading title="Offline music" kicker="PLAYS WITHOUT INTERNET"><button className="text-link muted-link" onClick={() => navigate('downloads')}>Open downloads<ArrowRight size={15} /></button></SectionHeading>
              <p className="section-description">{downloads.length ? `${downloads.length} ${downloads.length === 1 ? 'song' : 'songs'} saved · ${formatBytes(savedBytes)} on this phone. They play with no connection at all.` : 'Tap the download icon next to any song and the whole track stays on your phone — no internet needed to play it.'}</p>
            </section>
            <SectionHeading title="Your playlists" />
            {userPlaylists.length > 0 ? <div className="user-playlist-grid">{userPlaylists.map((playlist) => <button className="user-playlist" key={playlist.id} onClick={() => { setPlaylistId(playlist.id); navigate('playlist'); }}><Artwork src={playlist.tracks[0]?.artwork || ''} alt={`${playlist.name} artwork`} className="user-playlist-cover" /><strong>{playlist.name}</strong><span>{playlist.tracks.length} tracks</span></button>)}</div> : <EmptyState icon={<ListMusic size={32} />} title="Make room for your favorites" description="Create a playlist, then add tracks from the menu next to any song." action="Create your first playlist" onAction={() => openCreate()} />}
            <section className="auto-playlists">
              <SectionHeading title="Every Top 50 as a playlist" kicker="REBUILT EVERY DAY"><span className="auto-playlist-note">Its own music only</span></SectionHeading>
              <p className="section-description">Each playlist carries its own scene's tracks. Today's chart leaders hold the top, and every day the rest of the fifty is redrawn from that scene's catalog — so the number one changes with the chart, not once a week.</p>
              <div className="user-playlist-grid">
                {scenes.map((scene) => {
                  const tracks = scenePlaylist(catalog.filter((track) => track.sceneId === scene.id));
                  const fresh = tracks.filter(isFreshTrack).length;
                  return <div className="auto-playlist" key={scene.id} style={{ '--scene': scene.color } as CSSProperties}>
                    <button className="user-playlist" onClick={() => openScene(scene.id)}>
                      <Artwork src={tracks[0]?.artwork || ''} alt={`${scene.name} cover`} className="user-playlist-cover" />
                      <strong>{scene.name}</strong>
                      <span>{tracks.length ? `${tracks.length} tracks${fresh ? ` · ${fresh} new` : ''}` : sceneBusy === scene.id ? 'Filling this playlist...' : 'Tap to load its music'}</span>
                    </button>
                    <button className="auto-playlist-play" disabled={!tracks.length} onClick={() => player.playTracks(tracks, 0, scene.name, scene.id)} aria-label={`Play the ${scene.name} playlist`}><Play size={15} fill="currentColor" /></button>
                  </div>;
                })}
              </div>
            </section>
            <section className="library-curated"><SectionHeading title="Your charts" kicker="READY WHEN YOU ARE" />{sceneRail(scenes.slice(0, 6))}</section>
          </>}
          {libraryTab === 'songs' && (liked.length ? table(liked, 'Liked songs', activeScene.color) : <EmptyState icon={<Heart size={32} />} title="Your favorites live here" description="Tap the heart next to a track to keep it here." action="Open the Global Top 50" onAction={() => openScene('global')} />)}
          {libraryTab === 'artists' && <><SectionHeading title={followedArtists.length ? 'Artists you follow' : 'Most played here'} /><div className="artist-grid">{(followedArtists.length ? followedArtists : chartArtists).map((artist) => <button className="search-artist" key={artist.id} onClick={() => openArtist(artist)}><Artwork src={artist.photo} alt={`${artist.name}`} className="search-artist-photo" portrait /><strong>{artist.name}</strong><span>{artist.genre}</span></button>)}</div></>}
        </div>}

        {(view === 'liked' || view === 'recent') && <div className="content-padding standalone-page">
          <CollectionHero
            kicker={view === 'liked' ? 'LIKED SONGS' : 'RECENTLY PLAYED'}
            title={view === 'liked' ? 'Liked Songs' : 'Recently played'}
            description={view === 'liked' ? 'Every song you kept, in one place. Tap the heart anywhere and it lands here.' : 'Pick up where the last session left off.'}
            cover={(view === 'liked' ? liked : history)[0]?.artwork || ''}
            count={(view === 'liked' ? liked : history).length}
            seconds={totalTime(view === 'liked' ? liked : history)}
            color={view === 'liked' ? '#8a4fd0' : activeScene.color}
            playing={player.isPlaying && (view === 'liked' ? liked : history).some((track) => trackKey(track) === trackKey(player.current))}
            shuffleOn={player.shuffle}
            onPlay={() => player.playTracks(view === 'liked' ? liked : history, 0, pageTitles[view], view === 'liked' ? 'liked' : 'recent')}
            onShuffle={() => player.toggleShuffle()}
          ><span className="collection-owner">Made by {profileName}</span></CollectionHero>
          {(view === 'liked' ? liked : history).length
            ? trackList(view === 'liked' ? liked : history, pageTitles[view], activeScene.color)
            : <EmptyState title={view === 'liked' ? 'A heart is a good place to start' : 'Your listening story starts here'} description={view === 'liked' ? 'Save a song with the heart button and it waits for you here.' : 'Play a track and it shows up here, ready whenever you are.'} action="Open the Global Top 50" onAction={() => openScene('global')} />}
        </div>}

        {view === 'downloads' && <div className="content-padding standalone-page">
          <CollectionHero
            kicker="SAVED ON THIS PHONE"
            title="Offline music"
            description="Downloaded songs live on your phone, so the metro, a plane or no data at all changes nothing."
            cover={downloads[0]?.artwork || ''}
            count={downloads.length}
            seconds={downloads.reduce((total, entry) => total + (entry.duration || 0), 0)}
            color="#5fd7b1"
            playing={player.isPlaying && downloads.some((entry) => entry.key === offlineKey(player.current))}
            shuffleOn={player.shuffle}
            onPlay={() => player.playTracks(downloadedTracks, 0, 'Offline music', 'downloads')}
            onShuffle={() => player.toggleShuffle()}
          ><span className="collection-owner">{downloads.length ? `${formatBytes(savedBytes)} on this phone` : 'Nothing saved yet'}</span></CollectionHero>
          {downloads.length > 0 && <div className="downloads-note"><Download size={18} /><div><strong>Plays with the SIM out</strong><p>Each saved song is the whole track on your phone's storage, not a stream. Tap the tick in a row to free the space again.</p></div></div>}
          {downloads.length
            ? <div className="playlist-tracks">{trackList(downloadedTracks, 'Offline music', '#5fd7b1')}</div>
            : <EmptyState icon={<Download size={32} />} title="Nothing saved for offline yet" description="Open any chart, tap the download icon next to a song, and the whole track is kept on this phone. After that it plays with no internet." action="Browse the Global Top 50" onAction={() => openScene('global')} />}
        </div>}

        {view === 'playlist' && selectedPlaylist && <>
          <div className="content-padding standalone-page">
            <CollectionHero
              kicker="PLAYLIST"
              title={selectedPlaylist.name}
              description={selectedPlaylist.description || 'A little collection of your favorite sounds.'}
              cover={selectedPlaylist.tracks[0]?.artwork || ''}
              count={selectedPlaylist.tracks.length}
              seconds={totalTime(selectedPlaylist.tracks)}
              color={activeScene.color}
              playing={player.isPlaying && selectedPlaylist.tracks.some((track) => trackKey(track) === trackKey(player.current))}
              shuffleOn={player.shuffle}
              onPlay={() => player.playTracks(selectedPlaylist.tracks, 0, selectedPlaylist.name, selectedPlaylist.id)}
              onShuffle={() => player.toggleShuffle()}
            ><span className="collection-owner">Made by {profileName}</span></CollectionHero>
          </div>
          <div className="content-padding playlist-tracks">
            <SectionHeading title="The tracks" />
            {selectedPlaylist.tracks.length ? trackList(selectedPlaylist.tracks, selectedPlaylist.name, activeScene.color) : <EmptyState title="This playlist is a blank canvas" description="Find a song you love, open its menu, and add it here." action="Search the catalog" onAction={() => navigate('search')} />}
            <div className="playlist-autoplay-note"><InfinityIcon size={21} /><div><strong>Every ending is a new beginning.</strong><p>{player.autoplay ? 'When a list ends, unheard tracks from the same scene take over. Nothing repeats.' : 'Autoplay is off, so playback stops at the end of this list.'}</p></div><Toggle label="Playlist autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div>
          </div>
        </>}

        {view === 'artist' && activeArtist && <>
          <section className="artist-banner" style={{ '--scene': activeScene.color } as CSSProperties}>
            <Artwork src={activeArtist.photo} alt={`${activeArtist.name}`} className="artist-detail-photo" portrait eager />
            <div><span className="eyebrow">THE ARTIST BEHIND THE TRACKS</span><h2>{activeArtist.name}</h2><p>{activeArtist.genre}</p>
              <div className="artist-detail-actions">
                <button className="primary-button" disabled={!artistTracks.length} onClick={() => player.playTracks(artistTracks.slice(0, 50), 0, activeArtist.name, activeArtist.id)}><Play size={15} fill="currentColor" />Play artist</button>
                <button className="outline-button" onClick={() => { const following = followedArtists.some((artist) => artist.id === activeArtist.id); setFollowedArtists((previous) => following ? previous.filter((artist) => artist.id !== activeArtist.id) : [...previous, activeArtist]); mirrorFollow(activeArtist, !following); notify(following ? `${activeArtist.name} removed from your artists.` : `${activeArtist.name} added to your artists.`); }}>{followedArtists.some((artist) => artist.id === activeArtist.id) ? <><Check size={16} />Following</> : <><Plus size={16} />Follow</>}</button>
              </div>
            </div>
          </section>
          <div className="content-padding playlist-tracks">
            <SectionHeading title="Biggest tracks" kicker="RANKED BY PLAYS">{artistBusy && <LoaderCircle className="spin" size={18} />}</SectionHeading>
            {artistTracks.length ? table(artistTracks.slice(0, 50), activeArtist.name, activeScene.color, { ranked: true }) : artistBusy ? <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Loading this artist's biggest tracks...</p></div> : <EmptyState title="No tracks loaded yet" description="Search this artist to pull their catalog in." action="Search artist" onAction={() => { setQuery(activeArtist.name); navigate('search'); }} />}
          </div>
        </>}

        {view === 'insights' && <div className="content-padding standalone-page">
          <div className="page-intro"><span className="eyebrow">COUNTED, NOT GUESSED</span><h2>How you actually listen.</h2><p>Plays, skips, favourites and listening minutes, counted on the vibe server from this device's real events. Nothing on this page is estimated.</p></div>
          <div className="sync-strip">
            <div>
              <strong>{sync.status === 'merged' ? 'Library synced' : sync.status === 'busy' ? 'Syncing your library...' : sync.status === 'local-only' ? 'Local-only mode' : 'Not synced yet'}</strong>
              <span>{sync.status === 'merged'
                ? `${sync.pulled} pulled from the cloud · ${sync.pushed} sent · ${sync.at ? new Date(sync.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'just now'}`
                : sync.status === 'local-only' ? 'No backend on this device, so likes and playlists stay in local storage.' : 'Your library syncs once on start-up.'}</span>
            </div>
            <button className="text-link" onClick={() => navigate('library')}>Open library<ArrowRight size={14} /></button>
          </div>
          {insightsBusy && !insights && <div className="loading-state"><LoaderCircle className="spin" size={24} /><p>Counting your listening...</p></div>}
          {insightsError && !insights && <p className="error-note">{insightsError}</p>}
          {insights && <>
            <div className="insight-grid">
              <article className="insight-card"><span>Minutes listened</span><strong>{insights.minutes}</strong><small>measured while audio played</small></article>
              <article className="insight-card"><span>Plays</span><strong>{insights.plays}</strong><small>{insights.distinctTracks} different tracks</small></article>
              <article className="insight-card"><span>Skips</span><strong>{insights.skips}</strong><small>{Math.round(insights.skipRate * 100)}% of starts</small></article>
              <article className="insight-card"><span>Liked songs</span><strong>{insights.likes}</strong><small>{insights.distinctArtists} artists played</small></article>
            </div>
            <section className="insight-section">
              <SectionHeading title="Last 14 days" kicker="PLAYS PER DAY" />
              <div className="insight-bars">{insightDays.map((entry) => <div className="insight-bar" key={entry.label} title={`${entry.label}: ${entry.plays} plays`}><span style={{ height: `${Math.max(4, Math.round((entry.plays / insightPeak) * 100))}%` }} /><small>{entry.plays}</small></div>)}</div>
              <p className="insight-caption">Each bar is one day, counted from tracks you actually started.</p>
            </section>
            <section className="insight-section">
              <SectionHeading title="Your top artists" kicker="BY REAL PLAYS" />
              {insights.topArtists.length
                ? <div className="insight-list">{insights.topArtists.map((artist) => <div className="insight-row" key={artist.artistId}><strong>{artist.name}</strong><span>{artist.plays} {artist.plays === 1 ? 'play' : 'plays'}</span></div>)}</div>
                : <p className="small-muted">No plays recorded on the server yet. Play a track for 30 seconds and it lands here.</p>}
            </section>
            {insights.topTracks.length > 0 && <section className="insight-section">
              <SectionHeading title="Most played tracks" kicker="REPEATS FIRST" />
              <div className="insight-list">{insights.topTracks.map((track) => <div className="insight-row" key={track.id}><strong>{track.title}<small> · {track.artist}</small></strong><span>{track.plays} {track.plays === 1 ? 'play' : 'plays'}</span></div>)}</div>
            </section>}
            <p className="insight-caption">Local taste engine: {tasteNote}</p>
          </>}
        </div>}

        <footer className="content-footer"><span><AudioLines size={15} />{scenes.length} Top 50s with complete full-length songs.</span><span>Full track streaming powered by YouTube & Audius</span></footer>
      </motion.div>
    </main>

    {/* Hidden audio playback engine (100% invisible, audio only) */}
    <div
      id="vibe-yt-player-container"
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: '240px',
        height: '135px',
        opacity: 0.0001,
        pointerEvents: 'none',
        zIndex: -9999,
        overflow: 'hidden',
      }}
      aria-hidden="true"
    >
      <div id="vibe-yt-player-host" style={{ width: '240px', height: '135px' }} />
    </div>

    <nav className="mobile-tabs" aria-label="App navigation">
      {([{ id: 'discover', title: 'Discover', icon: Compass }, { id: 'charts', title: 'Top 50', icon: TrendingUp }, { id: 'new', title: 'New', icon: Sparkles }, { id: 'search', title: 'Search', icon: Search }, { id: 'library', title: 'Library', icon: LibraryBig }] as const).map((item) => <button key={item.id} className={`mobile-tab ${view === item.id ? 'mobile-tab-active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => { if (item.id === 'charts') openScene(sceneId); else navigate(item.id); }}><item.icon size={19} strokeWidth={1.9} /><span>{item.title}</span></button>)}
    </nav>

    <audio ref={player.audioRef} preload="metadata" {...player.audioEvents} />
    {/* Second engine, silent until a blend needs it: this is what lets two songs overlap. */}
    <audio ref={player.mixRef} preload="auto" {...player.audioEvents} />
    <PlayerBar player={player} liked={liked} onLike={toggleLike} onArtist={(track) => openArtist(artistFromTrack(track))} drawer={drawer} onDrawer={setDrawer} />
    <PlaybackDrawer player={player} liked={liked} onLike={toggleLike} artist={artistFromTrack(player.current)} onArtist={(artist) => { openArtist(artist); setDrawer(null); }} drawer={drawer} onDrawer={setDrawer} />

    <AnimatePresence>{modal && <Dialog title={modalTitle} onClose={closeModal}>
      {modal.type === 'settings' && <div className="settings-content">
        <label className="form-label" htmlFor="profile-name">What should we call you?</label>
        <input className="form-input" id="profile-name" maxLength={32} value={profileName} onChange={(event) => setProfileName(event.target.value)} onBlur={() => { if (!profileName.trim()) setProfileName('Music lover'); }} />
        <div className="setting-row"><div><strong>Keep playing</strong><p>When a list ends, unheard tracks from the same Top 50 take over. Nothing repeats.</p></div><Toggle label="Settings autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div>
        <div className="setting-row"><div><strong>AutoMix · DJ blends</strong><p>The last seconds of each song blend into the next one: it starts under the outro and both ride together, the way a DJ mixes. Vibe reads the length of the track and picks how long the blend is.</p></div><Toggle label="AutoMix" enabled={player.automix} onChange={player.setAutomix} /></div>
        <div className="setting-row"><div><strong>Blend into the next song</strong><p>{player.crossfade > 0 ? `The next track starts ${player.crossfade} seconds before this one ends, so nothing stops between songs.` : 'Blending is off: each song ends, then the next one starts.'}{player.automix ? ' AutoMix is on and chooses the length per song; this is what it falls back to.' : ''}</p>
          <div className="blend-choices">{[0, 6, 10, 15].map((seconds) => <button key={seconds} type="button" className={`blend-choice ${player.crossfade === seconds ? 'selected' : ''}`} onClick={() => player.setCrossfade(seconds)} aria-pressed={player.crossfade === seconds}>{seconds === 0 ? 'Off' : `${seconds}s`}</button>)}</div></div></div>
        <div className="setting-row"><div><strong>Lyrics sync</strong><p>{player.lyricsOffset === 0 ? 'Words land with the voice. If they run early, delay them; if they lag, pull them forward.' : player.lyricsOffset > 0 ? `Words are delayed by ${player.lyricsOffset.toFixed(1)}s to sit on the voice.` : `Words are pulled ${Math.abs(player.lyricsOffset).toFixed(1)}s ahead to sit on the voice.`} This is the default: any song you tune from its lyrics screen keeps its own timing, saved on this phone.</p>
          <div className="sync-controls"><input className="range-input sync-range" type="range" min={-3} max={3} step={0.1} value={player.lyricsOffset} onChange={(event) => player.setLyricsOffset(Number(event.target.value))} aria-label="Lyrics timing offset in seconds" style={{ '--range-fill': `${(player.lyricsOffset + 3) / 6 * 100}%` } as CSSProperties} /><span className="sync-value">{player.lyricsOffset > 0 ? '+' : ''}{player.lyricsOffset.toFixed(1)}s</span><button type="button" className="blend-choice" onClick={() => player.setLyricsOffset(0)} disabled={player.lyricsOffset === 0}>Reset</button></div></div></div>
        <div className="setting-row"><div><strong>Full tracks streaming</strong><p>Every song across all twenty Top 50s streams in full version via YouTube and Audius, from start to finish.</p></div><button className="text-link" onClick={() => { openScene('fulltracks'); closeModal(); }}>Open Top 50<ArrowRight size={14} /></button></div>
        <div className="setting-row"><div><strong>New music, every day</strong><p>The app refreshes the new releases once a day on its own, and you can pull them in whenever you want.</p></div><button className="text-link" onClick={() => { navigate('new'); closeModal(); }}>Open<ArrowRight size={14} /></button></div>
        <div className="setting-row"><div><strong>Music on this phone</strong><p>{downloads.length ? `${downloads.length} ${downloads.length === 1 ? 'song' : 'songs'} saved, ${formatBytes(savedBytes)}. They play with no internet, no wifi and no data.` : 'Download any song from a chart and it plays with no internet at all.'}</p></div><button className="text-link" onClick={() => { navigate('downloads'); closeModal(); }}>Open<ArrowRight size={14} /></button></div>
        {installEvent && <div className="setting-row"><div><strong>Put vibe on your phone</strong><p>Install it once and it opens full screen like an app, with your library kept on the device.</p></div><button className="outline-button install-button" onClick={() => { void installEvent.prompt(); setInstallEvent(null); }}>Install</button></div>}
        <div className="settings-shortcuts"><span>Pause / play<kbd>Space</kbd></span><span>Search music<kbd>/</kbd></span></div>
        <p className="settings-source">Music streams complete full versions via YouTube integration & Audius. Liked songs and playlists stay saved in your browser.</p>
        <button className="primary-button full-width" onClick={closeModal}>Back to the music<ArrowRight size={16} /></button>
      </div>}
      {modal.type === 'create' && <form className="playlist-form" onSubmit={(event) => { event.preventDefault(); if (!playlistName.trim()) return; const playlist: UserPlaylist = { id: `playlist-${Date.now()}`, name: playlistName.trim(), description: playlistDescription.trim(), tracks: pendingTrack ? [pendingTrack] : [], createdAt: Date.now() }; setUserPlaylists((previous) => [...previous, playlist]); mirrorPlaylistCreate(playlist); setPlaylistId(playlist.id); setModal(null); navigate('playlist'); notify(`${playlist.name} is ready.`); }}>
        <p>A home for the songs you want to come back to.</p>
        <label className="form-label" htmlFor="playlist-name">Playlist name</label>
        <input data-autofocus className="form-input" id="playlist-name" placeholder="Late night, loud bass" maxLength={60} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} required />
        <label className="form-label" htmlFor="playlist-description">Description <span>(optional)</span></label>
        <textarea className="form-input" id="playlist-description" placeholder="What is the feeling?" maxLength={180} value={playlistDescription} onChange={(event) => setPlaylistDescription(event.target.value)} rows={3} />
        <button type="submit" className="primary-button full-width" disabled={!playlistName.trim()}><Plus size={17} />Create playlist</button>
      </form>}
      {(modal.type === 'track' || modal.type === 'add') && <>
        <div className="modal-track"><Artwork src={modal.track.artwork} alt="Cover" className="modal-track-art" /><div><strong>{modal.track.title}</strong><span>{modal.track.artist}</span><span className="modal-track-meta">{modal.track.album} · {formatTime(modal.track.duration)} · complete track</span></div></div>
        {modal.type === 'track' ? <div className="track-action-list">
          <button onClick={() => { player.addNext(modal.track); setModal(null); }}><ListMusic size={18} />Play next<ChevronRight size={16} /></button>
          <button onClick={() => { toggleLike(modal.track); setModal(null); }}><Heart size={18} />{liked.some((track) => trackKey(track) === trackKey(modal.track)) ? 'Remove from liked songs' : 'Save to liked songs'}<ChevronRight size={16} /></button>
          <button onClick={() => setModal({ type: 'add', track: modal.track })}><Plus size={18} />Add to a playlist<ChevronRight size={16} /></button>
          <button onClick={() => { void saveTrack(modal.track); setModal(null); }}><Download size={18} />{savedKeys.has(offlineKey(modal.track)) ? 'Remove from this phone' : 'Download for offline'}<ChevronRight size={16} /></button>
          <button onClick={() => { openArtist(artistFromTrack(modal.track)); setModal(null); }}><UserRound size={18} />Go to the artist<ChevronRight size={16} /></button>
          {selectedPlaylist?.tracks.some((track) => track.id === modal.track.id) && <button onClick={() => { setUserPlaylists((previous) => previous.map((playlist) => playlist.id === selectedPlaylist.id ? { ...playlist, tracks: playlist.tracks.filter((track) => track.id !== modal.track.id) } : playlist)); mirrorPlaylistTrack(selectedPlaylist, modal.track, false); setModal(null); notify('Removed from this playlist.'); }}><X size={18} />Remove from this playlist<ChevronRight size={16} /></button>}
          <a href={modal.track.externalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} />Open on Audius<ArrowRight size={16} /></a>
        </div> : <div className="add-to-playlist-list">
          {userPlaylists.map((playlist) => <button key={playlist.id} onClick={() => { const exists = playlist.tracks.some((track) => trackKey(track) === trackKey(modal.track)); if (!exists) setUserPlaylists((previous) => previous.map((item) => item.id === playlist.id ? { ...item, tracks: [...item.tracks, modal.track] } : item)); if (!exists) mirrorPlaylistTrack(playlist, modal.track, true); setModal(null); notify(exists ? 'That track is already in this playlist.' : `Added to ${playlist.name}.`); }}><Artwork src={playlist.tracks[0]?.artwork || ''} alt="Playlist cover" className="queue-art" /><span><strong>{playlist.name}</strong><small>{playlist.tracks.length} tracks</small></span><Plus size={17} /></button>)}
          {!userPlaylists.length && <p className="small-muted">Your first playlist is one click away.</p>}
          <button className="create-from-track" onClick={() => openCreate(modal.track)}><Plus size={20} /><strong>Create a new playlist</strong><ArrowRight size={16} /></button>
        </div>}
      </>}
    </Dialog>}</AnimatePresence>

    <div className="toast-region" aria-live="polite" aria-atomic="true"><AnimatePresence>{toast && <motion.div className="toast" key={toast} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}><Check size={17} /><span>{toast}</span><button onClick={() => setToast('')} className="icon-button" aria-label="Dismiss notification"><X size={14} /></button></motion.div>}</AnimatePresence></div>
  </div></MotionConfig>;
}
