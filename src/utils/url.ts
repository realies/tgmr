import { env } from '../config/env.js';

/**
 * Validates if the given string is a valid URL
 * @param url - The URL string to validate
 * @returns boolean indicating if the URL is valid
 */
export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Checks if a hostname matches a domain pattern
 * This properly handles full domain matching to prevent partial matches
 * (e.g. 'hehx.com' should not match 'x.com')
 * @param hostname - The hostname to check
 * @param domain - The domain pattern to match against
 * @returns Whether the hostname matches the domain
 */
const isDomainMatch = (hostname: string, domain: string): boolean => {
  // Exact match
  if (hostname === domain) return true;

  // Subdomain match (e.g. sub.example.com matches example.com)
  if (hostname.endsWith(`.${domain}`)) return true;

  return false;
};

/**
 * Checks if the URL is from a supported media platform
 * @param url - The URL to check
 * @returns boolean indicating if the URL is from a supported platform
 */
export const isSupportedPlatform = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return env.SUPPORTED_DOMAINS.some((domain) => isDomainMatch(hostname, domain));
  } catch {
    return false;
  }
};

/**
 * Gets a formatted list of supported platforms for display
 * @returns string of supported platforms
 */
export const getSupportedPlatforms = (): string => {
  const platforms = env.SUPPORTED_DOMAINS.map((domain) => {
    switch (domain) {
      case 'youtu.be':
        return null; // Skip alternate YouTube domain
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
    .filter((platform): platform is string => platform !== null)
    .join(', ');

  return platforms;
};
