import { env } from '../config/env.js';

export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Checks if a hostname matches a domain pattern.
 * Properly handles full domain matching to prevent partial matches
 * (e.g. 'hehx.com' should not match 'x.com').
 */
export const isDomainMatch = (hostname: string, domain: string): boolean => {
  if (hostname === domain) return true;
  if (hostname.endsWith(`.${domain}`)) return true;
  return false;
};

/**
 * Checks if the URL is from a supported media platform.
 * Only allows http/https protocols.
 */
export const isSupportedPlatform = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return env.SUPPORTED_DOMAINS.some((domain) => isDomainMatch(parsed.hostname, domain));
  } catch {
    return false;
  }
};

// Compute once at module load since SUPPORTED_DOMAINS is immutable
const supportedPlatformsDisplay = ((): string => {
  const seen = new Set<string>();
  return env.SUPPORTED_DOMAINS.map((domain) => {
    switch (domain) {
      case 'youtu.be':
        return null;
      case 'youtube.com':
        return 'YouTube';
      case 'vimeo.com':
        return 'Vimeo';
      case 'soundcloud.com':
        return 'SoundCloud';
      case 'mixcloud.com':
        return 'Mixcloud';
      case 'instagram.com':
        return 'Instagram';
      case 'twitter.com':
      case 'x.com':
        return 'Twitter/X';
      case 'bandcamp.com':
        return 'Bandcamp';
      default:
        return domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
    }
  })
    .filter((platform): platform is string => {
      if (platform === null || seen.has(platform)) return false;
      seen.add(platform);
      return true;
    })
    .join(', ');
})();

export const getSupportedPlatforms = (): string => supportedPlatformsDisplay;
