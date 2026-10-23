// The phone's app icon: a real square 512x512 PNG of the Ronin Inc crest on black (the companion's theme colour), made
// from assets/ronin-inc-crest.png. The web manifest declares 512x512, so what /icon.png serves must be exactly that.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHONE_ICON_SIZE = 512;
export const PHONE_ICON = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ronin-inc-crest-512.png');
