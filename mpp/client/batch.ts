import { createMethod } from './shared.js';
import type { ClientMethod, ClientOptions } from './shared.js';
export function batch(options: ClientOptions): ClientMethod { return createMethod('batch-settlement', options); }
