import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Clock3, Flame, Heart, LoaderCircle, MoreHorizontal, Music2, Play, UserRound, X } from 'lucide-react';
import { formatTime } from '../data';
import { trackKey } from '../services/catalog';
import type { MusicPlayer } from '../hooks/useMusicPlayer';
import type { Scene, Track } from '../types';

export function Artwork({ src, alt, className = '', portrait = false, eager = false }: { src: string; alt: string; className?: string; portrait?: boolean; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`artwork ${className} ${portrait ? 'portrait' : ''}`}>
    {src && !failed ? <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="artwork-fallback">{portrait ? <UserRound aria-hidden="true" /> : <Music2 aria-hidden="true" />}</span>}
  </span>;
}

export function Equalizer({ playing = true }: { playing?: boolean }) {
  return <span className={`equalizer ${playing ? 'playing' : ''}`} aria-label={playing ? 'Playing' : 'Paused'}><i /><i /><i /><i /></span>;
}

export function Toggle({ enabled, onChange, label }: { enabled: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className={`toggle ${enabled ? 'enabled' : ''}`} role="switch" aria-checked={enabled} aria-label={label} onClick={() => onChange(!enabled)}><span /></button>;
}

/** States plainly whether you get the whole song or the label's sample. */
export function Chip({ track }: { track: Track }) {
  if (track.fullLength) return <span className="chip chip-full">FULL · {formatTime(track.duration)}</span>;
  return <span className="chip chip-preview">SAMPLE 30s</span>;
}

export function SectionHeading({ title, kicker, children }: { title: string; kicker?: string; children?: ReactNode }) {
  return <div className="section-heading">
    <div className="section-heading-text">{kicker && <span className="eyebrow">{kicker}</span>}<h2>{title}</h2></div>
    {children}
  </div>;
}

export function EmptyState({ icon, title, description, action, onAction }: { icon?: ReactNode; title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state">
    <div className="empty-icon">{icon || <Music2 size={32} strokeWidth={1.4} />}</div>
    <h2>{title}</h2><p>{description}</p>
    {action && <button className="primary-button" onClick={onAction}>{action}<ArrowRight size={16} /></button>}
  </div>;
}

/** One scene = one Top 50. The tile carries the scene colour so the rail reads at a glance. */
export function SceneCard({ scene, index, busy, count, onOpen, onPlay }: { scene: Scene; index: number; busy?: boolean; count?: number; onOpen: () => void; onPlay: () => void }) {
  return <motion.button className="scene-card" style={{ '--scene': scene.color } as CSSProperties} onClick={onOpen} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.36, delay: Math.min(index * 0.035, 0.4) }}>
    <span className="scene-card-rank">50</span>
    <span className="scene-card-copy"><span className="eyebrow">{scene.kicker}</span><strong>{scene.name}</strong><small>{scene.region ? `Only ${scene.region}.` : scene.short} · {count ? `${count} loaded` : 'Top tracks'}</small></span>
    <span className="scene-card-play" role="presentation" onClick={(event) => { event.stopPropagation(); onPlay(); }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Play size={16} fill="currentColor" />}</span>
  </motion.button>;
}

/** Editorial masthead: the scene name at display size on a bone slab, with the chart facts. */
export function SceneMasthead({ scene, count, loading, playing, onPlay, onRefresh }: { scene: Scene; count: number; loading: boolean; playing: boolean; onPlay: () => void; onRefresh: () => void }) {
  return <motion.section className="masthead" style={{ '--scene': scene.color } as CSSProperties} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
    <div className="masthead-slab">
      <span className="masthead-fifty" aria-hidden="true">50</span>
      <div className="masthead-copy">
        <span className="eyebrow"><Flame size={13} />{scene.kicker}</span>
        <h2>{scene.name}</h2>
        <p>{scene.blurb}</p>
        <div className="masthead-facts">
          <span>{count ? `${count} tracks ranked` : 'Loading the chart'}</span>
          <span className="fact-dot" />
          <span>{scene.kind === 'chart' ? 'Official chart order' : scene.kind === 'artists' ? 'Biggest tracks first' : 'Complete streams'}</span>
          {scene.region && <><span className="fact-dot" /><span>Only {scene.region}</span></>}
        </div>
        <div className="masthead-actions">
          <button className="primary-button" disabled={!count || loading} onClick={onPlay}>{playing ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{playing ? 'Playing' : 'Play the Top 50'}</button>
          <button className="outline-button" onClick={onRefresh} disabled={loading}>{loading ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}Pull the next batch</button>
        </div>
      </div>
    </div>
    <div className="masthead-edge" aria-hidden="true" />
  </motion.section>;
}

export function Marquee({ items, color }: { items: string[]; color: string }) {
  if (!items.length) return null;
  const line = [...items, ...items];
  return <div className="marquee" style={{ '--scene': color } as CSSProperties} aria-label="Current top tracks">
    <div className="marquee-track">{line.map((item, position) => <span key={`${item}-${position}`}>{item}<i aria-hidden="true">✦</i></span>)}</div>
  </div>;
}

interface ChartTableProps {
  tracks: Track[];
  player: MusicPlayer;
  liked: Track[];
  onLike: (track: Track) => void;
  onArtist: (track: Track) => void;
  onMore: (track: Track) => void;
  label: string;
  sceneColor?: string;
  ranked?: boolean;
  compact?: boolean;
}

export function ChartTable({ tracks, player, liked, onLike, onArtist, onMore, label, sceneColor = '#f6b93b', ranked = false, compact = false }: ChartTableProps) {
  const likedKeys = new Set(liked.map(trackKey));
  return <div className={`chart-table ${compact ? 'compact' : ''} ${ranked ? 'ranked' : ''}`} style={{ '--scene': sceneColor } as CSSProperties} role="table" aria-label={label}>
    <div className="chart-table-head" role="row">
      <span role="columnheader">{ranked ? 'RANK' : '#'}</span>
      <span role="columnheader">TITLE</span>
      <span className="album-column" role="columnheader">RELEASE</span>
      <span className="time-heading" role="columnheader"><Clock3 size={14} aria-label="Duration" /></span>
      <span role="columnheader" className="sr-only">Length</span><span /><span />
    </div>
    {tracks.map((track, position) => {
      const active = trackKey(track) === trackKey(player.current);
      const isLiked = likedKeys.has(trackKey(track));
      const play = () => active ? player.toggle() : player.playTracks(tracks, position, label, track.sceneId);
      return <motion.div className={`chart-row ${active ? 'active-track' : ''}`} role="row" key={track.id} initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }} transition={{ duration: 0.24, delay: Math.min(position * 0.012, 0.3) }}>
        <button className={`row-rank ${ranked && position < 3 ? `medal-${position + 1}` : ''}`} onClick={play} aria-label={`${active && player.isPlaying ? 'Pause' : 'Play'} ${track.title} by ${track.artist}`}>
          {active ? <Equalizer playing={player.isPlaying} /> : <>
            <span className="rank-number">{String(position + 1).padStart(2, '0')}</span>
            <Play className="rank-play" size={14} fill="currentColor" />
          </>}
        </button>
        <div className="row-title" role="cell">
          <button className="row-art" onClick={play} tabIndex={-1} aria-hidden="true"><Artwork src={track.artwork} alt={`${track.album} cover`} className="row-artwork" /></button>
          <div className="row-names">
            <button className="row-song" onClick={play}>{track.title}</button>
            <div className="row-byline"><button className="row-artist" onClick={() => onArtist(track)}>{track.artist}</button><Chip track={track} /></div>
          </div>
        </div>
        <span className="album-column row-album" role="cell">{track.album}</span>
        <span className="row-duration" role="cell">{formatTime(track.duration)}</span>
        <button className={`icon-button row-heart ${isLiked ? 'liked' : ''}`} aria-label={`${isLiked ? 'Unlike' : 'Like'} ${track.title}`} aria-pressed={isLiked} onClick={() => onLike(track)}><Heart size={16} fill={isLiked ? 'currentColor' : 'none'} /></button>
        <button className="icon-button row-more" aria-label={`More options for ${track.title}`} onClick={() => onMore(track)}><MoreHorizontal size={18} /></button>
      </motion.div>;
    })}
  </div>;
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const focus = dialog?.querySelector<HTMLElement>('[data-autofocus]') || dialog?.querySelector<HTMLElement>('button, input, textarea');
    focus?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, a[href], [tabindex="0"]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose]);
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} initial={{ opacity: 0, y: 22, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }}>
      <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
      {children}
    </motion.div>
  </motion.div>;
}
