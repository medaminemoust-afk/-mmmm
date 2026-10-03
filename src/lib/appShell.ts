const APP_NAME = 'vibe.';

/** Zellige star with an equalizer inside it — small enough to inline, crisp at any size. */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#1b2f9e"/><g fill="none" stroke="#f6b93b" stroke-width="22" stroke-linejoin="round"><rect x="146" y="146" width="220" height="220"/><rect x="146" y="146" width="220" height="220" transform="rotate(45 256 256)"/></g><g fill="#f6b93b"><rect x="196" y="252" width="26" height="64" rx="13"/><rect x="243" y="214" width="26" height="102" rx="13"/><rect x="290" y="238" width="26" height="78" rx="13"/></g></svg>`;

export const appIconUrl = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

function setLink(rel: string, href: string, attributes: Record<string, string> = {}) {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
  Object.entries(attributes).forEach(([key, value]) => link.setAttribute(key, value));
}

/**
 * Registers the icon and web app manifest at runtime so the single-file build
 * stays installable without shipping extra asset requests.
 */
export function configureAppShell() {
  setLink('icon', appIconUrl, { type: 'image/svg+xml', sizes: 'any' });
  setLink('apple-touch-icon', appIconUrl, { sizes: '512x512' });

  const manifest = {
    name: `${APP_NAME} — full tracks, twenty Top 50s`,
    short_name: APP_NAME,
    description: 'Twenty Top 50s of complete tracks. Global, Morocco, USA, Europe, Afro, Funk and more. Never a preview.',
    start_url: '.',
    scope: '.',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#080c1c',
    theme_color: '#080c1c',
    categories: ['music', 'entertainment'],
    icons: [
      { src: appIconUrl, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: appIconUrl, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Global Top 50', short_name: 'Global', url: './?scene=global' },
      { name: 'Morocco Top 50', short_name: 'Morocco', url: './?scene=morocco' },
      { name: 'USA Top 50', short_name: 'USA', url: './?scene=usa' },
      { name: 'Europe Top 50', short_name: 'Europe', url: './?scene=europe' },
    ],
  };

  try {
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    setLink('manifest', URL.createObjectURL(blob));
  } catch {
    /* Add-to-home-screen still works from the icon and mobile web app meta tags. */
  }
}


