export interface GoogleColor {
  id: string;
  name: string;
  hex: string;
  rgb: [number, number, number];
}

export const GOOGLE_CALENDAR_COLORS: Record<string, GoogleColor> = {
  '1': { id: '1', name: 'Lavender', hex: '#7986cb', rgb: [121, 134, 203] },
  '2': { id: '2', name: 'Sage', hex: '#33b679', rgb: [51, 182, 121] },
  '3': { id: '3', name: 'Grape', hex: '#8e24aa', rgb: [142, 36, 170] },
  '4': { id: '4', name: 'Flamingo', hex: '#e67c73', rgb: [230, 124, 115] },
  '5': { id: '5', name: 'Banana', hex: '#f6bf26', rgb: [246, 191, 38] },
  '6': { id: '6', name: 'Tangerine', hex: '#f4511e', rgb: [244, 81, 30] },
  '7': { id: '7', name: 'Peacock', hex: '#039be5', rgb: [3, 155, 229] },
  '8': { id: '8', name: 'Graphite', hex: '#616161', rgb: [97, 97, 97] },
  '9': { id: '9', name: 'Blueberry', hex: '#3f51b5', rgb: [63, 81, 181] },
  '10': { id: '10', name: 'Basil', hex: '#0b8043', rgb: [11, 128, 67] },
  '11': { id: '11', name: 'Tomato', hex: '#d50000', rgb: [213, 0, 0] },
};

/**
 * Match Hex string (e.g. #FFFF00 or #FF0) to closest Google Calendar colorId
 */
export function matchHexToGoogleColor(hexStr: string): string | undefined {
  const clean = hexStr.trim().replace(/^#/, '');
  let r = 0, g = 0, b = 0;

  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  } else {
    return undefined;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b)) return undefined;

  let closestId = '7';
  let minDistance = Infinity;

  for (const [id, color] of Object.entries(GOOGLE_CALENDAR_COLORS)) {
    const dr = r - color.rgb[0];
    const dg = g - color.rgb[1];
    const db = b - color.rgb[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < minDistance) {
      minDistance = distance;
      closestId = id;
    }
  }

  return closestId;
}

/**
 * Common color name and subcategory keyword mapping
 */
const KEYWORD_MAP: Array<{ keywords: string[]; colorId: string }> = [
  // 5: Banana / Yellow (e.g. Upcoming Events, Newsletter)
  {
    keywords: [
      'upcoming event', 'upcoming', 'newsletter', 'newsletter feature mention',
      'yellow', 'banana', 'gold', 'amber', 'caution', 'warning'
    ],
    colorId: '5'
  },
  // 7: Peacock / Light Blue / Cyan (e.g. Promo Slides, Digital)
  {
    keywords: [
      'promo slide', 'promo', 'digital', 'slide', 'slides', 'peacock',
      'cyan', 'light blue', 'sky blue', 'azure', 'aqua', 'teal'
    ],
    colorId: '7'
  },
  // 4: Flamingo / Pink / Coral (e.g. Events Page, Website)
  {
    keywords: [
      'events page', 'events', 'website', 'page', 'flamingo',
      'pink', 'light red', 'coral', 'salmon', 'rose', 'blush'
    ],
    colorId: '4'
  },
  // 6: Tangerine / Orange / Peach (e.g. Announcements)
  {
    keywords: [
      'announcements', 'announcement', 'tangerine', 'orange', 'peach', 'apricot', 'bronze'
    ],
    colorId: '6'
  },
  // 2: Sage / Light Green / Mint (e.g. Restroom Posters, Signage)
  {
    keywords: [
      'restroom posters', 'posters', 'signage', 'print', 'sage',
      'light green', 'mint', 'lime', 'spring green'
    ],
    colorId: '2'
  },
  // 8: Graphite / Gray (e.g. Social Media)
  {
    keywords: [
      'social media', 'social', 'graphite', 'gray', 'grey', 'charcoal', 'slate', 'silver'
    ],
    colorId: '8'
  },
  // 9: Blueberry / Dark Blue / Navy
  {
    keywords: [
      'internal', 'meeting', 'blueberry', 'blue', 'dark blue', 'navy', 'cobalt', 'indigo'
    ],
    colorId: '9'
  },
  // 10: Basil / Dark Green
  {
    keywords: [
      'basil', 'green', 'dark green', 'forest green', 'emerald', 'olive'
    ],
    colorId: '10'
  },
  // 11: Tomato / Red (Urgent / Cancelled)
  {
    keywords: [
      'urgent', 'critical', 'cancel', 'cancelled', 'tomato', 'red', 'crimson', 'ruby', 'alert'
    ],
    colorId: '11'
  },
  // 3: Grape / Purple / Violet
  {
    keywords: [
      'grape', 'purple', 'violet', 'magenta', 'plum', 'eggplant'
    ],
    colorId: '3'
  },
  // 1: Lavender / Light Purple
  {
    keywords: [
      'lavender', 'lilac', 'light purple', 'periwinkle'
    ],
    colorId: '1'
  },
];

/**
 * Map Smartsheet cell format string (index 9 is bg_color) to Google Calendar colorId
 */
export function mapSmartsheetFormatToColor(formatStr?: string | null): string | undefined {
  if (!formatStr) return undefined;
  const parts = formatStr.split(',');
  if (parts.length < 10) return undefined;

  const bgIndex = parseInt(parts[9], 10);
  if (isNaN(bgIndex) || bgIndex <= 0 || bgIndex === 2 || bgIndex === 3) {
    return undefined; // 0=none, 2=white, 3=transparent
  }

  // Smartsheet Background Color Palette Index to Google ColorId
  switch (bgIndex) {
    case 1:
    case 4: case 5: case 6: case 7: case 8: case 9:
      return '8'; // Graphite / Gray
    case 10:
      return '11'; // Tomato / Red
    case 11: case 22: case 27: case 39: case 40:
      return '4'; // Flamingo / Pink / Light Red
    case 12: case 13: case 26: case 32:
      return '6'; // Tangerine / Orange / Peach
    case 14: case 15: case 25: case 30: case 31:
      return '5'; // Banana / Yellow
    case 16: case 34: case 35:
      return '10'; // Basil / Dark Green
    case 17: case 24: case 33:
      return '2'; // Sage / Light Green
    case 18: case 23: case 29: case 36: case 37:
      return '7'; // Peacock / Cyan / Light Blue
    case 19: case 38:
      return '9'; // Blueberry / Dark Blue
    case 20:
      return '3'; // Grape / Purple
    case 21: case 28:
      return '1'; // Lavender / Light Purple
    default:
      return undefined;
  }
}

/**
 * Universal color resolver for Smartsheet -> Google Calendar event colorId.
 * Supports:
 * - Direct Google Calendar colorId ('1' to '11')
 * - Hex colors (#f6bf26, #33b679, etc.)
 * - Color names (yellow, blue, green, red, pink, etc.)
 * - Subcategory/Category text keywords (Upcoming Event, Promo Slide, Announcements, etc.)
 * - Smartsheet cell format background color
 */
export function parseColorToGoogleColorId(value?: string | null, format?: string | null): string | undefined {
  // 1. Direct Google Calendar color ID ('1' through '11')
  if (value) {
    const trimmed = value.trim();
    if (/^(?:[1-9]|1[01])$/.test(trimmed)) {
      return trimmed;
    }

    // 2. Hex color code
    if (/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
      const match = matchHexToGoogleColor(trimmed);
      if (match) return match;
    }

    // 3. Keyword / Category Name / Color Name
    const lower = trimmed.toLowerCase();
    for (const entry of KEYWORD_MAP) {
      if (entry.keywords.some((kw) => lower === kw || lower.includes(kw))) {
        return entry.colorId;
      }
    }
  }

  // 4. Cell formatting background color from Smartsheet
  if (format) {
    const formatMatch = mapSmartsheetFormatToColor(format);
    if (formatMatch) return formatMatch;
  }

  return undefined;
}
