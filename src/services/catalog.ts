import { sceneById, scenes, seedTracks } from '../data';
import type { Artist, Scene, Track } from '../types';

/* ---------- Deezer: the famous catalog (charts, real artists, real artwork) ---------- */

interface DeezerArtist {
  id: number;
  name: string;
  picture_big?: string;
  picture_medium?: string;
  nb_fan?: number;
}

interface DeezerTrack {
  id: number;
  title: string;
  duration: number;
  rank?: number;
  position?: number;
  link?: string;
  preview?: string;
  explicit_lyrics?: boolean;
  artist?: DeezerArtist;
  contributors?: DeezerArtist[];
  album?: { id: number; title: string; cover_big?: string; cover_medium?: string };
}

/* ---------- Audius: independent artists whose whole songs stream ---------- */

interface AudiusUser {
  id: string;
  name: string;
  handle: string;
  bio?: string | null;
  follower_count?: number;
  track_count?: number;
  profile_picture?: { '480x480'?: string; '150x150'?: string } | null;
}

interface AudiusSong {
  id: string;
  title: string;
  genre?: string | null;
  mood?: string | null;
  duration: number;
  play_count?: number;
  favorite_count?: number;
  permalink?: string;
  tags?: string | null;
  description?: string | null;
  orig_filename?: string | null;
  release_date?: string;
  created_at?: string;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  is_available?: boolean;
  is_delete?: boolean;
  allowed_api_keys?: string[] | null;
  access?: { stream?: boolean };
  artwork?: { '480x480'?: string; '150x150'?: string } | null;
  user: AudiusUser;
}

const AUDIUS = 'https://api.audius.co/v1';
const requests = new Map<string, Promise<Track[]>>();
const scenePage = new Map<string, number>();
const pending = new Map<string, Promise<Track[]>>();
const artistIds = new Map<string, number>();
let callbackNumber = 0;

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

export function trackKey(track: Track) {
  const title = track.title.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/\b(remaster(ed)?|radio edit|explicit|clean|live)\b.*$/g, '');
  return `${normalize(track.artist.split(/,| & | feat\.?/i)[0])}:${normalize(title) || track.id}`;
}

export function mergeTracks(...lists: Track[][]) {
  const keys = new Set<string>();
  return lists.flat().filter((track) => {
    const key = trackKey(track);
    if (!track.audioUrl || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function rankScore(track: Track) {
  if (track.chartPosition) return 10000 - track.chartPosition;
  return Math.log10((track.plays || 0) + 10) * 60;
}

export const rankTracks = (tracks: Track[]) => [...tracks].sort((a, b) => rankScore(b) - rankScore(a));
export const topFifty = (tracks: Track[]) => rankTracks(tracks).slice(0, 50);

export function artistFromTrack(track: Track): Artist {
  return { id: track.artistId, name: track.artist, handle: track.artistHandle, photo: track.artistPhoto, genre: track.album };
}

function jsonp<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const name = `__vibe_${++callbackNumber}`;
    const callbacks = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      done = true;
      window.clearTimeout(timeout);
      script.remove();
      callbacks[name] = () => undefined;
      window.setTimeout(() => { delete callbacks[name]; }, 60000);
    };
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The charts took too long to answer.')); }, 15000);
    callbacks[name] = (data: T) => { if (!done) { cleanup(); resolve(data); } };
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    script.onerror = () => { if (!done) { cleanup(); reject(new Error('The charts are unreachable right now.')); } };
    document.head.appendChild(script);
  });
}

async function deezer<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`/api/deezer?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      return (await res.json()) as T;
    }
  } catch (err) {
    console.warn('[Deezer] Proxy fetch failed, using fallback:', err);
  }
  return jsonp<T>(`https://api.deezer.com/${path}${path.includes('?') ? '&' : '?'}output=jsonp`);
}

function deezerTrack(raw: DeezerTrack, sceneId: string, position?: number): Track | null {
  if (!raw.id || !raw.title) return null;
  const artist = raw.artist ?? raw.contributors?.[0];
  const preview = raw.preview || `https://cdns-preview-d.dzcdn.net/stream/c-${raw.id}.mp3`;
  return {
    id: `dz:${raw.id}`, title: raw.title, artist: artist?.name ?? 'Unknown artist',
    artistId: `dz:${artist?.id ?? 0}`, artistHandle: String(artist?.id ?? ''),
    artistPhoto: artist?.picture_big ?? artist?.picture_medium ?? '',
    album: raw.album?.title ?? 'Single', artwork: raw.album?.cover_big ?? raw.album?.cover_medium ?? '',
    duration: raw.duration || 210, audioUrl: preview,
    externalUrl: raw.link ?? `https://www.deezer.com/track/${raw.id}`,
    sceneId, plays: raw.rank ?? 0, favorites: 0,
    // Every track streams its complete full-length version via YouTube playback
    fullLength: true, chartPosition: position ?? raw.position, explicit: raw.explicit_lyrics,
  };
}

const keep = (list: (Track | null)[]) => mergeTracks(list.filter((track): track is Track => track !== null));

/** Finds the real artist page so a scene never fills with namesakes. */
async function resolveArtistId(name: string) {
  const key = normalize(name);
  const known = artistIds.get(key);
  if (known) return known;
  const result = await deezer<{ data?: DeezerArtist[] }>(`search/artist?q=${encodeURIComponent(name)}&limit=8`);
  const match = (result.data ?? [])
    .filter((artist) => normalize(artist.name) === key)
    .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]
    ?? (result.data ?? []).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
  if (match) artistIds.set(key, match.id);
  return match?.id ?? null;
}

async function loadChart(scene: Scene, page: number) {
  const index = page * 50;
  const result = await deezer<{ data?: DeezerTrack[] }>(`chart/${scene.genreId ?? 0}/tracks?limit=50&index=${index}`);
  return keep((result.data ?? []).map((raw, offset) => deezerTrack(raw, scene.id, index + offset + 1)));
}

async function loadArtistScene(scene: Scene, page: number) {
  const entries = scene.artists ?? [];
  // Six artists per page keeps the first batch fast and the next ones fresh.
  const batch = entries.slice(page * 6, page * 6 + 6);
  if (!batch.length) return [];
  const ids = await Promise.all(batch.map(async (entry) => entry.id ?? await resolveArtistId(entry.name).catch(() => null)));
  const results = await Promise.allSettled(ids.filter((id): id is number => Boolean(id))
    .map((id) => deezer<{ data?: DeezerTrack[] }>(`artist/${id}/top?limit=12`)));
  const done = results.filter((result): result is PromiseFulfilledResult<{ data?: DeezerTrack[] }> => result.status === 'fulfilled');
  if (!done.length) throw new Error('The charts are unreachable right now.');
  return keep(done.flatMap((result) => (result.value.data ?? []).map((raw) => deezerTrack(raw, scene.id))));
}

/* ---------- Audius quality gate ---------- */

const JUNK = /\b(type ?beats?|beatstars?|instrumentals?|karaoke|snippet|teaser|nightcore|sped ?up|slowed|free ?beat|beat ?for ?sale|lease|no copyright|royalty[- ]free|dj ?mix|dj ?set|podcast|radio show|sample pack|drum kit|loop kit|stems?)\b|\b(trap|drill|rap|hip ?hop|r&b|melodic|hard|dark|guitar|piano|afro|uk|plugg|boom ?bap)\s+(beat|instrumental)s?\b|\|\s*prod\b|\bprod\.?\s*by\b|\bbpm\b/i;
const SELLER = /\b(i make beats|making beats|purchase licens|buy.{0,14}beat|beats? for (sale|lease)|leasing|exclusive rights|custom beats|beatstars)\b/i;

function audiusTrack(song: AudiusSong, sceneId: string): Track | null {
  if (!song.is_streamable || song.is_delete || song.is_stream_gated) return null;
  if (song.is_available === false || song.access?.stream === false || song.allowed_api_keys?.length) return null;
  if (song.duration < 100 || song.duration > 900) return null;
  if (JUNK.test(`${song.title} ${song.tags ?? ''} ${song.description ?? ''} ${song.orig_filename ?? ''}`)) return null;
  if (SELLER.test(song.user.bio ?? '')) return null;
  const released = song.release_date || song.created_at || '';
  const year = released.slice(0, 4);
  return {
    id: `audius:${song.id}`, title: song.title.replace(/\s+/g, ' ').trim(),
    artist: song.user.name || song.user.handle, artistId: `handle:${song.user.handle.toLowerCase()}`,
    artistHandle: song.user.handle, artistPhoto: song.user.profile_picture?.['480x480'] ?? '',
    album: `${song.genre || 'Independent'}${year ? ` · ${year}` : ''}`,
    artwork: song.artwork?.['480x480'] ?? song.artwork?.['150x150'] ?? '',
    duration: song.duration, audioUrl: `${AUDIUS}/tracks/${song.id}/stream?app_name=Vibe`,
    externalUrl: `https://audius.co${song.permalink ?? `/${song.user.handle}`}`,
    sceneId, plays: song.play_count ?? 0, favorites: song.favorite_count ?? 0,
    fullLength: true, releaseDate: released, mood: song.mood ?? undefined,
  };
}

async function audius<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${AUDIUS}/${path}${path.includes('?') ? '&' : '?'}app_name=Vibe`, { signal: controller.signal });
    if (!response.ok) throw new Error('Full-track streaming is busy. Try again shortly.');
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadFullTracks(page: number) {
  const windows = ['week', 'month', 'year'] as const;
  const time = windows[Math.min(page, windows.length - 1)];
  const offset = page >= windows.length ? (page - windows.length + 1) * 50 : 0;
  const payload = await audius<{ data?: AudiusSong[] }>(`tracks/trending?time=${time}&limit=50&offset=${offset}`);
  return keep((payload.data ?? []).map((song) => audiusTrack(song, 'fulltracks')));
}

export function loadScene(sceneId: string, page = 0): Promise<Track[]> {
  const scene = sceneById(sceneId);
  if (!scene) return Promise.resolve([]);
  const key = `${sceneId}:${page}`;
  const cached = requests.get(key);
  if (cached) return cached;
  const request = (scene.kind === 'chart' ? loadChart(scene, page) : scene.kind === 'artists' ? loadArtistScene(scene, page) : loadFullTracks(page))
    .then((tracks) => { scenePage.set(sceneId, Math.max(scenePage.get(sceneId) ?? 0, page + 1)); return tracks; });
  requests.set(key, request);
  request.catch(() => requests.delete(key));
  return request;
}

/** Autoplay and the next-batch button both walk forward, so nothing repeats. */
export function loadMoreScene(sceneId: string): Promise<Track[]> {
  const inFlight = pending.get(sceneId);
  if (inFlight) return inFlight;
  const request = loadScene(sceneId, scenePage.get(sceneId) ?? 0).finally(() => pending.delete(sceneId));
  pending.set(sceneId, request);
  return request;
}

export function searchSongs(query: string): Promise<Track[]> {
  const key = `search:${query}`;
  const cached = requests.get(key);
  if (cached) return cached;
  const request = Promise.allSettled([
    deezer<{ data?: DeezerTrack[] }>(`search?q=${encodeURIComponent(query)}&limit=50`).then((result) => keep((result.data ?? []).map((raw) => deezerTrack(raw, 'search')))),
    audius<{ data?: AudiusSong[] }>(`tracks/search?query=${encodeURIComponent(query)}&limit=20`).then((payload) => keep((payload.data ?? []).map((song) => audiusTrack(song, 'search')))),
  ]).then((results) => {
    const done = results.filter((result): result is PromiseFulfilledResult<Track[]> => result.status === 'fulfilled');
    if (!done.length) throw new Error('Cannot reach the catalog. Check your connection and try again.');
    // Complete streams first, then the famous chart entries.
    return mergeTracks(...done.map((result) => result.value)).sort((a, b) => Number(b.fullLength) - Number(a.fullLength));
  });
  requests.set(key, request);
  request.catch(() => requests.delete(key));
  return request;
}

export async function searchArtists(query: string): Promise<Artist[]> {
  const result = await deezer<{ data?: DeezerArtist[] }>(`search/artist?q=${encodeURIComponent(query)}&limit=10`);
  return (result.data ?? []).filter((artist) => artist.picture_big && !artist.picture_big.includes('/artist//')).map((artist) => ({
    id: `dz:${artist.id}`, name: artist.name, handle: String(artist.id),
    photo: artist.picture_big ?? '', genre: artist.nb_fan ? `${Math.round(artist.nb_fan / 1000)}k fans` : 'Artist',
  }));
}

export async function artistTracks(artist: Artist): Promise<Track[]> {
  const key = `artist:${artist.id}`;
  const cached = requests.get(key);
  if (cached) return cached;
  const numeric = Number(artist.id.replace('dz:', ''));
  const request = Number.isFinite(numeric) && numeric > 0
    ? deezer<{ data?: DeezerTrack[] }>(`artist/${numeric}/top?limit=50`).then((result) => keep((result.data ?? []).map((raw) => deezerTrack(raw, artist.id))))
    : audius<{ data?: AudiusUser }>(`users/handle/${encodeURIComponent(artist.handle)}`)
      .then((payload) => payload.data?.id)
      .then((id) => id ? audius<{ data?: AudiusSong[] }>(`users/${id}/tracks?limit=50&sort=plays`).then((payload) => keep((payload.data ?? []).map((song) => audiusTrack(song, artist.id)))) : []);
  requests.set(key, request);
  request.catch(() => requests.delete(key));
  return request;
}

export function readInitialCatalog(): Track[] {
  try {
    const stored = JSON.parse(localStorage.getItem('vibe.catalog') || 'null') as { time: number; tracks: Track[] } | null;
    if (stored && Date.now() - stored.time < 3 * 3600000 && Array.isArray(stored.tracks)) {
      const usable = stored.tracks.filter((track) => typeof track?.id === 'string' && typeof track.audioUrl === 'string' && track.audioUrl.startsWith('https://') && typeof track.sceneId === 'string' && typeof track.fullLength === 'boolean');
      return mergeTracks(seedTracks, usable.slice(0, 1500));
    }
  } catch { /* Storage is optional, including in private browsing. */ }
  return seedTracks;
}

export function saveCatalog(tracks: Track[]) {
  try { localStorage.setItem('vibe.catalog', JSON.stringify({ time: Date.now(), tracks: tracks.slice(0, 1200) })); }
  catch { /* Listening never depends on the cache. */ }
}

export function randomOrder<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const next = Math.floor(Math.random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

/**
 * Daily auto-update: Checks date rollover.
 * When a new day starts, it invalidates cached requests and refreshes the playlists.
 */
export async function checkDailyPlaylistUpdate(force = false): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const lastSync = localStorage.getItem('vibe.last_daily_sync');
  if (!force && lastSync === today) {
    return false;
  }

  try {
    requests.clear();
    pending.clear();
    localStorage.removeItem('vibe.catalog');
    localStorage.setItem('vibe.last_daily_sync', today);
    localStorage.setItem('vibe.daily_sync_time', Date.now().toString());
    return true;
  } catch (err) {
    console.warn('[Daily Update] Error during check:', err);
    return false;
  }
}

export function getDailySyncInfo() {
  const today = new Date().toISOString().slice(0, 10);
  const lastSync = localStorage.getItem('vibe.last_daily_sync');
  return {
    today,
    isUpdatedToday: lastSync === today,
  };
}

export { scenes };
