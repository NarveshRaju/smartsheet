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
 * Official Smartsheet Background Color Palette to Google Calendar colorId.
 * Based on Smartsheet's FormatTables.color palette definition.
 */
export const SMARTSHEET_PALETTE_TO_GCAL: Record<number, string> = {
  // Reds & Pinks (Column 1)
  4: '4',   // #FFEBEE -> Flamingo (Light Pink)
  11: '4',  // #FFCCD2 -> Flamingo (Soft Pink)
  19: '4',  // #F87E7D -> Flamingo (Coral Pink)
  27: '11', // #EA352E -> Tomato (Bright Red)
  35: '11', // #991310 -> Tomato (Dark Red)

  // Oranges & Peaches (Column 2)
  5: '6',   // #FFF3DF -> Tangerine (Light Peach)
  12: '6',  // #FFE1AF -> Tangerine (Soft Peach)
  20: '6',  // #FFCD7A -> Tangerine (Peach Orange)
  28: '6',  // #FF8D00 -> Tangerine (Bright Orange)
  36: '6',  // #EA5000 -> Tangerine (Dark Orange)

  // Yellows (Column 3)
  6: '5',   // #FFFEE6 -> Banana (Light Yellow)
  13: '5',  // #FEFF85 -> Banana (Soft Yellow)
  21: '5',  // #FEFF00 -> Banana (Bright Yellow)
  29: '5',  // #FFED00 -> Banana (Vibrant Yellow)
  37: '5',  // #EBC700 -> Banana (Gold / Dark Yellow)

  // Greens (Column 4)
  7: '2',   // #E7F5E9 -> Sage (Light Mint)
  14: '2',  // #C6E7C8 -> Sage (Soft Green)
  22: '2',  // #7ED085 -> Sage (Medium Green)
  30: '10', // #40B14B -> Basil (Bright Green)
  38: '10', // #237F2E -> Basil (Dark Green)

  // Blues (Column 5)
  8: '7',   // #E2F2FE -> Peacock (Light Sky Blue)
  15: '7',  // #B9DDFC -> Peacock (Soft Blue)
  23: '7',  // #5FB3F9 -> Peacock (Sky Blue)
  31: '9',  // #1061C3 -> Blueberry (Bright Blue)
  39: '9',  // #0B347D -> Blueberry (Navy Blue)

  // Purples (Column 6)
  9: '1',   // #F4E4F5 -> Lavender (Light Purple)
  16: '1',  // #EBC7EF -> Lavender (Soft Purple)
  24: '1',  // #D190DA -> Lavender (Lilac)
  32: '3',  // #9210AD -> Grape (Purple)
  40: '3',  // #61058B -> Grape (Dark Purple)

  // Grays & Browns (Column 7)
  1: '8',   // #000000 -> Graphite (Black)
  10: '8',  // #F2E8DE -> Graphite (Light Gray-Tan)
  17: '8',  // #EEDCCA -> Graphite (Tan)
  18: '8',  // #E5E5E5 -> Graphite (Light Gray)
  25: '8',  // #D0AF8F -> Graphite (Medium Tan)
  26: '8',  // #BDBDBD -> Graphite (Medium Gray)
  33: '6',  // #974C00 -> Tangerine (Brown)
  34: '8',  // #757575 -> Graphite (Dark Gray)
  41: '8',  // #592C00 -> Graphite (Dark Brown)
};

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

  return SMARTSHEET_PALETTE_TO_GCAL[bgIndex];
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
