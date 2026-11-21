import { invokeNative, hasMethod, nativeStreamUrl } from './nativeBridge';
import { resolveYouTubeTrack } from './youtube';
import type { Track } from '../types';

/**
 * Music saved on the phone.
 *
 * YouTube audio cannot be downloaded from a web page (no CORS on googlevideo), so the Android
 * shell does it: it writes the whole song to the app's private storage and serves it back at
 * /dl/<file>. Playback then reads that local file, which is why a saved song works in airplane
 * mode and why nothing else about the app has to change.
 */

export interface OfflineTrack {
  key: string;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  duration: number;
  bytes: number;
  mime: string;
  file: string;
  savedAt: number;
}

const STORAGE_KEY = 'vibe.offline';
/**
 * Served by the shell: OfflineStore.java inside the APK, LocalServer.swift inside the iOS app.
 * Android answers on appassets; iOS answers on its own loopback origin.
 */
const PLATFORM = (globalThis as { __vibePlatform?: string }).__vibePlatform;
export const OFFLINE_ORIGIN = PLATFORM === 'ios'
  ? `${window.location.origin}/dl/`
  : 'https://appassets.androidplatform.net/dl/';

let entries: OfflineTrack[] = read();
const broken = new Set<string>();

function read(): OfflineTrack[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflineTrack[];
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.key && entry.file) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // The phone's own index is the source of truth; this copy only pre-fills the UI.
  }
}

/** Stable across app updates: artist + title, hashed. */
export function offlineKey(track: Track): string {
  const raw = `${track.artist}`.toLowerCase().trim() + '|' + `${track.title}`.toLowerCase().trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t${hash.toString(36)}`;
}

export function hasOfflineStorage(): boolean {
  return hasMethod('downloadSong') && hasMethod('listDownloads');
}

export function listDownloads(): OfflineTrack[] {
  return entries;
}

export function offlineEntry(track: Track): OfflineTrack | undefined {
  const key = offlineKey(track);
  return entries.find((entry) => entry.key === key);
}

export function isDownloaded(track: Track): boolean {
  return Boolean(offlineEntry(track));
}

/** The local URL for a saved song, or null when it has to come from the network. */
export function offlineSrc(track: Track): string | null {
  const key = offlineKey(track);
  if (broken.has(key)) return null;
  const entry = entries.find((item) => item.key === key);
  return entry ? `${OFFLINE_ORIGIN}${entry.file}` : null;
}

/** A saved file that will not play is dropped, so the next attempt streams instead. */
export function markOfflineBroken(track: Track) {
  broken.add(offlineKey(track));
  void removeDownload(track);
}

export function totalSavedBytes(): number {
  return entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function merge(next: OfflineTrack[]): OfflineTrack[] {
  entries = [...next].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  persist();
  return entries;
}

/** Re-reads the phone's index. Called on start-up and after every change. */
export async function loadDownloads(): Promise<OfflineTrack[]> {
  if (!hasOfflineStorage()) return entries;
  const raw = await invokeNative('listDownloads', [], 20000);
  if (!raw) return entries;
  try {
    const parsed = JSON.parse(raw) as OfflineTrack[];
    if (!Array.isArray(parsed)) return entries;
    broken.clear();
    return merge(parsed.filter((entry) => entry && entry.key && entry.file));
  } catch {
    return entries;
  }
}

export interface DownloadResult {
  ok: boolean;
  message: string;
}

/** Saves the whole song on the phone. */
export async function downloadTrack(track: Track): Promise<DownloadResult> {
  if (!hasOfflineStorage()) {
    return { ok: false, message: 'Offline music works in the vibe app on your phone.' };
  }
  const key = offlineKey(track);
  if (entries.some((entry) => entry.key === key)) return { ok: true, message: 'Already saved on this phone.' };

  try {
    let videoId = track.youtubeId;
    if (!videoId) {
      const found = await resolveYouTubeTrack(track.artist, track.title, track.duration);
      videoId = found?.videoId;
    }
    if (!videoId) return { ok: false, message: 'No full track was found for this song.' };

    const stream = await nativeStreamUrl(videoId);
    if (!stream.value) {
      return { ok: false, message: `Could not fetch the audio (${stream.error ?? 'no stream'}).` };
    }

    const meta = JSON.stringify({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.artwork,
      duration: track.duration || 0,
      videoId,
    });
    const raw = await invokeNative('downloadSong', [stream.value, key, meta], 180000);
    if (!raw) return { ok: false, message: 'The download did not answer. Check your connection.' };

    const parsed = JSON.parse(raw) as {
      ok?: boolean; key?: string; file?: string; mime?: string; bytes?: number; error?: string;
    };
    if (!parsed.ok || !parsed.file) {
      return { ok: false, message: parsed.error ?? 'The download failed.' };
    }

    entries = [...entries.filter((entry) => entry.key !== key), {
      key,
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.artwork,
      duration: track.duration || 0,
      bytes: parsed.bytes ?? 0,
      mime: parsed.mime ?? 'audio/mp4',
      file: parsed.file,
      savedAt: Date.now(),
    }];
    broken.delete(key);
    persist();
    return { ok: true, message: `Saved for offline · ${formatBytes(parsed.bytes ?? 0)}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The download failed.' };
  }
}

export async function removeDownload(track: Track): Promise<boolean> {
  const key = offlineKey(track);
  entries = entries.filter((entry) => entry.key !== key);
  persist();
  if (!hasOfflineStorage()) return true;
  const raw = await invokeNative('removeDownload', [key], 20000);
  return Boolean(raw);
}

// Fill the local cache as soon as the shell is there, so the first tap already knows
// which songs are on the phone.
if (typeof window !== 'undefined' && hasOfflineStorage()) void loadDownloads();
