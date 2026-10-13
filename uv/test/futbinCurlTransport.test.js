import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurlResponse, futbinCurlFetch } from '../src/futbinCurlTransport.js';

test('curl response headers do not corrupt JSON and Retry-After survives header parsing',async()=>{
  const ok=parseCurlResponse('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"data":[1]}\n__FUTBIN_HTTP_STATUS__:200|application/json');
  assert.deepEqual((await ok.json()).data,[1]);
  const limited=parseCurlResponse('HTTP/2 429\r\nRetry-After: 7200\r\n\r\n{}\n__FUTBIN_HTTP_STATUS__:429|application/json');
  assert.equal(limited.headers.get('retry-after'),'7200');
  assert.equal(limited.ok,false);
});

test('curl transport parses successful JSON and blocks invalid output',async()=>{
  const result=parseCurlResponse('{"data":[{"ID":506}]}\n__FUTBIN_HTTP_STATUS__:200|application/json');
  assert.equal(result.ok,true);
  assert.equal(result.status,200);
  assert.equal((await result.json()).data[0].ID,506);
  assert.equal(result.headers.get('content-type'),'application/json');
  assert.throws(()=>parseCurlResponse('blocked'),/status missing/);
  const err=parseCurlResponse('<html>blocked</html>\n__FUTBIN_HTTP_STATUS__:403|text/html');
  assert.equal(err.ok,false);
  assert.equal(err.status,403);
});
test('curl transport is pinned to HTTPS FUTBIN FC27 endpoints, with no spoofing',async()=>{
  await assert.rejects(
    ()=>futbinCurlFetch('https://attacker.example/futbin/api/27/getPlayersPrice'),
    /Only FUTBIN/
  );
  let observed={};
  const data=await futbinCurlFetch(
    'https://www.futbin.org/futbin/api/27/getPlayersPrice?player_ids=506&platform=PS',
    {},async(bin,args,opts)=>{
      observed={bin,args,opts};
      return {stdout:'{"data":[{"ID":506,"LCPrice":54000}],"errorcode":"200"}\n__FUTBIN_HTTP_STATUS__:200|application/json'};
    }
  );
  assert.equal(data.status,200);
  assert.ok(observed.bin.includes('curl'));
  assert.ok(observed.args.includes('=https'));
  assert.ok(observed.args.includes('--max-time'));
  assert.ok(observed.args.includes('Accept: application/json'));
  assert.equal(observed.args.some(x=>/cookie|user-agent|proxy|browser/i.test(x)),false);
  assert.equal((await data.json()).data[0].LCPrice,54000);
});
