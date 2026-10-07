import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateReasons, cleanJsonSchema, countsFor, groupEndpoints, inferJsonSchema, jsonSchemaFields,
  isProtectionTraffic, looksLikeSecret, matchesRequestFilter, safeRequestUrl, sanitizeUrl, sanitizedTrafficExport,
} from '../lib/traffic-core/src/index';
import { AnalyzeTrafficResponse, GetTrafficSessionStateResponse } from '../lib/api-zod/src/index';
import { isPublicAddress, validateTarget } from '../artifacts/api-server/src/lib/traffic-analyzer';

const sampleRequest = { id:'request-1', url:'https://example.com/api/items/1', hostname:'example.com', path:'/api/items/1', method:'GET', statusCode:200, contentType:'application/json', startedAt:'2026-10-05T23:00:00.000Z', durationMs:12, type:'rest' as const, resourceType:'fetch', jsonSchema:null, isApiCandidate:true, candidateReasons:['Fetch/XHR'] };
const sample = { url:'https://example.com', capturedAt:'2026-10-05T23:00:00.000Z', durationMs:3000, requestCount:1, blockedCount:0, counts:{ fetchXhr:1, rest:1, graphql:0, websocket:0 }, requests:[sampleRequest], warnings:[] };

test('API contract accepts null jsonSchema and keeps ISO timestamps as strings', () => {
  const parsed = AnalyzeTrafficResponse.parse(sample);
  assert.equal(parsed.capturedAt, sample.capturedAt);
  assert.equal(parsed.requests[0].startedAt, sampleRequest.startedAt);
  assert.equal(parsed.requests[0].jsonSchema, null);
  assert.equal(AnalyzeTrafficResponse.safeParse({ ...sample, requests:[{...sampleRequest,jsonSchema:undefined,responseSchema:{type:'object'}}] }).success, false);
  const state = GetTrafficSessionStateResponse.parse({ ...sample, sessionId:'12345678-1234-1234-1234-123456789012', startedAt:sample.capturedAt, recording:true, closed:false, screenshot:null, viewportWidth:1280, viewportHeight:800 });
  assert.equal(typeof state.startedAt, 'string');
});

test('JSON schema contains field names and types, never response values or credential names', () => {
  const schema = inferJsonSchema([{ id:1, price:29.95, name:'ONLY_A_FAKE_BODY_VALUE', password:'ONLY_A_FAKE_SECRET', profile:{ active:true, accessToken:'ONLY_A_FAKE_SECRET' } }, {id:2,price:null,profile:{games:3}}]);
  assert.deepEqual(jsonSchemaFields(schema), ['[].id','[].name','[].price','[].profile','[].profile.active','[].profile.games']);
  const serialized = JSON.stringify(schema);
  assert(!serialized.includes('ONLY_A_FAKE'));
  assert(!serialized.includes('password'));
  assert(!serialized.includes('accessToken'));
  assert(!serialized.includes('29.95'));
});

test('Defensive schema allowlist drops injected literals, examples, tokens and unsafe property names', () => {
  const clean = cleanJsonSchema({ type:'object', examples:['FAKE_ONLY'], properties:{price:{type:'number',default:99,enum:[99]}, password:{type:'string'}, 'ghp_FAKE0123456789abcdefghijklmnop':{type:'string'}, '__proto__':{type:'string'}}, rawResponse:'FAKE_ONLY' });
  assert.deepEqual(jsonSchemaFields(clean), ['price']);
  assert(!JSON.stringify(clean).includes('FAKE_ONLY'));
  assert(!JSON.stringify(clean).includes('99'));
});

test('URL display and export omit query, fragment, userinfo and opaque path credentials', () => {
  assert.equal(sanitizeUrl('https://name:fake@example.com/api/items/1?access_token=FAKE_ONLY#secret'), 'https://example.com/api/items/1');
  assert.equal(sanitizeUrl('https://example.com/token/FAKE_ONLY'), 'https://example.com/token/[redacted]');
  assert(looksLikeSecret('ghp_0123456789abcdefghijklmnopqrstuv'));
  assert.equal(safeRequestUrl('https://example.com/api/items?page=2'), 'https://example.com/api/items?page=2');
  for (const url of ['https://name:fake@example.com','https://example.com/api?authorization=FAKE_ONLY','https://example.com/api?accessToken=FAKE_ONLY','https://example.com/login','file:///etc/passwd']) assert.equal(safeRequestUrl(url),null);
});

test('Sanitized export recomputes metadata and excludes screenshots, session IDs, headers and body values', () => {
  const dirty = { ...sample, sessionId:'FAKE_ONLY_SESSION', screenshot:'FAKE_ONLY_IMAGE', cookies:'FAKE_ONLY_COOKIE', requests:[{...sampleRequest, url:'https://name:fake@example.com/api/items/1?secret=FAKE_ONLY#FAKE_ONLY', path:'FAKE_ONLY', hostname:'FAKE_ONLY', authorization:'FAKE_ONLY_HEADER', body:'FAKE_ONLY_BODY', jsonSchema:{type:'object',properties:{price:{type:'number',example:'FAKE_ONLY'},token:{type:'string'}}}}] };
  const exported = sanitizedTrafficExport(dirty);
  assert.equal(exported.requests[0].url,sampleRequest.url);
  assert.equal(exported.requests[0].path,sampleRequest.path);
  assert.equal(exported.requests[0].hostname,'example.com');
  assert.equal(exported.requestCount,1);
  assert(!JSON.stringify(exported).includes('FAKE_ONLY'));
  assert(!('sessionId' in exported));
  assert(!('screenshot' in exported));
  assert.deepEqual(jsonSchemaFields(exported.requests[0].jsonSchema), ['price']);
});

test('Fetch/XHR overlaps REST and GraphQL; filters and counts preserve the transport', () => {
  assert(matchesRequestFilter(sampleRequest,'fetch-xhr'));
  assert(matchesRequestFilter({...sampleRequest,resourceType:'xhr',type:'graphql'},'fetch-xhr'));
  assert(!matchesRequestFilter({...sampleRequest,resourceType:'document'},'fetch-xhr'));
  assert.deepEqual(countsFor([sampleRequest,{...sampleRequest,type:'graphql',resourceType:'xhr'}]),{fetchXhr:2,rest:1,graphql:1,websocket:0});
});

test('Cloudflare challenge traffic is never classified as an API candidate', () => {
  const challenge = { type:'fetch-xhr' as const, resourceType:'xhr', contentType:null, path:'/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1' };
  const turnstile = { type:'fetch-xhr' as const, resourceType:'fetch', contentType:'application/json', path:'/cdn-cgi/turnstile/v0/b/rc' };
  assert.equal(isProtectionTraffic(challenge.path), true);
  assert.equal(isProtectionTraffic(turnstile.path), true);
  assert.deepEqual(candidateReasons(challenge), []);
  assert.deepEqual(candidateReasons(turnstile), []);
  assert.deepEqual(candidateReasons({ type:'rest', resourceType:'xhr', contentType:'application/json', path:'/api/items' }), ['Fetch/XHR','JSON-Antwort','API-Pfad']);
});

test('Endpoint grouping separates methods and hosts while combining numeric and UUID IDs', () => {
  const grouped = groupEndpoints([sampleRequest,{...sampleRequest,id:'2',path:'/api/items/2',durationMs:22},{...sampleRequest,id:'3',method:'POST'},{...sampleRequest,id:'4',hostname:'other.example.com'}]);
  assert.equal(grouped.length,3);
  assert.equal(grouped[0].requests.length,2);
  assert.equal(grouped[0].path,'/api/items/:id');
  assert.equal(grouped[0].averageDurationMs,17);
});

test('Public-host policy rejects local, reserved and mapped IPv6 private addresses', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','198.18.0.1','203.0.113.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1']) assert.equal(isPublicAddress(address),false,address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
  await assert.rejects(validateTarget('http://127.0.0.1/api'), /Only public internet hosts/);
  await assert.rejects(validateTarget('http://[::ffff:127.0.0.1]/api'), /Only public internet hosts/);
});
