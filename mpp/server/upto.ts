import { createMethod } from './shared.js';
import type { ServerMethod, ServerOptions } from './shared.js';
export function upto(options: ServerOptions): ServerMethod { return createMethod('upto', options); }
