// The add-on's tests run its modules straight from the checkout: hand them Kingmaker's core the way register(host) does.
import { ADDON_CORE } from '../../../lib/addon-core.mjs';
import { bind } from '../core.mjs';

bind(ADDON_CORE);
