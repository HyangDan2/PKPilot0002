/* ==================================================================
   HD2Lab | Midpoint (PKPilot0002)
   geocode.js — 주소·장소 지오코딩 어댑터

   Nominatim 은 같은 앱에서 초당 1건을 넘기면 429 로 막는다. 그래서
   역주소(참가자 위치의 주소)와 주소 검색(참가자 추가)을 **한 큐**에
   세워 최소 간격을 지키고, 실패하면 Photon(다른 인프라)으로 넘긴다.

   - 하나의 레이트 리미터(기본 1.1초 간격)를 두 요청 종류가 함께 쓴다
   - 메모리 캐시 + TTL (같은 주소·같은 질의는 네트워크를 다시 쓰지 않는다)
   - 8초 타임아웃, 429·5xx 는 한 번 재시도
   - Nominatim 실패 시 Photon 대체 검색 → 그래도 실패하면 GeocodeError
   - 나중에 서버 프록시로 바꿀 때는 createGeocoder({ endpoints }) 만 갈아끼우면 된다
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

/** Nominatim 공개 인스턴스 예절 — 초당 1건을 넘기지 않는다. */
export const GEOCODE_MIN_INTERVAL_MS = 1100;
export const GEOCODE_TIMEOUT_MS = 8000;
export const GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000;

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
  const endpoints = options.endpoints || [NOMINATIM, PHOTON];
  const primary = endpoints[0];
  const fallback = endpoints[1] || null;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? GEOCODE_TIMEOUT_MS;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const cacheTtlMs = options.cacheTtlMs ?? GEOCODE_CACHE_TTL_MS;
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || createRateLimiter(options.minIntervalMs ?? GEOCODE_MIN_INTERVAL_MS);

  const cache = new Map();
  const stats = { requests: 0, cached: 0, failures: 0, fallbacks: 0 };

  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    stats.cached += 1;
    return hit.value;
  }

  function writeCache(key, value) {
    cache.set(key, { value, at: now() });
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
    const url = `${fallback.search}?q=${encodeURIComponent(query)}&lang=ko&limit=5`;
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
    const url = `${fallback.reverse}?lat=${Number(point.lat).toFixed(6)}&lon=${Number(point.lng).toFixed(6)}&lang=ko`;
    return requestJson(url, 'photon_reverse').then(data => {
      const feature = (data?.features || [])[0];
      return {
        text: describePhotonAddress(feature) || String(feature?.properties?.name || ''),
        name: String(feature?.properties?.name || ''),
        source: fallback.id,
      };
    });
  }

  /** 주소·장소 검색 — 실패하면 대체 어댑터 → 그래도 없으면 GeocodeError */
  async function search(rawQuery) {
    const query = normQuery(rawQuery);
    if (!query) return [];
    const key = `search:${query.toLowerCase()}`;
    const hit = readCache(key);
    if (hit) return hit;

    try {
      const rows = await searchNominatim(query);
      writeCache(key, rows);
      return rows;
    } catch (primaryError) {
      if (!fallback) throw primaryError;
      stats.fallbacks += 1;
      try {
        const rows = await searchPhoton(query);
        writeCache(key, rows);
        return rows;
      } catch (fallbackError) {
        throw new GeocodeError('search_unavailable', {
          code: 'search_unavailable',
          cause: fallbackError,
        });
      }
    }
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

/* 앱이 함께 쓰는 기본 인스턴스 — 역주소와 검색이 같은 큐를 공유한다 */
export const geocoder = createGeocoder();
