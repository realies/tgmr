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
 * Checks if the URL is from a supported media platform
 * @param url - The URL to check
 * @returns boolean indicating if the URL is from a supported platform
 */
export const isSupportedPlatform = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return env.SUPPORTED_DOMAINS.some((domain) => hostname.includes(domain));
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
