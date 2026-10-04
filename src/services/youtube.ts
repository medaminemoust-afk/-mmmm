interface YouTubeResult {
  videoId: string;
  title: string;
  duration?: number;
  thumbnail?: string;
}

const memoryCache = new Map<string, YouTubeResult>();
const pendingResolves = new Map<string, Promise<YouTubeResult | null>>();

function getCacheKey(artist: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
  return `${norm(artist)}:::${norm(title)}`;
}

// Load persisted cache on startup
try {
  const stored = localStorage.getItem('vibe.yt_cache');
  if (stored) {
    const parsed = JSON.parse(stored) as Record<string, YouTubeResult>;
    Object.entries(parsed).forEach(([k, v]) => memoryCache.set(k, v));
  }
} catch {
  // Ignore local storage errors
}

function persistCache() {
  try {
    const obj: Record<string, YouTubeResult> = {};
    let count = 0;
    for (const [k, v] of memoryCache.entries()) {
      if (count++ > 500) break;
      obj[k] = v;
    }
    localStorage.setItem('vibe.yt_cache', JSON.stringify(obj));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Resolves a full-length YouTube video for an artist and title.
 */
export async function resolveYouTubeTrack(artist: string, title: string): Promise<YouTubeResult | null> {
  const key = getCacheKey(artist, title);
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const inFlight = pendingResolves.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const url = `/api/youtube/track?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as YouTubeResult;
      if (data?.videoId) {
        memoryCache.set(key, data);
        persistCache();
        return data;
      }
      return null;
    } catch (err) {
      console.warn('[YouTube resolver] Error resolving track:', err);
      return null;
    } finally {
      pendingResolves.delete(key);
    }
  })();

  pendingResolves.set(key, promise);
  return promise;
}

/**
 * Pre-resolves upcoming tracks in the background.
 */
export function prefetchYouTubeTracks(tracks: Array<{ artist: string; title: string }>) {
  tracks.slice(0, 10).forEach((track) => {
    void resolveYouTubeTrack(track.artist, track.title);
  });
}

/**
 * Loads the YouTube IFrame API script once.
 */
let ytApiPromise: Promise<void> | null = null;

export function ensureYouTubeIframeAPI(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as unknown as { YT?: { Player: unknown } }).YT?.Player) {
    return Promise.resolve();
  }

  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    }

    const previousOnReady = (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady;
    (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = () => {
      if (previousOnReady) previousOnReady();
      resolve();
    };

    // Backup check in case script was already loaded
    const checkInterval = setInterval(() => {
      if ((window as unknown as { YT?: { Player: unknown } }).YT?.Player) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 150);

    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 10000);
  });

  return ytApiPromise;
}
