import './v1066Register.mjs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./v10695Loader.mjs', pathToFileURL('./'));
