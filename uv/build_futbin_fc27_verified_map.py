import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


def fetch(rating, page):
    query = urllib.parse.urlencode({
        'platform': 'PS',
        'rating': f'{rating}-{rating}',
        'sort': 'rating',
        'order': 'desc',
        'page': page,
    })
    req = urllib.request.Request(
        'https://www.futbin.org/futbin/api/27/getFilteredPlayers?' + query,
        headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        payload = json.load(response)
    return payload.get('data', []) if isinstance(payload, dict) else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--min-rating', type=int, default=75)
    parser.add_argument('--max-rating', type=int, default=99)
    parser.add_argument('--start-page', type=int, default=1)
    parser.add_argument('--pages', type=int, default=1, help='number of pages per rating from start-page')
    parser.add_argument('--delay', type=float, default=3)
    parser.add_argument('--max-requests', type=int, default=25)
    parser.add_argument('--out', default='uv/data/futbin_fc27_verified_map.json')
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    verified = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding='utf-8') as existing:
                verified = {str(k): int(v) for k, v in json.load(existing).items()}
        except Exception:
            verified = {}

    before = len(verified)
    requests_made = 0
    stopped = None

    for rating in range(args.min_rating, args.max_rating + 1):
        for page in range(args.start_page, args.start_page + max(1, args.pages)):
            if requests_made >= max(1, args.max_requests):
                stopped = 'REQUEST_BUDGET'
                break
            try:
                rows = fetch(rating, page)
                requests_made += 1
            except urllib.error.HTTPError as exc:
                stopped = f'HTTP_{exc.code}'
                break
            except Exception as exc:
                stopped = type(exc).__name__
                break

            if not rows:
                break

            for row in rows:
                ea_id = row.get('resource_id') or row.get('Player_Resource') or row.get('playerid')
                futbin_id = row.get('ID') or row.get('id')
                if ea_id and futbin_id:
                    verified[str(int(ea_id))] = int(futbin_id)

            if len(rows) < 30:
                break
            time.sleep(max(1.0, args.delay))
        if stopped:
            break

    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump(verified, handle, indent=2, sort_keys=True)

    print(json.dumps({
        'ok': stopped in (None, 'REQUEST_BUDGET'),
        'verifiedMappings': len(verified),
        'added': len(verified) - before,
        'requests': requests_made,
        'stopped': stopped,
        'out': args.out,
    }))


if __name__ == '__main__':
    main()
