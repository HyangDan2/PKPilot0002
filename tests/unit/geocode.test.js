/* ==================================================================
   PKPilot0002 단위 테스트 — 지오코딩 어댑터 (js/geocode.js)

   역주소와 주소 검색이 하나의 레이트 리미터를 쓰는지, 429·타임아웃에서
   Photon 으로 넘어가는지, 캐시가 TTL 을 지키는지 확인한다.
   ================================================================== */

import {
  createGeocoder,
  createRateLimiter,
  describeNominatimAddress,
  describePhotonAddress,
} from '../../js/geocode.js';
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

test('검색: 429 면 재시도 뒤 Photon 으로 넘어간다', async () => {
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
  assertEqual(nominatimCalls, 2, '429 에서 한 번 재시도하지 않았다');
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
