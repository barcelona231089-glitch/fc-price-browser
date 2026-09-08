import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./v1065Loader.mjs', pathToFileURL('./'));
