/* ==================================================================
   PKPilot0002 단위 테스트 — 지오코딩 어댑터 (js/geocode.js)

   역주소와 주소 검색이 하나의 레이트 리미터를 쓰는지, 429·타임아웃에서
   Photon 으로 넘어가는지, 캐시가 TTL 을 지키는지 확인한다.
   ================================================================== */

import {
  GEOCODE_CACHE_TTL_MS,
  PHOTON_LANG,
  coordKey,
  createGeocoder,
  createRateLimiter,
  describeNominatimAddress,
  describePhotonAddress,
  isSameSearchPlace,
  mergeSearchRows,
  metersApart,
  proxyEndpoints,
  retryAfterMsOf,
} from '../../js/geocode.js';
import { anchorCoordKey } from '../../js/live_places.js';
import { assert, assertEqual, test } from './harness.js';

const json = payload => ({ ok: true, status: 200, json: async () => payload });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const NOMINATIM_SEARCH = [
  {
    display_name: '대한민국 서울특별시 강남구 강남대로 396',
    name: '강남역',
    lat: '37.4979',
    lon: '127.0276',
  },
];

const PHOTON_SEARCH = {
  features: [
    {
      properties: { name: '강남역', street: '강남대로', district: '강남구', city: '서울특별시', state: '서울특별시' },
      geometry: { coordinates: [127.0276, 37.4979] },
    },
  ],
};

const PHOTON_REVERSE = {
  features: [
    {
      properties: { name: '강남역', street: '강남대로', district: '강남구', city: '서울특별시', state: '서울특별시' },
    },
  ],
};

/** 응답 순서를 정해 주는 fetch 모의 — url 로 구분한다 */
function fetchStub(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [needle, handler] of handlers) {
      if (url.includes(needle)) return handler(url, init);
    }
    throw new Error(`예상하지 못한 요청: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('주소 텍스트: Nominatim 응답을 도시·구·동네·도로로 정리한다', () => {
  const text = describeNominatimAddress({
    address: { city: '서울특별시', borough: '강남구', suburb: '역삼동', road: '강남대로' },
    display_name: '무시',
  });
  assertEqual(text, '서울특별시 강남구 역삼동 강남대로');
  assertEqual(describeNominatimAddress(null), '');
});

test('주소 텍스트: Photon 응답도 같은 규칙으로 정리한다', () => {
  const text = describePhotonAddress(PHOTON_REVERSE.features[0]);
  assertEqual(text, '서울특별시 강남구 강남대로');
});

test('레이트 리미터: 최소 간격을 지켜 순서대로 실행한다', async () => {
  const schedule = createRateLimiter(40);
  const started = [];
  const tasks = [0, 1, 2].map(i =>
    schedule(async () => {
      started.push(Date.now());
      return i;
    }));
  const results = await Promise.all(tasks);
  assertEqual(results.join(','), '0,1,2');
  assert(started.length === 3);
  for (let i = 1; i < started.length; i += 1) {
    assert(started[i] - started[i - 1] >= 35, `간격이 짧다: ${started[i] - started[i - 1]}ms`);
  }
});

test('검색: Nominatim 결과를 앱 형식으로 돌려준다', async () => {
  const fetchImpl = fetchStub([['nominatim.openstreetmap.org/search', () => json(NOMINATIM_SEARCH)]]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const rows = await geocoder.search('강남역');
  assertEqual(rows.length, 1);
  assertEqual(rows[0].name, '강남역');
  assertEqual(rows[0].lat, 37.4979);
  assertEqual(rows[0].address, '대한민국 서울특별시 강남구 강남대로 396');
  assertEqual(rows[0].source, 'nominatim');
});

test('검색: 429 는 재시도 없이 즉시 Photon 으로 넘어간다', async () => {
  let nominatimCalls = 0;
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => {
      nominatimCalls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    }],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retryDelayMs: 5, retries: 1 });
  const rows = await geocoder.search('강남역');
  // 429 를 다시 두드리면 서버 부하만 늘고, Retry-After 를 기다리면 대체 검색이 늦어진다.
  assertEqual(nominatimCalls, 1, `429 인데 ${nominatimCalls}번 요청했다`);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].source, 'photon');
  assertEqual(rows[0].lng, 127.0276);
});

test('검색: 두 어댑터가 모두 실패하면 GeocodeError(search_unavailable)', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['photon.komoot.io/api', () => ({ ok: false, status: 503, json: async () => ({}) })],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 0 });
  let error = null;
  try {
    await geocoder.search('없는 곳');
  } catch (err) {
    error = err;
  }
  assert(error, '예외가 없다');
  assertEqual(error.name, 'GeocodeError');
  assertEqual(error.code, 'search_unavailable');
});

test('검색: 같은 질의는 캐시에서 0ms 로 돌려준다', async () => {
  const fetchImpl = fetchStub([['nominatim.openstreetmap.org/search', () => json(NOMINATIM_SEARCH)]]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  await geocoder.search('강남역');
  const firstCalls = fetchImpl.calls.length;
  await geocoder.search('  강남역  ');
  assertEqual(fetchImpl.calls.length, firstCalls, '캐시를 쓰지 않았다');
  assertEqual(geocoder.stats.cached, 1);
});

test('검색: 캐시 TTL 이 지나면 다시 요청한다', async () => {
  let now = 1_000_000;
  const fetchImpl = fetchStub([['nominatim.openstreetmap.org/search', () => json(NOMINATIM_SEARCH)]]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, cacheTtlMs: 1000, now: () => now });
  await geocoder.search('강남역');
  const firstCalls = fetchImpl.calls.length;
  now += 2000;
  await geocoder.search('강남역');
  assertEqual(fetchImpl.calls.length, firstCalls + 1, 'TTL 이 지났는데 캐시를 썼다');
});

test('역주소: 늦은 응답은 타임아웃으로 끊고 Photon 으로 넘어간다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/reverse', (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })],
    ['photon.komoot.io/reverse', () => json(PHOTON_REVERSE)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, timeoutMs: 80 });
  const result = await geocoder.reverse({ lat: 37.4979, lng: 127.0276 });
  assertEqual(result.source, 'photon');
  assertEqual(result.text, '서울특별시 강남구 강남대로');
});

test('역주소: 모두 실패해도 예외 없이 빈 주소를 돌려준다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/reverse', () => { throw new Error('offline'); }],
    ['photon.komoot.io/reverse', () => { throw new Error('offline'); }],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const result = await geocoder.reverse({ lat: 37.5, lng: 127.0 });
  assertEqual(result.text, '');
  assert(result.error, '오류 코드가 없다');
});

test('역주소: 좌표가 없으면 네트워크를 쓰지 않는다', async () => {
  const fetchImpl = fetchStub([]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const result = await geocoder.reverse({ lat: 'x', lng: 1 });
  assertEqual(result.error, 'invalid_point');
  assertEqual(fetchImpl.calls.length, 0);
});

test('레이트 리미터: 역주소와 검색이 같은 큐를 쓴다', async () => {
  const events = [];
  const fetchImpl = async url => {
    events.push(Date.now());
    if (url.includes('/reverse')) return json({ address: { road: '테스트로' }, display_name: '테스트' });
    return json(NOMINATIM_SEARCH);
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 60 });
  await Promise.all([
    geocoder.reverse({ lat: 37.1, lng: 127.1 }),
    geocoder.search('강남역'),
  ]);
  assertEqual(events.length, 2);
  const gap = Math.abs(events[1] - events[0]);
  assert(gap >= 55, `두 요청 간격이 짧다: ${gap}ms`);
});

test('레이트 리미터: 실패해도 다음 작업이 막히지 않는다', async () => {
  const schedule = createRateLimiter(10);
  let error = null;
  try {
    await schedule(async () => { throw new Error('boom'); });
  } catch (err) {
    error = err;
  }
  assert(error);
  await sleep(15);
  assertEqual(await schedule(async () => 'ok'), 'ok');
});

/* ------------------------------------------------------------------
   P1-01 · Photon 언어
   Photon 은 default · de · en · fr 만 받는다. lang=ko 는 HTTP 400 이라
   대체 검색이 통째로 죽어 있었다 — 실제 요청 URL 로 고정한다.
   ------------------------------------------------------------------ */

test('Photon: lang=ko 가 아니라 lang=default 로 요청한다', async () => {
  assertEqual(PHOTON_LANG, 'default');
  assertEqual(GEOCODE_CACHE_TTL_MS, 30 * 60 * 1000, '메모리 캐시 TTL 을 30분으로 늘리지 않았다');
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => ({ ok: false, status: 503, json: async () => ({}) })],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 0 });
  await geocoder.search('강남역');
  const photonCall = fetchImpl.calls.find(call => call.url.includes('photon.komoot.io/api'));
  assert(photonCall, 'Photon 대체 검색을 부르지 않았다');
  assert(photonCall.url.includes('lang=default'), `Photon 언어가 default 가 아니다: ${photonCall.url}`);
  assert(!photonCall.url.includes('lang=ko'), `지원하지 않는 lang=ko 가 남아 있다: ${photonCall.url}`);
});

test('Photon 역주소도 lang=default 로 요청한다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/reverse', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['photon.komoot.io/reverse', () => json(PHOTON_REVERSE)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 0 });
  await geocoder.reverse({ lat: 37.4979, lng: 127.0276 });
  const call = fetchImpl.calls.find(item => item.url.includes('photon.komoot.io/reverse'));
  assert(call, 'Photon 역주소를 부르지 않았다');
  assert(call.url.includes('lang=default'), `Photon 역주소 언어가 default 가 아니다: ${call.url}`);
});

/* ------------------------------------------------------------------
   P2-05 · Nominatim 이 0건이어도 Photon 을 시도하고 결과를 합친다
   ------------------------------------------------------------------ */

test('검색: Nominatim 200 + [] 이면 Photon 도 묻는다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => json([])],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const rows = await geocoder.search('강남역');
  assertEqual(rows.length, 1, '빈 결과 뒤 Photon 결과를 쓰지 않았다');
  assertEqual(rows[0].source, 'photon');
  assertEqual(geocoder.stats.emptyFallbacks, 1);
});

test('검색: 두 제공자 결과를 좌표·이름으로 중복 제거해 합친다', () => {
  const nominatim = [
    { name: '강남역', address: '서울 강남구', lat: 37.4979, lng: 127.0276, source: 'nominatim' },
    { name: '역삼역', address: '서울 강남구', lat: 37.5006, lng: 127.0364, source: 'nominatim' },
  ];
  const photon = [
    { name: '강남역', address: '서울 강남구 강남대로', lat: 37.49792, lng: 127.02761, source: 'photon' },
    { name: '선릉역', address: '서울 강남구', lat: 37.5045, lng: 127.0490, source: 'photon' },
    { name: '강남역', address: '부산 강남역(동명)', lat: 35.1000, lng: 129.0000, source: 'photon' },
  ];
  const merged = mergeSearchRows(nominatim, photon);
  assertEqual(merged.length, 4, `중복 제거 결과가 다르다: ${merged.map(r => r.name).join(',')}`);
  assertEqual(merged[0].source, 'nominatim', '주 제공자 순서를 지키지 않았다');
  assertEqual(merged[3].lng, 129.0, '멀리 있는 동명 장소를 지워 버렸다');
});

test('검색: fallbackOnEmpty=false 면 0건일 때 Photon 을 부르지 않는다', async () => {
  const fetchImpl = fetchStub([['nominatim.openstreetmap.org/search', () => json([])]]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, fallbackOnEmpty: false });
  const rows = await geocoder.search('없는곳');
  assertEqual(rows.length, 0);
  assertEqual(fetchImpl.calls.length, 1);
  assertEqual(geocoder.stats.emptyFallbacks, 0);
});

test('검색: 0건은 짧게만 기억하고 결과가 있으면 길게 기억한다', async () => {
  let now = 1_000_000;
  let nominatimRows = [];
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => json(nominatimRows)],
    ['photon.komoot.io/api', () => json({ features: [] })],
  ]);
  const geocoder = createGeocoder({
    fetchImpl, minIntervalMs: 0, cacheTtlMs: 60_000, emptyTtlMs: 1_000, now: () => now,
  });
  await geocoder.search('사라진곳');
  const afterEmpty = fetchImpl.calls.length;
  now += 2_000;
  nominatimRows = NOMINATIM_SEARCH;
  await geocoder.search('사라진곳');
  assertEqual(fetchImpl.calls.length, afterEmpty + 1, '빈 결과를 너무 오래 캐시했다');
  const afterHit = fetchImpl.calls.length;
  now += 30_000;
  await geocoder.search('사라진곳');
  assertEqual(fetchImpl.calls.length, afterHit, '결과가 있는 질의를 다시 요청했다');
});

/* ------------------------------------------------------------------
   P1-02 · 요청량 절감 — 동시 중복 요청 병합
   ------------------------------------------------------------------ */

test('검색: 같은 질의가 동시에 오면 요청 하나를 함께 쓴다', async () => {
  let resolveSearch;
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return new Promise(resolve => { resolveSearch = () => resolve(json(NOMINATIM_SEARCH)); });
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const first = geocoder.search('강남역');
  const second = geocoder.search('강남역');
  await sleep(5);
  resolveSearch();
  const [a, b] = await Promise.all([first, second]);
  assertEqual(calls.length, 1, `동시 질의가 ${calls.length}번 나갔다`);
  assertEqual(geocoder.stats.coalesced, 1);
  assertEqual(a, b, '병합된 요청이 같은 결과를 주지 않았다');
});

/* ------------------------------------------------------------------
   P1-02 · 서버 프록시 주입 훅
   ------------------------------------------------------------------ */

test('프록시: proxyEndpoints 규약과 createGeocoder({ proxyUrl }) 주입', async () => {
  const endpoints = proxyEndpoints('https://hq.example/midpoint/geo/');
  assertEqual(endpoints[0].search, 'https://hq.example/midpoint/geo/nominatim/search');
  assertEqual(endpoints[0].reverse, 'https://hq.example/midpoint/geo/nominatim/reverse');
  assertEqual(endpoints[1].search, 'https://hq.example/midpoint/geo/photon/api');
  assertEqual(proxyEndpoints('')[0].search, 'https://nominatim.openstreetmap.org/search');

  const fetchImpl = fetchStub([['hq.example', () => json(NOMINATIM_SEARCH)]]);
  const geocoder = createGeocoder({ fetchImpl, proxyUrl: 'https://hq.example/midpoint/geo', minIntervalMs: 0 });
  await geocoder.search('강남역');
  assert(fetchImpl.calls[0].url.startsWith('https://hq.example/midpoint/geo/nominatim/search?'),
    `프록시를 쓰지 않았다: ${fetchImpl.calls[0].url}`);
});

test('프록시: 전역 HD2_GEOCODE_PROXY 만 채워도 프록시로 붙는다', async () => {
  const fetchImpl = fetchStub([['midpoint.test', () => json(NOMINATIM_SEARCH)]]);
  globalThis.HD2_GEOCODE_PROXY = 'https://midpoint.test/geo';
  try {
    const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
    await geocoder.search('강남역');
    assert(fetchImpl.calls[0].url.startsWith('https://midpoint.test/geo/nominatim/search?'),
      `전역 프록시를 쓰지 않았다: ${fetchImpl.calls[0].url}`);
  } finally {
    delete globalThis.HD2_GEOCODE_PROXY;
  }
});

/* ------------------------------------------------------------------
   P1-02 · 요청량 관리 — 429 쿨다운(제공자 자동 전환)·Retry-After·역주소 병합
   Nominatim 은 같은 앱에서 초당 1건을 넘기면 429 로 막는다. 한 번 막히면
   쿨다운 동안 Photon 을 먼저 쓰고, 끝나면 주 제공자로 돌아온다.
   ------------------------------------------------------------------ */

const tooMany = (retryAfter = '') => ({
  ok: false,
  status: 429,
  headers: { get: name => (String(name).toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: async () => ({}),
});

test('쿨다운: 429 뒤에는 Photon 을 먼저 쓰고 Nominatim 을 다시 부르지 않는다', async () => {
  let now = 1_000_000;
  let nominatimCalls = 0;
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => { nominatimCalls += 1; return tooMany(); }],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({
    fetchImpl, minIntervalMs: 0, retries: 0, cooldownMs: 60_000, now: () => now,
  });

  const first = await geocoder.search('강남역');
  assertEqual(first[0].source, 'photon');
  assertEqual(nominatimCalls, 1);
  assertEqual(geocoder.providerState().coolingDown, true, '429 뒤 쿨다운이 걸리지 않았다');

  const afterFirst = nominatimCalls;
  now += 5_000;
  const second = await geocoder.search('역삼역');
  assertEqual(nominatimCalls, afterFirst, '쿨다운 중인데 Nominatim 을 다시 불렀다');
  assertEqual(second[0].source, 'photon');
  assert(geocoder.stats.providerSwitches >= 1, '제공자 자동 전환 횟수가 기록되지 않았다');

  now += 60_000; // 쿨다운 만료 — 주 제공자를 다시 시도해야 한다
  await geocoder.search('선릉역');
  assertEqual(nominatimCalls, afterFirst + 1, '쿨다운이 끝났는데 Nominatim 을 다시 시도하지 않았다');
});

test('쿨다운: 연속 429 면 대기 시간이 2배씩 늘고 최대값을 넘지 않는다', async () => {
  let now = 1_000_000;
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => tooMany()],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({
    fetchImpl, minIntervalMs: 0, retries: 0, cooldownMs: 10_000, cooldownMaxMs: 25_000, now: () => now,
  });
  await geocoder.search('강남역');
  assertEqual(geocoder.providerState().remainingMs, 10_000);
  now += 10_000;
  await geocoder.search('역삼역');   // 쿨다운 만료 → 다시 429
  assertEqual(geocoder.providerState().remainingMs, 20_000);
  now += 20_000;
  await geocoder.search('선릉역');
  assertEqual(geocoder.providerState().remainingMs, 25_000, '쿨다운 최대값을 넘었다');
});

test('쿨다운: Retry-After 가 있으면 그 시간만큼 기다린다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => tooMany('120')],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 0, cooldownMs: 1_000 });
  await geocoder.search('강남역');
  assert(geocoder.providerState().remainingMs >= 119_000,
    `Retry-After 를 무시했다: ${geocoder.providerState().remainingMs}ms`);
});

test('Retry-After: 초 단위·HTTP 날짜를 모두 밀리초로 읽는다', () => {
  const header = value => ({ headers: { get: () => value } });
  assertEqual(retryAfterMsOf(header('30')), 30_000);
  assertEqual(retryAfterMsOf(header('')), 0);
  assertEqual(retryAfterMsOf({}), 0);
  const soon = new Date(Date.now() + 60_000).toUTCString();
  const parsed = retryAfterMsOf(header(soon));
  assert(parsed > 55_000 && parsed <= 60_000, `HTTP 날짜를 읽지 못했다: ${parsed}`);
});

test('역주소: 같은 좌표가 동시에 오면 요청 하나를 함께 쓴다', async () => {
  let calls = 0;
  let release;
  const fetchImpl = async () => {
    calls += 1;
    return new Promise(resolve => {
      release = () => resolve(json({ address: { road: '테스트로' }, display_name: '테스트로 1' }));
    });
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0 });
  const first = geocoder.reverse({ lat: 37.497912, lng: 127.027612 });
  const second = geocoder.reverse({ lat: 37.497912, lng: 127.027612 });
  await sleep(5);
  release();
  const [a, b] = await Promise.all([first, second]);
  assertEqual(calls, 1, `같은 좌표 역주소가 ${calls}번 나갔다`);
  assertEqual(geocoder.stats.coalesced, 1);
  assertEqual(a.text, b.text);
});

/* ------------------------------------------------------------------
   P2-05 · 0건과 장애를 구분하고, 역주소 0건도 대체 제공자를 확인한다
   ------------------------------------------------------------------ */

test('역주소: Nominatim 이 주소 없이 200 을 주면 Photon 역주소를 시도한다', async () => {
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/reverse', () => json({ error: 'Unable to geocode' })],
    ['photon.komoot.io/reverse', () => json(PHOTON_REVERSE)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 0 });
  const result = await geocoder.reverse({ lat: 37.4979, lng: 127.0276 });
  assertEqual(result.source, 'photon', '역주소 0건 뒤 Photon 을 쓰지 않았다');
  assertEqual(result.text, '서울특별시 강남구 강남대로');
  assert(fetchImpl.calls.some(call => call.url.includes('photon.komoot.io/reverse')));
});

test('역주소: 두 제공자 모두 주소가 없으면 no_result, 둘 다 실패하면 실패 코드', async () => {
  const emptyFetch = fetchStub([
    ['nominatim.openstreetmap.org/reverse', () => json({})],
    ['photon.komoot.io/reverse', () => json({ features: [] })],
  ]);
  const emptyGeocoder = createGeocoder({ fetchImpl: emptyFetch, minIntervalMs: 0, retries: 0 });
  const empty = await emptyGeocoder.reverse({ lat: 37.5, lng: 127.0 });
  assertEqual(empty.text, '');
  assertEqual(empty.error, 'no_result', `빈 응답을 장애와 구분하지 않았다: ${empty.error}`);

  const brokenFetch = fetchStub([
    ['nominatim.openstreetmap.org/reverse', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['photon.komoot.io/reverse', () => ({ ok: false, status: 503, json: async () => ({}) })],
  ]);
  const brokenGeocoder = createGeocoder({ fetchImpl: brokenFetch, minIntervalMs: 0, retries: 0 });
  const broken = await brokenGeocoder.reverse({ lat: 37.5, lng: 127.0 });
  assertEqual(broken.error, 'request_failed', `장애를 빈 응답으로 뭉갰다: ${broken.error}`);
});

/* ------------------------------------------------------------------
   P2-03 · 좌표 키 정밀도 — 역주소 캐시도 실시간 POI 캐시와 같은 6자리
   ------------------------------------------------------------------ */

test('좌표 키: 지오코더와 실시간 POI 캐시가 같은 6자리 표기를 쓴다', () => {
  assertEqual(coordKey(37.49791234, 127.02761234), '37.497912,127.027612');
  assertEqual(coordKey(37.49791234, 127.02761234), anchorCoordKey(37.49791234, 127.02761234));
  assert(coordKey(37.4979, 127.0276) !== coordKey(37.49795, 127.0276),
    '5m 이동을 같은 좌표 키로 뭉갰다 (4자리 키)');
});

/* ------------------------------------------------------------------
   WO-02 · 429 + Retry-After:120 — 대체 검색이 120초를 기다리지 않는다
   ------------------------------------------------------------------ */

test('WO-02: 429 + Retry-After 120초에도 Photon 결과가 곧바로 온다', async () => {
  const events = [];
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => {
      events.push({ url: 'nominatim', at: Date.now() });
      return tooMany('120');
    }],
    ['photon.komoot.io/api', () => {
      events.push({ url: 'photon', at: Date.now() });
      return json(PHOTON_SEARCH);
    }],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 1, cooldownMs: 60_000 });
  const started = Date.now();
  const rows = await geocoder.search('강남역');
  const elapsed = Date.now() - started;

  assertEqual(rows.length, 1);
  assertEqual(rows[0].source, 'photon');
  // 예전에는 Retry-After 120초를 그대로 기다려 대체 검색이 2분 뒤에야 나왔다.
  assert(elapsed < 2000, `429 대체 검색이 ${elapsed}ms 걸렸다 (120초 대기 의심)`);
  const nominatimCalls = events.filter(item => item.url === 'nominatim');
  const photonCalls = events.filter(item => item.url === 'photon');
  assertEqual(nominatimCalls.length, 1, `429 에서 ${nominatimCalls.length}번 두드렸다`);
  assertEqual(photonCalls.length, 1, 'Photon 대체 검색을 부르지 않았다');
  // Retry-After 는 Nominatim 재사용 제한 시각으로 남는다.
  const state = geocoder.providerState();
  assert(state.remainingMs >= 119_000, `Retry-After 를 쿨다운에 반영하지 않았다: ${state.remainingMs}ms`);
  assertEqual(state.cooldownStreak, 1);
});

test('WO-02: 429 가 쿨다운 중이면 대체 검색도 지연 없이 나간다', async () => {
  let now = 1_000_000;
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => tooMany('120')],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, retries: 1, now: () => now });
  await geocoder.search('강남역');
  now += 1_000;
  const started = Date.now();
  const rows = await geocoder.search('역삼역');
  assertEqual(rows[0].source, 'photon');
  assert(Date.now() - started < 1000, '쿨다운 중 검색이 늦어졌다');
  assertEqual(geocoder.providerState().coolingDown, true);
});

test('WO-02: 정상 복구 뒤 연속 실패 횟수가 0으로 돌아간다', async () => {
  let now = 1_000_000;
  let mode = '429';
  const fetchImpl = fetchStub([
    ['nominatim.openstreetmap.org/search', () => (mode === 'ok' ? json(NOMINATIM_SEARCH) : tooMany())],
    ['photon.komoot.io/api', () => json(PHOTON_SEARCH)],
  ]);
  const geocoder = createGeocoder({
    fetchImpl, minIntervalMs: 0, retries: 0, cooldownMs: 10_000, cooldownMaxMs: 100_000, now: () => now,
  });
  await geocoder.search('강남역');
  assertEqual(geocoder.providerState().cooldownStreak, 1);
  assertEqual(geocoder.providerState().remainingMs, 10_000);

  now += 10_000;          // 쿨다운 종료 → 주 제공자 정상 응답
  mode = 'ok';
  const rows = await geocoder.search('역삼역');
  assertEqual(rows[0].source, 'nominatim');
  assertEqual(geocoder.providerState().cooldownStreak, 0, '정상 응답 뒤에도 연속 실패 횟수가 남았다');
  assertEqual(geocoder.providerState().coolingDown, false);

  mode = '429';
  await geocoder.search('선릉역');
  assertEqual(geocoder.providerState().remainingMs, 10_000, '복구 뒤 첫 429 가 2배(20초)로 늘었다');
});

/* ------------------------------------------------------------------
   WO-04 · 장소 중복 판정 — 거리만이 아니라 이름·주소·좌표·식별자
   ------------------------------------------------------------------ */

test('WO-04: 20m 떨어진 다른 가게는 거리만으로 합치지 않는다', () => {
  const a = { name: '진미평양냉면', address: '서울 강남구 논현로 123', lat: 37.5000, lng: 127.0300 };
  const b = { name: '을지면옥', address: '서울 강남구 논현로 125', lat: 37.50018, lng: 127.0300 };
  const meters = metersApart(a, b);
  assert(meters > 5 && meters < 30, `테스트 좌표 거리가 ${meters.toFixed(1)}m 다`);
  assert(!isSameSearchPlace(a, b), '다른 가게를 같은 곳으로 합쳤다');
  assertEqual(mergeSearchRows([a], [b]).length, 2, '근접한 다른 장소가 사라졌다');
});

test('WO-04: 같은 건물(같은 주소)의 다른 가게도 각각 남는다', () => {
  const mallA = { name: '스시로', address: '서울 송파구 올림픽로 300', lat: 37.5145, lng: 127.1060 };
  const mallB = { name: '스타벅스 롯데월드몰점', address: '서울 송파구 올림픽로 300', lat: 37.51452, lng: 127.10602 };
  assertEqual(mergeSearchRows([mallA], [mallB]).length, 2, '같은 건물의 다른 가게를 합쳤다');
});

test('WO-04: 같은 이름이면 60m 안까지 같은 곳(제공자 중복 등록)', () => {
  const nominatim = { name: '강남역', address: '서울 강남구 강남대로 396', lat: 37.4979, lng: 127.0276 };
  const photon = { name: '강남역', address: '서울특별시 강남구 강남대로', lat: 37.49818, lng: 127.0276 };
  const meters = metersApart(nominatim, photon);
  assert(meters > 20 && meters < 60, `테스트 좌표 거리가 ${meters.toFixed(1)}m 다`);
  assertEqual(mergeSearchRows([nominatim], [photon]).length, 1);

  // 같은 이름이라도 100m 넘게 떨어져 있으면 다른 지점이다.
  const farBranch = { name: '강남역', address: '서울 강남구 테헤란로', lat: 37.4989, lng: 127.0276 };
  assertEqual(mergeSearchRows([nominatim], [farBranch]).length, 2, '100m 떨어진 동명 지점을 합쳤다');
});

test('WO-04: OSM 식별자가 같으면 이름 표기가 달라도 같은 곳', () => {
  const ko = { name: '광장시장 순희네빈대떡', lat: 37.5701, lng: 126.9997, id: 'osm:node/321' };
  const en = { name: 'Soonhee Bindaetteok', lat: 37.57032, lng: 126.99972, id: 'osm:node/321' };
  assertEqual(mergeSearchRows([ko], [en]).length, 1, '같은 OSM 객체를 두 번 보여 준다');
  const other = { name: '다른 집', lat: 37.5701, lng: 126.9997, id: 'osm:node/999' };
  assertEqual(mergeSearchRows([ko], [other]).length, 2, '식별자가 다른데 합쳤다');
});

/* ------------------------------------------------------------------
   WO-06 · 큐 관리 — 사용자 검색 우선 · 불필요한 역주소 취소
   ------------------------------------------------------------------ */

test('WO-06: 역주소 12건이 쌓여도 사용자 검색이 먼저 나간다 (지연 측정)', async () => {
  const order = [];
  const fetchImpl = async url => {
    order.push(url.includes('/reverse') ? 'reverse' : 'search');
    if (url.includes('/reverse')) {
      await sleep(20);
      return json({ address: { road: '테스트로' }, display_name: '테스트로 1' });
    }
    return json(NOMINATIM_SEARCH);
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 120 });
  const reverses = Array.from({ length: 12 }, (_, i) =>
    geocoder.reverse({ lat: 37.5 + i * 0.001, lng: 127.0 }));
  await sleep(30); // 첫 역주소가 진행 중, 나머지는 큐에 서 있다
  const started = Date.now();
  const rows = await geocoder.search('강남역');
  const searchMs = Date.now() - started;
  await Promise.all(reverses);

  assertEqual(rows.length, 1);
  assert(searchMs < 600, `검색이 역주소 12건 뒤로 밀렸다: ${searchMs}ms`);
  const searchIndex = order.indexOf('search');
  assert(searchIndex >= 0 && searchIndex <= 2,
    `검색이 ${searchIndex}번째로 나갔다 (역주소 12건 뒤)`);
});

test('WO-06: 우선순위가 없으면 역주소 12건 뒤로 밀린다 (비교 기준)', async () => {
  const schedule = createRateLimiter(50);
  const tasks = Array.from({ length: 12 }, () => schedule(async () => {
    await sleep(5);
    return 'reverse';
  }));
  await sleep(10);
  const started = Date.now();
  await schedule(async () => 'search');
  const fifoMs = Date.now() - started;
  await Promise.all(tasks);
  assert(fifoMs > 400, `FIFO 기준 지연이 의외로 짧다: ${fifoMs}ms (측정 기준이 흔들린다)`);
});

test('WO-06: 필요 없어진 역주소는 큐에서 빠져 네트워크를 쓰지 않는다', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    await sleep(20);
    return json({ address: { road: '테스트로' }, display_name: '테스트로 1' });
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 120 });
  const first = geocoder.reverse({ lat: 37.11, lng: 127.11 });
  const second = geocoder.reverse({ lat: 37.22, lng: 127.22 });
  const third = geocoder.reverse({ lat: 37.33, lng: 127.33 });
  await sleep(30);
  assert(geocoder.cancelReverse({ lat: 37.22, lng: 127.22 }), '대기 중인 역주소를 취소하지 못했다');
  assert(geocoder.cancelReverse('reverse:37.330000,127.330000'), '좌표 키로 취소하지 못했다');
  const results = await Promise.all([first, second, third]);
  const reverseCalls = calls.filter(url => url.includes('/reverse'));
  assertEqual(reverseCalls.length, 1, `취소했는데 ${reverseCalls.length}건이 나갔다`);
  assertEqual(results[1].error, 'cancelled');
  assertEqual(results[2].error, 'cancelled');
  assertEqual(geocoder.stats.cancelled, 2);
  assertEqual(geocoder.reverse({ lat: 37.22, lng: 127.22 }) instanceof Promise, true);
});

test('WO-06: 진행 중인 역주소도 끊고 취소 결과를 돌려준다', async () => {
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: 0, timeoutMs: 5000 });
  const pending = geocoder.reverse({ lat: 37.44, lng: 127.44 });
  await sleep(30);
  assert(geocoder.cancelReverse({ lat: 37.44, lng: 127.44 }));
  const result = await pending;
  assert(aborted, '진행 중인 요청을 끊지 않았다');
  assertEqual(result.error, 'cancelled');
});
