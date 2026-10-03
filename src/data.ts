import type { Scene, Track } from './types';

/**
 * Charts of famous, recognisable artists. Genre scenes use the official Deezer
 * charts; place scenes use the top tracks of the artists who define that scene.
 */
export const scenes: Scene[] = [
  { id: 'global', name: 'Global Top 50', short: 'Global', kicker: 'THE WORLD RIGHT NOW', blurb: 'The fifty biggest tracks on the planet this week.', color: '#f6b93b', kind: 'chart', genreId: 0 },

  { id: 'morocco', name: 'Morocco Top 50', short: 'Morocco', kicker: 'MEN CASA L MAGHREB KAMLO', blurb: 'ElGrandeToto, Stormy, Draganov, Dizzy DROS, Don Bigg, Saad Lamjarred and the rest of the Moroccan scene.', color: '#3553e8', kind: 'artists', region: 'Morocco', artists: [
    { name: 'ElGrandeToto', id: 52463032 }, { name: 'Stormy', id: 3615211 }, { name: 'Draganov' }, { name: 'Tagne' },
    { name: 'Dizzy DROS' }, { name: 'Don Bigg' }, { name: '7liwa' }, { name: 'Small X' }, { name: 'Manal' },
    { name: 'Saad Lamjarred' }, { name: 'Zouhair Bahaoui' }, { name: 'Muslim' }, { name: 'Shayfeen' }, { name: 'Khtek' },
  ] },

  { id: 'usa', name: 'USA Top 50', short: 'USA', kicker: 'ATLANTA TO BROOKLYN', blurb: 'Kendrick, Drake, Travis Scott, SZA, Future, Doja Cat, Beyoncé and the American mainstream.', color: '#c8452f', kind: 'artists', region: 'United States', artists: [
    { name: 'Kendrick Lamar' }, { name: 'Drake', id: 246791 }, { name: 'Travis Scott', id: 4495513 }, { name: 'SZA', id: 5531258 },
    { name: 'Future' }, { name: 'Doja Cat' }, { name: 'Beyoncé' }, { name: 'Chris Brown' }, { name: '21 Savage' },
    { name: 'Post Malone' }, { name: 'Nicki Minaj' }, { name: 'Tyler, The Creator' }, { name: 'Billie Eilish' }, { name: 'Bad Bunny' },
  ] },

  { id: 'europe', name: 'Europe Top 50', short: 'Europe', kicker: 'LONDON · PARIS · MADRID', blurb: 'Ed Sheeran, Dua Lipa, Central Cee, Ninho, Damso, Morad, Stromae and Europe’s biggest names.', color: '#2f6fb0', kind: 'artists', region: 'Europe', artists: [
    { name: 'Ed Sheeran' }, { name: 'Dua Lipa' }, { name: 'Central Cee' }, { name: 'Ninho' }, { name: 'Damso' },
    { name: 'Morad' }, { name: 'Stromae' }, { name: 'Jul' }, { name: 'Sfera Ebbasta' }, { name: 'Måneskin' },
    { name: 'Adele' }, { name: 'Coldplay' }, { name: 'David Guetta' }, { name: 'Aya Nakamura' },
  ] },

  { id: 'afro', name: 'Afro Top 50', short: 'Afro', kicker: 'LAGOS TO THE WORLD', blurb: 'Burna Boy, Wizkid, Rema, Tems, Asake, Davido, Ayra Starr and the Afrobeats wave.', color: '#e9703f', kind: 'artists', region: 'Africa', artists: [
    { name: 'Burna Boy', id: 4338602 }, { name: 'Wizkid' }, { name: 'Rema' }, { name: 'Tems' }, { name: 'Asake' },
    { name: 'Davido' }, { name: 'Ayra Starr' }, { name: 'CKay' }, { name: 'Omah Lay' }, { name: 'Fireboy DML' },
  ] },

  { id: 'funk', name: 'Funk Top 50', short: 'Funk', kicker: 'GROOVE, BASS AND BRASS', blurb: 'Bruno Mars, Anderson .Paak, Jamiroquai, Earth Wind & Fire, Chic, Thundercat.', color: '#d98324', kind: 'artists', artists: [
    { name: 'Bruno Mars' }, { name: 'Anderson .Paak' }, { name: 'Jamiroquai' }, { name: 'Earth, Wind & Fire' },
    { name: 'Kool & The Gang' }, { name: 'Chic' }, { name: 'Thundercat' }, { name: 'Vulfpeck' }, { name: 'Parliament' },
  ] },

  { id: 'rap', name: 'Rap Top 50', short: 'Rap', kicker: 'BARS AND 808S', blurb: 'The official rap and hip hop chart.', color: '#545b8a', kind: 'chart', genreId: 116 },
  { id: 'rnb', name: 'R&B Top 50', short: 'R&B', kicker: 'LOW LIGHTS, DEEP FEELINGS', blurb: 'The official R&B and soul chart.', color: '#8a4fd0', kind: 'chart', genreId: 165 },
  { id: 'pop', name: 'Pop Top 50', short: 'Pop', kicker: 'HOOKS THAT STICK', blurb: 'The official pop chart.', color: '#e0679a', kind: 'chart', genreId: 132 },
  { id: 'dance', name: 'Dance Top 50', short: 'Dance', kicker: 'HANDS IN THE AIR', blurb: 'The official dance chart.', color: '#17a2c4', kind: 'chart', genreId: 113 },
  { id: 'electro', name: 'Electro Top 50', short: 'Electro', kicker: 'MACHINES WITH FEELINGS', blurb: 'The official electro chart.', color: '#0ea5a5', kind: 'chart', genreId: 106 },
  { id: 'rock', name: 'Rock Top 50', short: 'Rock', kicker: 'LOUD AND PROUD', blurb: 'The official rock chart.', color: '#a8452f', kind: 'chart', genreId: 152 },
  { id: 'alternative', name: 'Alternative Top 50', short: 'Alt', kicker: 'THE OTHER SIDE', blurb: 'The official alternative chart.', color: '#2f9c84', kind: 'chart', genreId: 85 },
  { id: 'reggaeton', name: 'Reggaeton Top 50', short: 'Reggaeton', kicker: 'PERREO SIN FRONTERAS', blurb: 'The official reggaeton chart.', color: '#d9534f', kind: 'chart', genreId: 122 },
  { id: 'reggae', name: 'Reggae Top 50', short: 'Reggae', kicker: 'ONE DROP, ONE LOVE', blurb: 'The official reggae chart.', color: '#4f9c3f', kind: 'chart', genreId: 144 },
  { id: 'jazz', name: 'Jazz Top 50', short: 'Jazz', kicker: 'SMOKE AND BRASS', blurb: 'The official jazz chart.', color: '#b08a3e', kind: 'chart', genreId: 129 },
  { id: 'country', name: 'Country Top 50', short: 'Country', kicker: 'STORIES AND STEEL', blurb: 'The official country chart.', color: '#b3763c', kind: 'chart', genreId: 84 },

  { id: 'fulltracks', name: 'Full Tracks 50', short: 'Full tracks', kicker: 'COMPLETE, START TO FINISH', blurb: 'Independent artists whose whole songs stream in full, with no time limit.', color: '#5fd7b1', kind: 'audius' },
];

export const sceneById = (id: string) => scenes.find((scene) => scene.id === id);

function seed(input: { id: string; title: string; artist: string; handle: string; duration: number; artwork: string; permalink: string; plays: number; released: string; genre: string }): Track {
  return {
    id: `audius:${input.id}`, title: input.title, artist: input.artist, artistHandle: input.handle,
    artistId: `handle:${input.handle.toLowerCase()}`, artistPhoto: '',
    album: `${input.genre} · ${input.released.slice(0, 4)}`, artwork: input.artwork, duration: input.duration,
    audioUrl: `https://api.audius.co/v1/tracks/${input.id}/stream?app_name=Vibe`,
    externalUrl: `https://audius.co${input.permalink}`, sceneId: 'fulltracks',
    plays: input.plays, favorites: 0, releaseDate: input.released, fullLength: true,
  };
}

// Complete streams, so something always plays even before the charts land.
export const seedTracks: Track[] = [
  seed({ id: 'y8NWZ', title: 'More Than Enough', artist: 'Alina Baraz', handle: 'alinabaraz', duration: 152, artwork: 'https://v.monophonic.digital/content/QmSSfnU4GnrLcCbcpnhSqSZbDjVvvfKPL5wBb2Hh5Sk3Sk/480x480.jpg', permalink: '/alinabaraz/more-than-enough-97935', plays: 863418, released: '2020-10-20T18:00:00Z', genre: 'R&B/Soul' }),
  seed({ id: 'O795R', title: 'Blackpool Boulevard', artist: 'Anish Kumar', handle: 'anishkumar', duration: 355, artwork: 'https://v.monophonic.digital/content/QmNaq93WQzt7vN2eZhBVguP4kGMf35C6KzRBS8iV82jJwW/480x480.jpg', permalink: '/anishkumar/anish-kumar-barry-can’t-swim-blackpool-boulevard', plays: 80425, released: '2022-03-01T14:03:30Z', genre: 'Electronic' }),
  seed({ id: 'ZRXq0Aq', title: 'Endspiration (feat. The BloodFunks)', artist: 'Grixxly', handle: 'Grixxly', duration: 430, artwork: 'https://v.monophonic.digital/content/baeaaaiqsecla2u5qxrkclmjyc5o62vl7aj4g3oi3sdexsooe6l6txu264azey/480x480.jpg', permalink: '/Grixxly/endspiration-ft-the-bloodfunks', plays: 577, released: '2026-03-01T06:00:00Z', genre: 'Hip-Hop/Rap' }),
  seed({ id: 'RpJlZE1', title: 'Insomnia', artist: 'ODYON', handle: 'odyon.live', duration: 228, artwork: 'https://v.monophonic.digital/content/baeaaaiqsebtcfhqsn5p4cedc2x4p5fp2rtc6wo43tpmgppmel3qbb6ejpditk/480x480.jpg', permalink: '/odyon.live/odyon-insomnia', plays: 329, released: '2026-09-03T22:00:00Z', genre: 'Electronic' }),
];

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
