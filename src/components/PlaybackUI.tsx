import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, ChevronRight, ExternalLink, Heart, Infinity as InfinityIcon, ListMusic, LoaderCircle, Music2, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react';
import { Artwork, Chip, Equalizer, Toggle } from './MusicUI';
import { formatTime, sceneById } from '../data';
import { trackKey } from '../services/catalog';
import type { MusicPlayer } from '../hooks/useMusicPlayer';
import type { Artist, Track } from '../types';

type Drawer = 'queue' | 'playing' | null;

interface SharedProps {
  player: MusicPlayer;
  liked: Track[];
  onLike: (track: Track) => void;
  drawer: Drawer;
  onDrawer: (drawer: Drawer) => void;
}

export function PlayerBar({ player, liked, onLike, onArtist, drawer, onDrawer }: SharedProps & { onArtist: (track: Track) => void }) {
  const currentLiked = liked.some((track) => trackKey(track) === trackKey(player.current));
  const scene = sceneById(player.sceneId);
  return <section className="player-bar" style={{ '--scene': scene?.color ?? '#f6b93b' } as CSSProperties} aria-label="Music player">
    <div className="player-track">
      <button className="player-cover-button" onClick={() => onDrawer(drawer === 'playing' ? null : 'playing')} aria-label="Open now playing"><Artwork src={player.current.artwork} alt={`${player.current.album} cover`} className="player-cover" eager /></button>
      <div className="player-track-names">
        <button className="player-song-title" onClick={() => onDrawer('playing')}>{player.current.title}</button>
        <div className="player-track-subtitle"><button onClick={() => onArtist(player.current)}>{player.current.artist}</button><Chip track={player.current} /></div>
      </div>
      <button className={`icon-button player-heart ${currentLiked ? 'liked' : ''}`} onClick={() => onLike(player.current)} aria-label={currentLiked ? 'Remove current track from favorites' : 'Like current track'} aria-pressed={currentLiked}><Heart size={18} fill={currentLiked ? 'currentColor' : 'none'} /></button>
    </div>
    <div className="player-center">
      <div className="playback-controls">
        <button className={`icon-button secondary-control ${player.shuffle ? 'active-icon' : ''}`} onClick={player.toggleShuffle} aria-label="Shuffle what is next" aria-pressed={player.shuffle}><Shuffle size={17} /></button>
        <button className="icon-button" onClick={player.previous} aria-label="Previous track"><SkipBack size={18} fill="currentColor" /></button>
        <motion.button className="main-play-button" onClick={player.toggle} whileTap={{ scale: 0.9 }} aria-label={player.isPlaying ? 'Pause music' : 'Play music'}>{player.isLoading ? <LoaderCircle className="spin" size={20} /> : player.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</motion.button>
        <button className="icon-button" onClick={() => { void player.next(); }} aria-label="Next track"><SkipForward size={18} fill="currentColor" /></button>
        <button className={`icon-button secondary-control ${player.autoplay ? 'active-icon' : ''}`} onClick={() => player.setAutoplay(!player.autoplay)} aria-label="Keep playing unheard tracks from the same Top 50" aria-pressed={player.autoplay}><InfinityIcon size={20} /></button>
      </div>
      <div className="player-progress"><span>{formatTime(player.time)}</span><input type="range" className="range-input progress-range" min="0" max={player.duration || 30} step="0.1" value={Math.min(player.time, player.duration)} onChange={(event) => player.seek(Number(event.target.value))} aria-label="Seek in current track" style={{ '--range-fill': `${player.duration ? player.time / player.duration * 100 : 0}%` } as CSSProperties} /><span>{formatTime(player.duration)}</span></div>
    </div>
    <div className="player-right">
      <span className="player-audio-label"><AudioLines size={16} /><span>{player.activeSource === 'youtube' ? 'Full track · YouTube HQ' : player.isRadio ? 'Still going, new tracks' : scene?.short ?? 'Now playing'}</span></span>
      <button className={`icon-button queue-button ${drawer === 'queue' ? 'active-icon' : ''}`} onClick={() => onDrawer(drawer === 'queue' ? null : 'queue')} aria-label="Open playback queue" aria-expanded={drawer === 'queue'}><ListMusic size={20} /></button>
      <div className="volume-control"><button className="icon-button" onClick={player.toggleMute} aria-label={player.volume === 0 ? 'Unmute audio' : 'Mute audio'}>{player.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><input className="range-input volume-range" type="range" min="0" max="100" value={player.volume} onChange={(event) => player.setVolume(Number(event.target.value))} aria-label="Volume" style={{ '--range-fill': `${player.volume}%` } as CSSProperties} /></div>
    </div>
  </section>;
}

export function PlaybackDrawer({ player, liked, onLike, artist, onArtist, drawer, onDrawer }: SharedProps & { artist: Artist; onArtist: (artist: Artist) => void }) {
  const currentLiked = liked.some((track) => trackKey(track) === trackKey(player.current));
  const scene = sceneById(player.sceneId);
  return <AnimatePresence>{drawer && <>
    <motion.button className="drawer-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => onDrawer(null)} aria-label="Close playback panel" />
    <motion.aside className="queue-drawer" style={{ '--scene': scene?.color ?? '#f6b93b' } as CSSProperties} initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 34 }} aria-label={drawer === 'queue' ? 'Playback queue' : 'Now playing'}>
      <div className="drawer-heading">
        <div className="drawer-tabs"><button className={drawer === 'queue' ? 'selected-tab' : ''} onClick={() => onDrawer('queue')}>Queue</button><button className={drawer === 'playing' ? 'selected-tab' : ''} onClick={() => onDrawer('playing')}>Now playing</button></div>
        <button className="icon-button" onClick={() => onDrawer(null)} aria-label="Close playback panel"><X size={19} /></button>
      </div>
      {drawer === 'playing' ? <div className="now-playing-panel">
        <p className="eyebrow">{player.isRadio ? 'STILL THE SAME SCENE, NEW TRACKS' : 'PLAYING FROM'}</p>
        <p className="now-playing-context">{player.label}</p>
        <Artwork src={player.current.artwork} alt={`${player.current.album} cover`} className="now-playing-art" eager />
        <div className="now-playing-title"><h2>{player.current.title}</h2><button className={`icon-button ${currentLiked ? 'liked' : ''}`} onClick={() => onLike(player.current)} aria-label="Like current track"><Heart size={22} fill={currentLiked ? 'currentColor' : 'none'} /></button></div>
        <button className="now-playing-artist" onClick={() => onArtist(artist)}><Artwork src={artist.photo || player.current.artwork} alt={`${player.current.artist}`} className="now-artist-photo" portrait /><span>{player.current.artist}<small>Open the artist</small></span><ChevronRight size={17} /></button>
        <p className="source-explanation">
          The complete full-length track, {formatTime(player.duration)} long, streaming in high-fidelity full audio.
        </p>
        <div style={{ display: 'flex', gap: '8px', width: '100%', marginTop: '6px' }}>
          <a
            className="outline-button provider-link"
            style={{ width: '100%', minHeight: '40px', padding: '0 14px', justifyContent: 'center' }}
            href={player.current.youtubeId ? `https://www.youtube.com/watch?v=${player.current.youtubeId}` : player.current.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Music2 size={15} color="#f6b93b" />
            Listen on YouTube
            <ExternalLink size={13} />
          </a>
        </div>
      </div> : <>
        <div className="queue-now"><span className="eyebrow">NOW PLAYING</span><div className="queued-track"><Artwork src={player.current.artwork} alt="Current cover" className="queue-art" /><span><strong>{player.current.title}</strong><small>{player.current.artist}</small></span><Equalizer playing={player.isPlaying} /></div></div>
        <div className="queue-up-next">
          <div className="queue-subheading"><h3>Up next</h3><span>{player.isRadio ? `${player.label} · unheard` : player.label}</span></div>
          {player.queue.slice(player.index + 1).length ? player.queue.slice(player.index + 1, player.index + 18).map((track, position) => <div className="queued-track upcoming-track" key={`${track.id}-${position}`}>
            <button className="queued-play" onClick={() => player.playQueued(player.index + position + 1)} aria-label={`Play ${track.title}`}><Artwork src={track.artwork} alt={`${track.album} cover`} className="queue-art" /><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>
            <button className="icon-button remove-queued" aria-label={`Remove ${track.title} from the queue`} onClick={() => player.removeQueued(player.index + position + 1)}><X size={14} /></button>
          </div>) : <p className="queue-empty">{player.autoplay ? 'More unheard tracks from this chart arrive the moment this one ends.' : 'Last track in the queue.'}</p>}
        </div>
      </>}
      <div className="drawer-autoplay"><div><InfinityIcon size={22} /><span><strong>Never replay the same list</strong><small>Unheard tracks from the same Top 50 keep coming.</small></span><Toggle label="Queue autoplay" enabled={player.autoplay} onChange={player.setAutoplay} /></div></div>
    </motion.aside>
  </>}</AnimatePresence>;
}
