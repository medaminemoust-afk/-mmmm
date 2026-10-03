import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, AudioLines, Bell, Check, ChevronRight, Compass, ExternalLink, Heart,
  History, Infinity as InfinityIcon, LibraryBig, ListMusic, LoaderCircle, Menu, Music2, Play,
  Plus, Search, Settings2, TrendingUp, UserRound, X,
} from 'lucide-react';
import heroUrl from './assets/hero.jpg';
import { Artwork, ChartTable, Dialog, EmptyState, Marquee, SceneCard, SceneMasthead, SectionHeading, Toggle } from './components/MusicUI';
import { PlaybackDrawer, PlayerBar } from './components/PlaybackUI';
import { formatTime, sceneById, scenes } from './data';
import { useMusicPlayer } from './hooks/useMusicPlayer';
import { useStoredState } from './hooks/useStoredState';
import { configureAppShell } from './lib/appShell';
import { artistFromTrack, artistTracks as fetchArtistTracks, loadMoreScene, loadScene, mergeTracks, rankTracks, readInitialCatalog, saveCatalog, searchArtists, searchSongs, trackKey, topFifty } from './services/catalog';
import type { Artist, Scene, Track, UserPlaylist, View } from './types';

type ModalState = { type: 'settings' | 'create' } | { type: 'track' | 'add'; track: Track } | null;
type LibraryTab = 'playlists' | 'songs' | 'artists';

const pageTitles: Record<View, string> = {
  discover: 'Discover', charts: 'Top 50', search: 'Search', library: 'Your library',
  liked: 'Liked songs', recent: 'Recently played', playlist: 'Your playlist', artist: 'Artist',
};

const REGION_SCENES = ['morocco', 'usa', 'europe', 'afro'];

export default function App() {
  const [view, setView] = useState<View>('discover');
  const [catalog, setCatalog] = useState<Track[]>(readInitialCatalog);
  const catalogRef = useRef(catalog);
  const [sceneId, setSceneId] = useState('global');
  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState('');
  const [liked, setLiked] = useStoredState<Track[]>('vibe.likes', []);
  const [history, setHistory] = useStoredState<Track[]>('vibe.history', []);
  const [userPlaylists, setUserPlaylists] = useStoredState<UserPlaylist[]>('vibe.playlists', []);
  const [followedArtists, setFollowedArtists] = useStoredState<Artist[]>('vibe.artists', []);
  const [profileName, setProfileName] = useStoredState('vibe.name', 'Music lover');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('playlists');
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
  const [drawer, setDrawer] = useState<'queue' | 'playing' | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [playlistName, setPlaylistName] = useState('');
  const [playlistDescription, setPlaylistDescription] = useState('');
  const [pendingTrack, setPendingTrack] = useState<Track | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sceneRequest = useRef(0);
  const artistRequest = useRef(0);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4300);
  }, []);

  const addToCatalog = useCallback((tracks: Track[]) => {
    const merged = mergeTracks(catalogRef.current, tracks);
    catalogRef.current = merged;
    setCatalog(merged);
    return merged;
  }, []);

  const getMore = useCallback((scene: string) => loadMoreScene(scene).then((tracks) => { addToCatalog(tracks); return tracks; }), [addToCatalog]);
  const onPlayed = useCallback((track: Track) => {
    setHistory((previous) => [track, ...previous.filter((item) => trackKey(item) !== trackKey(track))].slice(0, 120));
  }, [setHistory]);

  const player = useMusicPlayer({ getCatalog: () => catalogRef.current, getMore, notify, onPlayed });
  const playerRef = useRef(player);
  playerRef.current = player;

  useEffect(() => { configureAppShell(); }, []);

  /** Charts for every scene, pulled lazily and kept in one catalog. */
  const fetchScene = useCallback(async (id: string, announce = false) => {
    const request = ++sceneRequest.current;
    setSceneBusy(id);
    setSceneError('');
    try {
      const tracks = await loadScene(id);
      if (request !== sceneRequest.current) return [];
      addToCatalog(tracks);
      if (announce) notify(`${tracks.length} fresh tracks pulled into the chart.`);
      return tracks;
    } catch (error) {
      if (request === sceneRequest.current) setSceneError(error instanceof Error ? error.message : 'The charts are unreachable right now.');
      return [];
    } finally {
      if (request === sceneRequest.current) setSceneBusy(null);
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('scene');
    const requestedView = params.get('view');
    if (requested && sceneById(requested)) { setSceneId(requested); setView('charts'); void fetchScene(requested); return; }
    if (requestedView && ['discover', 'charts', 'search', 'library'].includes(requestedView)) setView(requestedView as View);
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
        if (tracks.status === 'fulfilled') { setFoundTracks(tracks.value); addToCatalog(tracks.value); }
        if (artistsFound.status === 'fulfilled') setFoundArtists(artistsFound.value);
        if (tracks.status === 'rejected' && artistsFound.status === 'rejected') setSearchError('Cannot reach the charts. Check your connection and try again.');
      }).finally(() => { if (!cancelled) setSearchBusy(false); });
    }, 420);
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
    document.title = `${player.isPlaying ? `${player.current.title} · ` : ''}vibe. | Full tracks, twenty Top 50s`;
  }, [player.current.title, player.isPlaying]);

  const navigate = (next: View) => {
    setView(next); setSidebarOpen(false); setNotificationsOpen(false);
    if (next !== 'search') setQuery('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const sceneTracks = useCallback((id: string) => topFifty(catalogRef.current.filter((track) => track.sceneId === id)), []);

  const ranked = useMemo(() => topFifty(catalog.filter((track) => track.sceneId === sceneId)), [catalog, sceneId]);
  const globalTop = useMemo(() => topFifty(catalog.filter((track) => track.sceneId === 'global')), [catalog]);
  const longest = useMemo(() => rankTracks(catalog.filter((track) => track.fullLength)).slice(0, 6), [catalog]);

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
  const table = (tracks: Track[], label: string, color: string, options: { ranked?: boolean; compact?: boolean } = {}) => <ChartTable tracks={tracks} player={player} liked={liked} onLike={toggleLike} onArtist={(track) => openArtist(artistFromTrack(track))} onMore={(track) => setModal({ type: 'track', track })} label={label} sceneColor={color} ranked={options.ranked} compact={options.compact} />;
  const sceneRail = (list: Scene[], className = '') => <div className={`scene-rail ${className}`}>{list.map((scene, position) => <SceneCard key={scene.id} scene={scene} index={position} count={catalog.filter((track) => track.sceneId === scene.id).length} busy={sceneBusy === scene.id} onOpen={() => openScene(scene.id)} onPlay={() => { void playScene(scene.id); }} />)}</div>;
  const modalTitle = !modal ? '' : modal.type === 'settings' ? 'Your listening space' : modal.type === 'create' ? 'Make it your playlist' : modal.type === 'add' ? 'Add to a playlist' : 'This track';

  return <MotionConfig reducedMotion="user"><div className="app-shell" style={{ '--scene': activeScene.color } as CSSProperties}>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation">
      <button className="brand" onClick={() => navigate('discover')} aria-label="vibe home"><AudioLines className="brand-icon" size={29} strokeWidth={2.6} /><span>vibe<span className="brand-dot">.</span></span></button>
      <p className="brand-tagline">A Top 50 for everything.</p>
      <nav className="main-nav">{([{ id: 'discover', title: 'Discover', icon: Compass }, { id: 'charts', title: 'Top 50', icon: TrendingUp }, { id: 'search', title: 'Search', icon: Search }, { id: 'library', title: 'Your library', icon: LibraryBig }] as const).map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'nav-selected' : ''}`} onClick={() => { if (item.id === 'charts') openScene(sceneId); else navigate(item.id); if (item.id === 'search') searchRef.current?.focus(); }}>
        {view === item.id && <motion.span className="nav-active-bg" layoutId="active-nav" transition={{ type: 'spring', stiffness: 350, damping: 32 }} />}<item.icon size={20} strokeWidth={1.8} /><span>{item.title}</span>
      </button>)}</nav>
      <div className="sidebar-divider" /><div className="sidebar-label">YOUR COLLECTION</div>
      <button className={`nav-item collection-item ${view === 'liked' ? 'nav-selected' : ''}`} onClick={() => navigate('liked')}><Heart size={19} strokeWidth={1.8} /><span>Liked songs</span>{liked.length > 0 && <span className="nav-count">{liked.length}</span>}</button>
      <button className={`nav-item collection-item ${view === 'recent' ? 'nav-selected' : ''}`} onClick={() => navigate('recent')}><History size={19} strokeWidth={1.8} /><span>Recently played</span></button>
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
              <SectionHeading title="Play these in full" kicker="NO 30 SECOND LIMIT"><button className="text-link muted-link" onClick={() => openScene('fulltracks')}>Full Tracks 50<ArrowRight size={15} /></button></SectionHeading>
              <p className="section-description">Label releases above can only be sampled for 30 seconds. These independent songs stream complete, every second of them.</p>
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
            <span>{ranked.length} of 50 shown{ranked.length < 50 ? ' · more land as the chart fills' : ''}</span>
            <button className="outline-button" disabled={sceneBusy === activeScene.id} onClick={() => { void fetchScene(activeScene.id, true); }}>{sceneBusy === activeScene.id ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}Pull the next batch</button>
          </div>}
          {ranked.length === 0 && !sceneBusy && <EmptyState title="Nothing ranked here yet" description="This scene has not returned tracks. Pull it again, or open a chart that is already loaded." action="Pull this scene" onAction={() => void fetchScene(activeScene.id)} />}
          <section className="other-scenes"><SectionHeading title="Jump to another Top 50" kicker="EVERY SCENE" />{sceneRail(scenes.filter((scene) => scene.id !== activeScene.id).slice(0, 8))}</section>
        </div>}

        {view === 'search' && <div className="content-padding standalone-page">{!query.trim() ? <>
          <div className="page-intro"><span className="eyebrow">SEARCH THE REAL CATALOG</span><h2>Find any song, any artist.</h2><p>Results come straight from the charts catalog: real releases, real artwork, real track lengths.</p></div>
          <SectionHeading title="Or start with a Top 50" kicker="EVERY SCENE" />{sceneRail(scenes.slice(0, 8))}
        </> : <>
          <div className="search-results-heading"><h2>Results for <span>"{query}"</span></h2>{searchBusy && <LoaderCircle size={19} className="spin" aria-label="Searching" />}</div>
          {foundArtists.length > 0 && <section className="search-artist-section"><SectionHeading title="Artists" /><div className="search-artist-grid">{foundArtists.map((artist) => <button className="search-artist" key={artist.id} onClick={() => openArtist(artist)}><Artwork src={artist.photo} alt={`${artist.name}`} className="search-artist-photo" portrait /><strong>{artist.name}</strong><span>{artist.genre}</span></button>)}</div></section>}
          <SectionHeading title="Songs" kicker={foundTracks.length ? `${foundTracks.length} RESULTS` : undefined} />
          {foundTracks.length ? table(foundTracks.slice(0, 60), `Search: ${query}`, activeScene.color) : searchBusy ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>Searching the catalog...</p></div> : <EmptyState icon={<Search size={32} />} title={searchError ? 'A little connection trouble' : 'Nothing found yet'} description={searchError || 'Try another spelling, a song title, or an artist name.'} action={searchError ? 'Try again' : 'Browse the Top 50s'} onAction={() => searchError ? setSearchRetry((value) => value + 1) : openScene('global')} />}
        </>}</div>}

        {view === 'library' && <div className="content-padding standalone-page">
          <div className="library-intro"><div className="page-intro"><span className="eyebrow">YOUR OWN LITTLE WORLD</span><h2>Keep the good stuff close.</h2><p>Your playlists, liked songs and the artists you follow.</p></div><button className="outline-button" onClick={() => openCreate()}><Plus size={16} />Create playlist</button></div>
          <div className="filter-tabs library-tabs">{(['playlists', 'songs', 'artists'] as LibraryTab[]).map((tab) => <button className={libraryTab === tab ? 'selected-tab' : ''} key={tab} onClick={() => setLibraryTab(tab)}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}</div>
          {libraryTab === 'playlists' && <>
            <SectionHeading title="Your playlists" />
            {userPlaylists.length > 0 ? <div className="user-playlist-grid">{userPlaylists.map((playlist) => <button className="user-playlist" key={playlist.id} onClick={() => { setPlaylistId(playlist.id); navigate('playlist'); }}><Artwork src={playlist.tracks[0]?.artwork || ''} alt={`${playlist.name} artwork`} className="user-playlist-cover" /><strong>{playlist.name}</strong><span>{playlist.tracks.length} tracks</span></button>)}</div> : <EmptyState icon={<ListMusic size={32} />} title="Make room for your favorites" description="Create a playlist, then add tracks from the menu next to any song." action="Create your first playlist" onAction={() => openCreate()} />}
            <section className="library-curated"><SectionHeading title="Your charts" kicker="READY WHEN YOU ARE" />{sceneRail(scenes.slice(0, 6))}</section>
          </>}
          {libraryTab === 'songs' && (liked.length ? table(liked, 'Liked songs', activeScene.color) : <EmptyState icon={<Heart size={32} />} title="Your favorites live here" description="Tap the heart next to a track to keep it here." action="Open the Global Top 50" onAction={() => openScene('global')} />)}
          {libraryTab === 'artists' && <><SectionHeading title={followedArtists.length ? 'Artists you follow' : 'Most played here'} /><div className="artist-grid">{(followedArtists.length ? followedArtists : chartArtists).map((artist) => <button className="search-artist" key={artist.id} onClick={() => openArtist(artist)}><Artwork src={artist.photo} alt={`${artist.name}`} className="search-artist-photo" portrait /><strong>{artist.name}</strong><span>{artist.genre}</span></button>)}</div></>}
        </div>}

        {(view === 'liked' || view === 'recent') && <div className="content-padding standalone-page">
          <div className="collection-intro"><span className={`collection-symbol ${view === 'liked' ? 'heart-symbol' : ''}`}>{view === 'liked' ? <Heart size={44} strokeWidth={1.4} /> : <History size={44} strokeWidth={1.4} />}</span><div><span className="eyebrow">MADE OF YOUR MOMENTS</span><h2>{view === 'liked' ? 'The ones you love.' : 'Back to a good feeling.'}</h2><p>{view === 'liked' ? `${liked.length} favorites, all yours.` : `${history.length} tracks you spent time with.`}</p></div></div>
          {(view === 'liked' ? liked : history).length ? <>
            <div className="list-page-actions"><button className="primary-button" onClick={() => player.playTracks(view === 'liked' ? liked : history, 0, pageTitles[view], view === 'liked' ? 'liked' : 'recent')}><Play size={15} fill="currentColor" />Play {view === 'liked' ? 'favorites' : 'again'}</button><span>{(view === 'liked' ? liked : history).length} tracks</span></div>
            {table(view === 'liked' ? liked : history, pageTitles[view], activeScene.color)}
          </> : <EmptyState title={view === 'liked' ? 'A heart is a good place to start' : 'Your listening story starts here'} description={view === 'liked' ? 'Save a song with the heart button and it waits for you here.' : 'Play a track and it shows up here, ready whenever you are.'} action="Open the Global Top 50" onAction={() => openScene('global')} />}
        </div>}

        {view === 'playlist' && selectedPlaylist && <>
          <section className="playlist-banner" style={{ '--scene': activeScene.color } as CSSProperties}>
            <Artwork src={selectedPlaylist.tracks[0]?.artwork || ''} alt="Playlist cover" className="detail-cover" />
            <div className="playlist-copy"><span className="eyebrow">YOUR PLAYLIST</span><h2>{selectedPlaylist.name}</h2><p>{selectedPlaylist.description || 'A little collection of your favorite sounds.'}</p>
              <span className="playlist-meta">{selectedPlaylist.tracks.length} tracks<span className="fact-dot" />Made by you</span>
              <button className="primary-button" disabled={!selectedPlaylist.tracks.length} onClick={() => player.playTracks(selectedPlaylist.tracks, 0, selectedPlaylist.name, selectedPlaylist.id)}><Play size={15} fill="currentColor" />Play playlist</button>
            </div>
          </section>
          <div className="content-padding playlist-tracks">
            <SectionHeading title="The tracks" />
            {selectedPlaylist.tracks.length ? table(selectedPlaylist.tracks, selectedPlaylist.name, activeScene.color) : <EmptyState title="This playlist is a blank canvas" description="Find a song you love, open its menu, and add it here." action="Search the catalog" onAction={() => navigate('search')} />}
            <div className="playlist-autoplay-note"><InfinityIcon size={21} /><div><strong>Every ending is a new beginning.</strong><p>{player.autoplay ? 'When a list ends, unheard tracks from the same scene take over. Nothing repeats.' : 'Autoplay is off, so playback stops at the end of this list.'}</p></div><Toggle label="Playlist autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div>
          </div>
        </>}

        {view === 'artist' && activeArtist && <>
          <section className="artist-banner" style={{ '--scene': activeScene.color } as CSSProperties}>
            <Artwork src={activeArtist.photo} alt={`${activeArtist.name}`} className="artist-detail-photo" portrait eager />
            <div><span className="eyebrow">THE ARTIST BEHIND THE TRACKS</span><h2>{activeArtist.name}</h2><p>{activeArtist.genre}</p>
              <div className="artist-detail-actions">
                <button className="primary-button" disabled={!artistTracks.length} onClick={() => player.playTracks(artistTracks.slice(0, 50), 0, activeArtist.name, activeArtist.id)}><Play size={15} fill="currentColor" />Play artist</button>
                <button className="outline-button" onClick={() => { const following = followedArtists.some((artist) => artist.id === activeArtist.id); setFollowedArtists((previous) => following ? previous.filter((artist) => artist.id !== activeArtist.id) : [...previous, activeArtist]); notify(following ? `${activeArtist.name} removed from your artists.` : `${activeArtist.name} added to your artists.`); }}>{followedArtists.some((artist) => artist.id === activeArtist.id) ? <><Check size={16} />Following</> : <><Plus size={16} />Follow</>}</button>
              </div>
            </div>
          </section>
          <div className="content-padding playlist-tracks">
            <SectionHeading title="Biggest tracks" kicker="RANKED BY PLAYS">{artistBusy && <LoaderCircle className="spin" size={18} />}</SectionHeading>
            {artistTracks.length ? table(artistTracks.slice(0, 50), activeArtist.name, activeScene.color, { ranked: true }) : artistBusy ? <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Loading this artist's biggest tracks...</p></div> : <EmptyState title="No tracks loaded yet" description="Search this artist to pull their catalog in." action="Search artist" onAction={() => { setQuery(activeArtist.name); navigate('search'); }} />}
          </div>
        </>}

        <footer className="content-footer"><span><AudioLines size={15} />{scenes.length} Top 50s of the artists you know.</span><span>Charts and samples from Deezer · complete tracks from Audius</span></footer>
      </motion.div>
    </main>

    <audio ref={player.audioRef} preload="metadata" {...player.audioEvents} />
    <PlayerBar player={player} liked={liked} onLike={toggleLike} onArtist={(track) => openArtist(artistFromTrack(track))} drawer={drawer} onDrawer={setDrawer} />
    <PlaybackDrawer player={player} liked={liked} onLike={toggleLike} artist={artistFromTrack(player.current)} onArtist={(artist) => { openArtist(artist); setDrawer(null); }} drawer={drawer} onDrawer={setDrawer} />

    <AnimatePresence>{modal && <Dialog title={modalTitle} onClose={closeModal}>
      {modal.type === 'settings' && <div className="settings-content">
        <label className="form-label" htmlFor="profile-name">What should we call you?</label>
        <input className="form-input" id="profile-name" maxLength={32} value={profileName} onChange={(event) => setProfileName(event.target.value)} onBlur={() => { if (!profileName.trim()) setProfileName('Music lover'); }} />
        <div className="setting-row"><div><strong>Keep playing</strong><p>When a list ends, unheard tracks from the same Top 50 take over. Nothing repeats.</p></div><Toggle label="Settings autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div>
        <div className="setting-row"><div><strong>Full tracks and samples</strong><p>Famous label releases can only be sampled for 30 seconds without a paid licence, so those rows link to the whole song. The Full Tracks 50 streams complete songs with no limit.</p></div><button className="text-link" onClick={() => { openScene('fulltracks'); closeModal(); }}>Open it<ArrowRight size={14} /></button></div>
        <div className="settings-shortcuts"><span>Pause / play<kbd>Space</kbd></span><span>Search music<kbd>/</kbd></span></div>
        <p className="settings-source">Music streams from Audius, the open network where artists publish whole tracks. Liked songs and playlists stay in this browser.</p>
        <button className="primary-button full-width" onClick={closeModal}>Back to the music<ArrowRight size={16} /></button>
      </div>}
      {modal.type === 'create' && <form className="playlist-form" onSubmit={(event) => { event.preventDefault(); if (!playlistName.trim()) return; const playlist: UserPlaylist = { id: `playlist-${Date.now()}`, name: playlistName.trim(), description: playlistDescription.trim(), tracks: pendingTrack ? [pendingTrack] : [], createdAt: Date.now() }; setUserPlaylists((previous) => [...previous, playlist]); setPlaylistId(playlist.id); setModal(null); navigate('playlist'); notify(`${playlist.name} is ready.`); }}>
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
          <button onClick={() => { openArtist(artistFromTrack(modal.track)); setModal(null); }}><UserRound size={18} />Go to the artist<ChevronRight size={16} /></button>
          {selectedPlaylist?.tracks.some((track) => track.id === modal.track.id) && <button onClick={() => { setUserPlaylists((previous) => previous.map((playlist) => playlist.id === selectedPlaylist.id ? { ...playlist, tracks: playlist.tracks.filter((track) => track.id !== modal.track.id) } : playlist)); setModal(null); notify('Removed from this playlist.'); }}><X size={18} />Remove from this playlist<ChevronRight size={16} /></button>}
          <a href={modal.track.externalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} />Open on Audius<ArrowRight size={16} /></a>
        </div> : <div className="add-to-playlist-list">
          {userPlaylists.map((playlist) => <button key={playlist.id} onClick={() => { const exists = playlist.tracks.some((track) => trackKey(track) === trackKey(modal.track)); if (!exists) setUserPlaylists((previous) => previous.map((item) => item.id === playlist.id ? { ...item, tracks: [...item.tracks, modal.track] } : item)); setModal(null); notify(exists ? 'That track is already in this playlist.' : `Added to ${playlist.name}.`); }}><Artwork src={playlist.tracks[0]?.artwork || ''} alt="Playlist cover" className="queue-art" /><span><strong>{playlist.name}</strong><small>{playlist.tracks.length} tracks</small></span><Plus size={17} /></button>)}
          {!userPlaylists.length && <p className="small-muted">Your first playlist is one click away.</p>}
          <button className="create-from-track" onClick={() => openCreate(modal.track)}><Plus size={20} /><strong>Create a new playlist</strong><ArrowRight size={16} /></button>
        </div>}
      </>}
    </Dialog>}</AnimatePresence>

    <div className="toast-region" aria-live="polite" aria-atomic="true"><AnimatePresence>{toast && <motion.div className="toast" key={toast} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}><Check size={17} /><span>{toast}</span><button onClick={() => setToast('')} className="icon-button" aria-label="Dismiss notification"><X size={14} /></button></motion.div>}</AnimatePresence></div>
  </div></MotionConfig>;
}
