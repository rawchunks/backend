import { createMethod } from './shared.js';
import type { ClientMethod, ClientOptions } from './shared.js';
export function upto(options: ClientOptions): ClientMethod { return createMethod('upto', options); }
