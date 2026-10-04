import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CachedVideo {
  videoId: string;
  title: string;
  duration?: number;
  thumbnail?: string;
  timestamp: number;
}

const searchCache = new Map<string, CachedVideo>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Searches YouTube using Google YouTube Data API v3 if an API key is provided,
 * or fallback to YouTube web search parsing.
 */
async function searchYouTube(query: string): Promise<CachedVideo | null> {
  const cleanQuery = query.trim().toLowerCase();
  const cached = searchCache.get(cleanQuery);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;

  // 1. Try official YouTube Data API v3 if key exists
  if (apiKey) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=3&q=${encodeURIComponent(query)}&key=${apiKey}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const item = data.items?.[0];
        if (item?.id?.videoId) {
          const result: CachedVideo = {
            videoId: item.id.videoId,
            title: item.snippet?.title || query,
            thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url,
            timestamp: Date.now(),
          };
          searchCache.set(cleanQuery, result);
          return result;
        }
      }
    } catch (err) {
      console.warn('[YouTube API v3] Error fetching from official API, falling back to direct search:', err);
    }
  }

  // 2. Direct web search parser
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const text = await res.text();

    let videoId: string | null = null;
    let title: string | null = null;
    let duration: number | undefined;
    let thumbnail: string | undefined;

    // Parse ytInitialData for rich metadata
    const initialDataMatch = text.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (initialDataMatch) {
      try {
        const data = JSON.parse(initialDataMatch[1]);
        const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        if (Array.isArray(contents)) {
          for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents;
            if (Array.isArray(items)) {
              for (const item of items) {
                const vr = item?.videoRenderer;
                if (vr && vr.videoId) {
                  videoId = vr.videoId;
                  title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || null;
                  thumbnail = vr.thumbnail?.thumbnails?.slice(-1)[0]?.url;
                  const lengthText = vr.lengthText?.simpleText;
                  if (lengthText) {
                    const parts = lengthText.split(':').map(Number);
                    duration = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
                  }
                  break;
                }
              }
            }
            if (videoId) break;
          }
        }
      } catch {
        // Fallback to regex
      }
    }

    // Fallback regex matching
    if (!videoId) {
      const match = text.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (match) videoId = match[1];
    }

    if (videoId) {
      const result: CachedVideo = {
        videoId,
        title: title || query,
        duration,
        thumbnail,
        timestamp: Date.now(),
      };
      searchCache.set(cleanQuery, result);
      return result;
    }
  } catch (err) {
    console.error('[YouTube Search] Failed to query YouTube:', err);
  }

  return null;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'vibe-backend', cachedSongs: searchCache.size });
  });

  // YouTube search for full track
  app.get('/api/youtube/track', async (req: Request, res: Response) => {
    const artist = (req.query.artist as string) || '';
    const title = (req.query.title as string) || '';

    if (!artist && !title) {
      return res.status(400).json({ error: 'Missing artist or title parameter' });
    }

    const query = `${artist} - ${title} official audio`;
    const video = await searchYouTube(query);

    if (!video) {
      // Retry with just artist and title
      const fallbackVideo = await searchYouTube(`${artist} ${title}`);
      if (fallbackVideo) {
        return res.json(fallbackVideo);
      }
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(video);
  });

  // General YouTube search
  app.get('/api/youtube/search', async (req: Request, res: Response) => {
    const q = (req.query.q as string) || '';
    if (!q) {
      return res.status(400).json({ error: 'Missing q query parameter' });
    }

    const video = await searchYouTube(q);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(video);
  });

  // Deezer API proxy to avoid JSONP cross-origin script errors
  app.get('/api/deezer', async (req: Request, res: Response) => {
    const apiPath = (req.query.path as string) || '';
    if (!apiPath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }

    try {
      const url = `https://api.deezer.com/${apiPath}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: 'Upstream Deezer error' });
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.warn('[Deezer Proxy] Error fetching from Deezer:', err);
      res.status(502).json({ error: 'Failed to proxy Deezer request' });
    }
  });

  if (isProd) {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`vibe server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
