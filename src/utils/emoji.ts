/**
 * Shared emoji resolution utilities
 *
 * Single source of truth for emoji alias mapping across all channel adapters.
 * Consolidates duplicate implementations from Slack, Discord, Telegram, and CLI.
 */

export const EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  // Receipt indicator
  eyes: '👀',

  // Thumbs (Slack, Discord, Telegram, CLI)
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  thumbs_down: '👎',
  '-1': '👎',

  // Hearts
  heart: '❤️',
  hearts: '❤️',

  // Checkmarks
  check: '✅',
  white_check_mark: '✅',
  heavy_check_mark: '✅',

  // X marks
  x: '❌',
  heavy_multiplication_x: '❌',
  negative_squared_cross_mark: '❎',

  // Celebration
  tada: '🎉',
  clap: '👏',
  star: '⭐',
  sparkles: '✨',
  glowing_star: '🌟',

  // Faces
  smile: '😄',
  laughing: '😆',
  cry: '😢',
  crying: '😢',
  pensive: '😔',
  confused: '😕',
  thinking: '🤔',

  // Gestures
  ok_hand: '👌',
  wave: '👋',
  hug: '🤗',
  hugs: '🤗',

  // Objects
  fire: '🔥',
  rocket: '🚀',
  warning: '⚠️',
  question: '❓',
  exclamation: '❗',
  brain: '🧠',
  microphone: '🎤',
  mag: '🔍',
  book: '📖',
  pencil: '✍️',
  floppy_disk: '💾',
  gear: '⚙️',
  camera: '📸',
  wrench: '🔧',
  robot: '🤖',
};

/**
 * Reverse mapping from unicode to alias (for Slack name resolution)
 */
export const UNICODE_TO_ALIAS = new Map<string, string>(
  Object.entries(EMOJI_ALIAS_TO_UNICODE).map(([name, value]) => [value, name])
);

/**
 * Resolve an emoji input to its unicode representation.
 *
 * - Already unicode? Pass through (first codepoint > 255).
 * - Wrapped in colons (":heart:")? Strip and look up.
 * - Plain alias ("heart")? Look up directly.
 * - Unknown? Return input unchanged.
 */
export function resolveEmoji(input: string): string {
  if (!input) return input;

  // Already unicode? Pass through (first codepoint > 255)
  const cp = input.codePointAt(0);
  if (cp && cp > 255) return input;

  // Strip colons: ":heart:" → "heart"
  const name = input.replace(/^:|:$/g, '').toLowerCase();

  // Check main alias map
  const resolved = EMOJI_ALIAS_TO_UNICODE[name];
  if (resolved) return resolved;

  // Handle shortcodes with underscores (e.g., "white_check_mark")
  const nameWithUnderscores = name.replace(/-/g, '_');
  if (nameWithUnderscores !== name) {
    const resolvedUnderscore = EMOJI_ALIAS_TO_UNICODE[nameWithUnderscores];
    if (resolvedUnderscore) return resolvedUnderscore;
  }

  return input;
}

/**
 * Get Slack emoji name from unicode.
 * Returns the alias name if found, or null if not in the known set.
 */
export function resolveSlackEmojiName(input: string): string | null {
  // If it's already an alias (no colons), return it directly if known
  if (!input.startsWith(':') && !input.endsWith(':')) {
    if (EMOJI_ALIAS_TO_UNICODE[input]) {
      return input;
    }
  }

  // Strip colons and check
  const alias = input.replace(/^:|:$/g, '');
  if (EMOJI_ALIAS_TO_UNICODE[alias]) {
    return alias;
  }

  // Try reverse lookup from unicode
  return UNICODE_TO_ALIAS.get(input) || null;
}
