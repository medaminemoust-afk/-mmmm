/**
 * The Android shell resolves YouTube itself (InnerTube, on the phone's own IP), because the
 * browser cannot: youtubei has no CORS headers. This is the same approach NewPipe/InnerTune use.
 *
 * It also stores music on the phone (OfflineStore.java) — one generic invoke() covers every
 * bridge method, so adding one on the Java side needs no new plumbing here.
 */

type NativeResolver = (value: string | null) => void;

const pending = new Map<number, NativeResolver>();
let nextId = 1;

declare global {
  interface Window {
    __vibeNativeCb?: (id: number, value: string | null) => void;
    /** 'ios' when the page runs inside the WKWebView shell. */
    __vibePlatform?: string;
  }
}

if (typeof window !== 'undefined') {
  window.__vibeNativeCb = (id, value) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(value ?? null);
  };
}

export interface NativeResolution {
  /** The audio URL (stream) or video id (search), when the phone found one. */
  value: string | null;
  /** Why it failed, straight from the device, for the diagnostics panel. */
  error: string | null;
  /** Which InnerTube client answered. */
  client?: string;
}

export function hasMethod(name: 'searchYouTube' | 'resolveStream' | 'downloadSong' | 'listDownloads' | 'removeDownload'): boolean {
  return typeof window !== 'undefined'
    && typeof (window.VibeNative as Record<string, unknown> | undefined)?.[name] === 'function';
}

export function hasNativeYouTube(): boolean {
  return hasMethod('searchYouTube') && hasMethod('resolveStream');
}

/** Calls a method on the Java bridge and waits for its JSON answer. */
export function invokeNative(method: string, args: Array<string | number>, timeout = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      resolve(value);
    };
    pending.set(id, finish);
    setTimeout(() => finish(null), timeout);
    try {
      const bridge = window.VibeNative as unknown as Record<string, (...params: unknown[]) => void> | undefined;
      if (!bridge || typeof bridge[method] !== 'function') {
        finish(null);
        return;
      }
      // Called on the bridge object itself: an @JavascriptInterface method invoked detached
      // from its receiver can throw "Illegal invocation" and the call would be lost.
      bridge[method](...args, id);
    } catch {
      finish(null);
    }
  });
}

function parse(raw: string | null, field: 'videoId' | 'url'): NativeResolution {
  if (!raw) return { value: null, error: 'the device did not answer' };
  try {
    const data = JSON.parse(raw) as { videoId?: string; url?: string; error?: string; client?: string };
    const value = field === 'videoId' ? data.videoId ?? null : data.url ?? null;
    return { value, error: value ? null : data.error ?? 'no result from YouTube', client: data.client };
  } catch {
    return { value: raw, error: null };
  }
}

/** Finds the YouTube video id for a song, on the device. */
export async function nativeSearchVideoId(artist: string, title: string, durationSeconds?: number): Promise<NativeResolution> {
  // Only the iOS shell ranks results against the song's real length; the Android bridge takes
  // exactly (artist, title, callbackId), so it must keep getting two arguments.
  const wantsLength = typeof window !== 'undefined' && window.__vibePlatform === 'ios';
  const args: Array<string | number> = wantsLength && durationSeconds && durationSeconds > 0
    ? [artist, title, String(Math.round(durationSeconds))]
    : [artist, title];
  return parse(await invokeNative('searchYouTube', args), 'videoId');
}

/** Returns a direct audio URL for a video id, extracted on the device. */
export async function nativeStreamUrl(videoId: string): Promise<NativeResolution> {
  return parse(await invokeNative('resolveStream', [videoId]), 'url');
}
