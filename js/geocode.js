/* ==================================================================
   HD2Lab | Midpoint (PKPilot0002)
   geocode.js — 주소·장소 지오코딩 어댑터

   Nominatim 은 같은 앱에서 초당 1건을 넘기면 429 로 막는다. 그래서
   역주소(참가자 위치의 주소)와 주소 검색(참가자 추가)을 **한 큐**에
   세워 최소 간격을 지키고, 실패하면 Photon(다른 인프라)으로 넘긴다.

   - 하나의 레이트 리미터(기본 1.1초 간격)를 두 요청 종류가 함께 쓴다
   - 메모리 캐시 + TTL (같은 주소·같은 질의는 네트워크를 다시 쓰지 않는다)
   - 같은 질의가 동시에 들어오면 요청 하나를 함께 쓴다 (in-flight 병합)
   - 8초 타임아웃, 429·5xx 는 한 번 재시도
   - Nominatim 실패 시 Photon 대체 검색 → 그래도 실패하면 GeocodeError
   - Nominatim 이 '결과 없음'(HTTP 200 + [])을 주면 Photon 도 확인해 합친다
   - 서버 프록시로 바꿀 때는 createGeocoder({ proxyUrl }) 또는 전역
     globalThis.HD2_GEOCODE_PROXY 하나로 갈아끼우면 된다 (proxyEndpoints 참고)
   ================================================================== */

export const NOMINATIM = {
  id: 'nominatim',
  search: 'https://nominatim.openstreetmap.org/search',
  reverse: 'https://nominatim.openstreetmap.org/reverse',
};

export const PHOTON = {
  id: 'photon',
  search: 'https://photon.komoot.io/api/',
  reverse: 'https://photon.komoot.io/reverse',
};

/**
 * Photon 이 받는 언어는 default · de · en · fr 뿐이다.
 * lang=ko 를 보내면 HTTP 400(Language is not supported)으로 거절당해
 * 대체 검색이 아예 동작하지 않았다. default 는 OSM 의 현지어 이름을 준다
 * — 한국 장소는 '강남역'처럼 한국어로 돌아온다.
 */
export const PHOTON_LANG = 'default';

/** Nominatim 공개 인스턴스 예절 — 초당 1건을 넘기지 않는다. */
export const GEOCODE_MIN_INTERVAL_MS = 1100;
export const GEOCODE_TIMEOUT_MS = 8000;
/** 같은 질의·같은 좌표는 30분 동안 다시 묻지 않는다 (서버 요청량 절감) */
export const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
/** '결과 없음'은 금방 낡을 수 있으니 짧게만 기억한다 */
export const GEOCODE_EMPTY_TTL_MS = 2 * 60 * 1000;

/**
 * 서버 프록시 경로 규약 (예: Server-HQ 의 /midpoint/geo).
 *   {base}/nominatim/search?…  → https://nominatim.openstreetmap.org/search?…
 *   {base}/nominatim/reverse?… → https://nominatim.openstreetmap.org/reverse?…
 *   {base}/photon/api?…        → https://photon.komoot.io/api/?…
 *   {base}/photon/reverse?…    → https://photon.komoot.io/reverse?…
 * 프록시가 캐시·전역 레이트 리미터를 대신 지켜 주면 클라이언트 쪽 큐는 그대로 둔 채
 * 트래픽만 서버로 옮길 수 있다.
 */
export function proxyEndpoints(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return [NOMINATIM, PHOTON];
  return [
    { id: NOMINATIM.id, search: `${base}/nominatim/search`, reverse: `${base}/nominatim/reverse` },
    { id: PHOTON.id, search: `${base}/photon/api`, reverse: `${base}/photon/reverse` },
  ];
}

/** 주입된 프록시가 있으면 그쪽 엔드포인트를, 없으면 공개 인스턴스를 쓴다. */
function resolveEndpoints(options) {
  if (options.endpoints) return options.endpoints;
  const injected = options.proxyUrl
    || (typeof globalThis !== 'undefined' ? globalThis.HD2_GEOCODE_PROXY : '');
  return proxyEndpoints(injected);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GeocodeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GeocodeError';
    this.code = options.code || 'geocode_failed';
    this.cause = options.cause || null;
  }
}

/**
 * 최소 간격 큐 — 앞선 작업이 끝난 뒤 간격을 채우고 다음 작업을 시작한다.
 * 테스트에서 간격을 짧게 줄 수 있도록 인자로 받는다.
 */
export function createRateLimiter(minIntervalMs = GEOCODE_MIN_INTERVAL_MS) {
  let chain = Promise.resolve();
  let lastAt = 0;
  let queued = 0;

  const schedule = task => {
    queued += 1;
    const run = chain.then(async () => {
      const wait = Math.max(0, minIntervalMs - (Date.now() - lastAt));
      if (wait) await delay(wait);
      lastAt = Date.now();
      return task();
    });
    chain = run.then(() => {}, () => {}).then(() => {
      queued -= 1;
    });
    return run;
  };
  schedule.pending = () => queued;
  return schedule;
}

const normQuery = value => String(value ?? '').trim().replace(/\s+/g, ' ');

function displayFromNominatim(item) {
  const display = String(item.display_name || '');
  const name = item.name || display.split(',')[0] || '';
  return {
    name: String(name).trim(),
    address: display.split(',').slice(0, 3).join(' ').trim(),
    lat: Number(item.lat),
    lng: Number(item.lon),
    source: NOMINATIM.id,
  };
}

/** 검색 결과 중복 판정 — 같은 좌표(약 33m) 또는 같은 이름이 가까이(약 220m) 있으면 같은 곳 */
const SAME_PLACE_DEG = 0.0003;
const SAME_NAME_DEG = 0.002;

function nameKeyOf(row) {
  return String(row?.name || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function degreesApart(a, b) {
  const lat = Math.abs(Number(a.lat) - Number(b.lat));
  const lng = Math.abs(Number(a.lng) - Number(b.lng)) * Math.cos((Number(a.lat) * Math.PI) / 180);
  return Math.hypot(lat, lng);
}

/**
 * 두 제공자 결과를 좌표·이름 기준으로 중복 제거해 합친다.
 * 앞쪽(주 제공자) 결과의 순서를 유지한다.
 */
export function mergeSearchRows(primaryRows = [], secondaryRows = []) {
  const merged = [];
  [...primaryRows, ...secondaryRows].forEach(row => {
    if (!row || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) return;
    const name = nameKeyOf(row);
    const duplicate = merged.some(other => {
      if (degreesApart(row, other) <= SAME_PLACE_DEG) return true;
      return Boolean(name) && name === nameKeyOf(other) && degreesApart(row, other) <= SAME_NAME_DEG;
    });
    if (!duplicate) merged.push(row);
  });
  return merged;
}

function rowFromPhoton(feature) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  const parts = [props.name, props.street, props.district, props.city, props.state]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  const name = props.name || props.street || props.city || '';
  return {
    name: String(name || '').trim(),
    address: parts.join(' ').trim(),
    lat,
    lng,
    source: PHOTON.id,
  };
}

/** Photon 역주소 → '도시 구 동네 도로' 사람이 읽는 한 줄 */
export function describePhotonAddress(feature) {
  const props = feature?.properties || {};
  const city = props.city || props.state || '';
  const district = props.district || props.county || '';
  const block = props.locality || props.suburb || props.neighbourhood || '';
  const road = props.street || props.name || '';
  const parts = [city, district, block, road]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  return parts.join(' ');
}

/** Nominatim 역주소 응답 → '도시 구 동네 도로' (app.js 가 쓰던 규칙 그대로) */
export function describeNominatimAddress(data) {
  if (!data) return '';
  const a = data.address || {};
  const city = a.city || a.province || a.state || '';
  const district = a.borough || a.county || a.city_district || a.district || '';
  const block = a.suburb || a.quarter || a.neighbourhood || a.town || a.village || '';
  const road = a.road || a.pedestrian || a.residential || '';
  const parts = [city, district, block, road].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const joined = parts.join(' ');
  if (joined) return joined;
  return (data.name || data.display_name || '').split(',').slice(0, 2).join(', ').trim();
}

/**
 * 지오코더 인스턴스. 테스트·서버 전환을 위해 의존성을 모두 주입받는다.
 *   fetchImpl, schedule(레이트 리미터), timeoutMs, retries, cacheTtlMs, now, endpoints
 */
export function createGeocoder(options = {}) {
  const endpoints = resolveEndpoints(options);
  const primary = endpoints[0];
  const fallback = endpoints[1] || null;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? GEOCODE_TIMEOUT_MS;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const cacheTtlMs = options.cacheTtlMs ?? GEOCODE_CACHE_TTL_MS;
  const emptyTtlMs = options.emptyTtlMs ?? GEOCODE_EMPTY_TTL_MS;
  const fallbackOnEmpty = options.fallbackOnEmpty !== false;
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || createRateLimiter(options.minIntervalMs ?? GEOCODE_MIN_INTERVAL_MS);

  const cache = new Map();
  const inflight = new Map();
  const stats = { requests: 0, cached: 0, failures: 0, fallbacks: 0, emptyFallbacks: 0, coalesced: 0 };

  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    const ttl = Number.isFinite(hit.ttl) ? hit.ttl : cacheTtlMs;
    if (now() - hit.at > ttl) {
      cache.delete(key);
      return null;
    }
    stats.cached += 1;
    return hit.value;
  }

  function writeCache(key, value, ttl) {
    cache.set(key, { value, at: now(), ttl });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  /** 한 번의 HTTP 요청 — 레이트 리미터·타임아웃·재시도 포함. 429 는 rateLimited 로 표시한다. */
  async function requestJson(url, label = 'geocode') {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await delay(retryDelayMs * attempt);
      try {
        // 레이트 리미터 안에서 요청해야 재시도까지 최소 간격이 지켜진다.
        const payload = await schedule(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            stats.requests += 1;
            const response = await fetchImpl(url, {
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            });
            if (response.status === 429) {
              const error = new Error('HTTP 429');
              error.rateLimited = true;
              throw error;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          } finally {
            clearTimeout(timer);
          }
        });
        return payload;
      } catch (error) {
        lastError = error;
        if (error && error.name === 'AbortError') {
          lastError = new GeocodeError('timeout', { code: 'timeout', cause: error });
        }
        // 429 가 아니면 재시도해도 같은 결과일 가능성이 크다 — 다음 어댑터로 넘긴다.
        if (!error?.rateLimited) break;
      }
    }
    stats.failures += 1;
    throw new GeocodeError(label, { code: lastError?.rateLimited ? 'rate_limited' : 'request_failed', cause: lastError });
  }

  function searchNominatim(query) {
    const url = `${primary.search}?format=jsonv2&q=${encodeURIComponent(query)}&limit=5&accept-language=ko&addressdetails=1`;
    return requestJson(url, 'nominatim_search').then(data =>
      (Array.isArray(data) ? data : []).map(displayFromNominatim)
        .filter(row => row.name && Number.isFinite(row.lat) && Number.isFinite(row.lng)));
  }

  function searchPhoton(query) {
    const url = `${fallback.search}?q=${encodeURIComponent(query)}&lang=${PHOTON_LANG}&limit=5`;
    return requestJson(url, 'photon_search').then(data =>
      (data?.features || []).map(rowFromPhoton)
        .filter(row => row.name && Number.isFinite(row.lat) && Number.isFinite(row.lng)));
  }

  function reverseNominatim(point) {
    const url = `${primary.reverse}?format=jsonv2&lat=${Number(point.lat).toFixed(6)}&lon=${Number(point.lng).toFixed(6)}&zoom=18&addressdetails=1&accept-language=ko`;
    return requestJson(url, 'nominatim_reverse').then(data => ({
      text: describeNominatimAddress(data),
      name: String(data?.name || ''),
      source: primary.id,
    }));
  }

  function reversePhoton(point) {
    const url = `${fallback.reverse}?lat=${Number(point.lat).toFixed(6)}&lon=${Number(point.lng).toFixed(6)}&lang=${PHOTON_LANG}`;
    return requestJson(url, 'photon_reverse').then(data => {
      const feature = (data?.features || [])[0];
      return {
        text: describePhotonAddress(feature) || String(feature?.properties?.name || ''),
        name: String(feature?.properties?.name || ''),
        source: fallback.id,
      };
    });
  }

  /**
   * 실제 검색 한 번 — 주 제공자 → (실패 또는 0건이면) 대체 제공자.
   * Nominatim 은 모르는 질의에도 예외 없이 HTTP 200 + [] 를 주므로,
   * '0건'도 대체 제공자를 확인해야 한국어 장소를 놓치지 않는다.
   */
  async function performSearch(query, key) {
    let rows = [];
    let primaryError = null;
    try {
      rows = await searchNominatim(query);
    } catch (error) {
      primaryError = error;
    }

    if (!fallback) {
      if (primaryError) throw primaryError;
      writeCache(key, rows, rows.length ? undefined : emptyTtlMs);
      return rows;
    }

    if (primaryError) {
      stats.fallbacks += 1;
      try {
        rows = await searchPhoton(query);
      } catch (fallbackError) {
        throw new GeocodeError('search_unavailable', {
          code: 'search_unavailable',
          cause: fallbackError,
        });
      }
    } else if (fallbackOnEmpty && rows.length === 0) {
      stats.emptyFallbacks += 1;
      try {
        rows = mergeSearchRows(rows, await searchPhoton(query));
      } catch {
        // 대체 검색이 실패해도 '결과 없음'이라는 주 결과는 그대로 유효하다
      }
    }

    writeCache(key, rows, rows.length ? undefined : emptyTtlMs);
    return rows;
  }

  /** 주소·장소 검색 — 실패하면 대체 어댑터 → 그래도 없으면 GeocodeError */
  function search(rawQuery) {
    const query = normQuery(rawQuery);
    if (!query) return Promise.resolve([]);
    const key = `search:${query.toLowerCase()}`;
    const hit = readCache(key);
    if (hit) return Promise.resolve(hit);
    // 같은 질의가 이미 날아가 있으면 그 요청을 함께 쓴다 — 서버에 두 번 묻지 않는다
    const pending = inflight.get(key);
    if (pending) {
      stats.coalesced += 1;
      return pending;
    }
    const tracked = performSearch(query, key).finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  /**
   * 역주소 — 실패해도 던지지 않고 { text:'', source, error } 로 돌려준다.
   * (목록 UI 는 주소가 비어도 좌표로 계속 쓸 수 있어야 한다)
   */
  async function reverse(point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      return { text: '', source: '', error: 'invalid_point' };
    }
    const key = `reverse:${Number(point.lat).toFixed(4)},${Number(point.lng).toFixed(4)}`;
    const hit = readCache(key);
    if (hit) return hit;

    let lastError = null;
    const adapters = [[primary.id, () => reverseNominatim(point)]];
    if (fallback) adapters.push([fallback.id, () => reversePhoton(point)]);
    for (const [id, run] of adapters) {
      try {
        const result = await run();
        if (result.text) writeCache(key, result);
        return result;
      } catch (error) {
        lastError = error;
        if (id === primary.id && fallback) stats.fallbacks += 1;
      }
    }
    return { text: '', source: '', error: lastError?.code || 'reverse_failed' };
  }

  return { search, reverse, stats, cache };
}

/* 앱이 함께 쓰는 기본 인스턴스 — 역주소와 검색이 같은 큐를 공유한다.
   index.html 에서 globalThis.HD2_GEOCODE_PROXY 를 먼저 채우면 서버 프록시로 붙는다. */
export const geocoder = createGeocoder();
