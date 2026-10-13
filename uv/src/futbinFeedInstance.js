import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFutbinDirectFeed } from './futbinDirectFeed.js';
export const FUTBIN_DATA_DIR=process.env.UV_DATA_DIR || fileURLToPath(new URL('../../.uv-data/futbin27/',import.meta.url));
export const originalUvFutbinPriceFeed=createFutbinDirectFeed({cacheFile:path.join(FUTBIN_DATA_DIR,'source.json')});
