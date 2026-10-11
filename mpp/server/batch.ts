import { createMethod } from './shared.js';
import type { ServerMethod, ServerOptions } from './shared.js';
export function batch(options: ServerOptions): ServerMethod { return createMethod('batch-settlement', options); }
