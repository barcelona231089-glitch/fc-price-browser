// Standard Windows curl HTTPS transport for the accessible FUTBIN JSON endpoint.
// No proxy rotation, browser impersonation, cookies, auth data or challenge handling.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execFile);
const MARKER = '\n__FUTBIN_HTTP_STATUS__:';
const MAX_BYTES = 6 * 1024 * 1024;

export function parseCurlResponse(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('curl output must be text');
  const index = stdout.lastIndexOf(MARKER);
  if (index < 0) throw new Error('curl HTTP status missing');
  const meta = stdout.slice(index + MARKER.length).trim();
  const match = meta.match(/^(\d{3})\|([^\r\n]*)$/);
  if (!match) throw new Error('curl HTTP metadata invalid');
  const status = Number(match[1]);
  if (status < 100 || status > 599) throw new Error('curl HTTP status invalid');
  const contentType = match[2].trim();
  const body = stdout.slice(0, index);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => String(name).toLowerCase() === 'content-type' ? contentType : null
    },
    async json() { return JSON.parse(body); },
    async text() { return body; }
  };
}

export async function futbinCurlFetch(url, _options = {}, execute = execAsync) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.futbin.org' ||
      !parsed.pathname.startsWith('/futbin/api/27/')) {
    throw new Error('Only FUTBIN FC27 JSON HTTPS endpoint allowed');
  }
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '--silent', '--show-error', '--compressed',
    '--proto', '=https',
    '--connect-timeout', '8', '--max-time', '15',
    '--header', 'Accept: application/json',
    '--write-out', MARKER + '%{http_code}|%{content_type}',
    '--', url
  ];
  const { stdout } = await execute(bin, args, {
    timeout: 22_000, maxBuffer: MAX_BYTES, encoding: 'utf8'
  });
  return parseCurlResponse(stdout);
}
