export type SceneKind = 'chart' | 'artists' | 'audius';

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  artistHandle: string;
  artistPhoto: string;
  album: string;
  artwork: string;
  duration: number;
  audioUrl: string;
  externalUrl: string;
  sceneId: string;
  plays: number;
  favorites: number;
  /** True when the stream is the whole song; false when the platform only exposes a sample. */
  fullLength: boolean;
  youtubeId?: string;
  chartPosition?: number;
  explicit?: boolean;
  releaseDate?: string;
  mood?: string;
}

export interface SceneArtist {
  name: string;
  /** Known Deezer artist id, resolved on first load when missing. */
  id?: number;
}

export interface Scene {
  id: string;
  name: string;
  short: string;
  kicker: string;
  blurb: string;
  color: string;
  kind: SceneKind;
  genreId?: number;
  artists?: SceneArtist[];
  region?: string;
}

export interface Artist {
  id: string;
  name: string;
  handle: string;
  photo: string;
  genre: string;
}

export interface UserPlaylist {
  id: string;
  name: string;
  description: string;
  tracks: Track[];
  createdAt: number;
}

export type View = 'discover' | 'charts' | 'search' | 'library' | 'liked' | 'recent' | 'playlist' | 'artist';
