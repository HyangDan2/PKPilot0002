/* ==================================================================
   HD2Lab | Midpoint (PKPilot0002)
   geocode.js — 주소·장소 지오코딩 어댑터

   Nominatim 은 같은 앱에서 초당 1건을 넘기면 429 로 막는다. 그래서
   역주소(참가자 위치의 주소)와 주소 검색(참가자 추가)을 **한 큐**에
   세워 최소 간격을 지키고, 실패하면 Photon(다른 인프라)으로 넘긴다.

   - 하나의 레이트 리미터(기본 1.1초 간격)를 두 요청 종류가 함께 쓴다
   - 사용자가 직접 누른 주소 검색은 우선순위가 높아, 뒤에 쌓인 역주소 요청을
     건너뛰고 먼저 나간다 (참가자 12명 역주소가 검색을 13초 막지 않는다)
   - 더 필요 없어진 역주소 요청은 큐에서 빼거나 진행 중인 요청을 끊는다(cancelReverse)
   - 메모리 캐시 + TTL (같은 주소·같은 질의는 네트워크를 다시 쓰지 않는다)
   - 같은 질의·같은 좌표가 동시에 들어오면 요청 하나를 함께 쓴다 (in-flight 병합)
   - 8초 타임아웃, 5xx 만 지수 백오프로 한 번 재시도 (Retry-After 존중)
   - 429 는 재시도하지 않고 즉시 Photon 으로 넘긴다 — Retry-After(예: 120초)를
     기다리면 대체 검색이 그만큼 늦어진다
   - Nominatim 실패 시 Photon 대체 검색 → 그래도 실패하면 GeocodeError
   - Nominatim 이 '결과 없음'(HTTP 200 + [])을 주면 Photon 도 확인해 합친다
   - 429 를 받으면 쿨다운(기본 1분, 연속이면 2배씩 최대 10분, Retry-After 우선)
     동안 Photon 을 먼저 쓴다 — 요청량이 몰려도 매번 Nominatim 에 부딪히지 않는다
   - 주 제공자가 정상 응답하면 연속 실패 횟수(cooldownStreak)를 초기화한다
   - 좌표 키는 coordKey() 한 곳에서 만든다 (소수점 6자리 — 앱 저장소도 같은 키)
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
/** 429 를 받은 뒤 Photon 만 쓰는 시간 — 연속으로 막히면 2배씩 늘린다. */
export const GEOCODE_COOLDOWN_MS = 60 * 1000;
export const GEOCODE_COOLDOWN_MAX_MS = 10 * 60 * 1000;
/**
 * 좌표 키 — 캐시(역주소)·앱 주소 저장소·실시간 POI 캐시가 모두 이 규칙을 쓴다.
 * 소수점 6자리 ≈ 0.11m. 네 곳이 서로 다른 자릿수를 쓰면 같은 자리를 두 번 묻거나
 * 다른 자리의 주소를 재사용하게 된다.
 */
export const COORD_KEY_DIGITS = 6;
export function coordKey(lat, lng) {
  return `${Number(lat).toFixed(COORD_KEY_DIGITS)},${Number(lng).toFixed(COORD_KEY_DIGITS)}`;
}
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

/** 취소된 작업이 던지는 오류 — 사용자 입력이 바뀌어 필요 없어진 요청 */
export function cancelledError() {
  const error = new Error('cancelled');
  error.name = 'CancelError';
  error.cancelled = true;
  return error;
}

/** 요청 하나에 딸린 취소 토큰 — 큐 대기와 진행 중 요청(AbortController)을 함께 끊는다. */
function makeCancelToken() {
  const token = { cancelled: false, aborts: new Set() };
  token.cancel = () => {
    token.cancelled = true;
    for (const abort of [...token.aborts]) {
      try {
        abort();
      } catch {
        /* 이미 끝난 요청 */
      }
    }
    token.aborts.clear();
  };
  return token;
}

/**
 * 최소 간격 큐 — 앞선 작업이 끝난 뒤 간격을 채우고 다음 작업을 시작한다.
 * 테스트에서 간격을 짧게 줄 수 있도록 인자로 받는다.
 *
 * - `schedule(task, { priority: 'high' })` 는 아직 시작하지 않은 낮은 우선순위
 *   작업(역주소)을 건너뛰고 먼저 나간다. 진행 중인 요청은 끊지 않는다.
 * - 돌려준 promise 의 `cancel()` 은 아직 시작하지 않은 작업을 큐에서 뺀다.
 */
export function createRateLimiter(minIntervalMs = GEOCODE_MIN_INTERVAL_MS) {
  const queue = [];
  let running = false;
  let lastAt = 0;
  let seq = 0;

  const pump = () => {
    if (running) return;
    if (!queue.length) return;
    // 우선순위가 높은 작업 먼저, 같으면 들어온 순서대로 (FIFO)
    let pick = 0;
    for (let i = 1; i < queue.length; i += 1) {
      const ahead = queue[i];
      const best = queue[pick];
      if (ahead.priority > best.priority
        || (ahead.priority === best.priority && ahead.seq < best.seq)) pick = i;
    }
    const entry = queue.splice(pick, 1)[0];
    running = true;
    entry.started = true;
    const start = () => {
      lastAt = Date.now();
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          running = false;
          pump();
        });
    };
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastAt));
    if (wait) setTimeout(start, wait);
    else start();
  };

  const schedule = (task, options = {}) => {
    const entry = {
      task,
      priority: options.priority === 'high' ? 1 : 0,
      seq: (seq += 1),
      started: false,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    promise.cancel = () => {
      if (entry.started) return false;
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      entry.reject(cancelledError());
      return true;
    };
    queue.push(entry);
    pump();
    return promise;
  };
  schedule.pending = () => queue.length + (running ? 1 : 0);
  return schedule;
}

const normQuery = value => String(value ?? '').trim().replace(/\s+/g, ' ');

/** OSM 객체 식별자 — 두 제공자가 같은 객체를 가리키면 같은 곳이다. */
function osmRef(osmType, osmId) {
  const type = String(osmType || '').toLowerCase().trim();
  const id = Number(osmId);
  if (!type || !Number.isFinite(id)) return '';
  return `osm:${type}/${id}`;
}

function displayFromNominatim(item) {
  const display = String(item.display_name || '');
  const name = item.name || display.split(',')[0] || '';
  return {
    name: String(name).trim(),
    address: display.split(',').slice(0, 3).join(' ').trim(),
    lat: Number(item.lat),
    lng: Number(item.lon),
    source: NOMINATIM.id,
    id: osmRef(item.osm_type, item.osm_id) || (item.place_id ? `nominatim:${item.place_id}` : ''),
  };
}

/*
 * 검색 결과 중복 판정 — 거리만으로 합치지 않는다.
 * 같은 건물 안의 다른 가게(예: 같은 몰의 식당과 카페), 20m 떨어진 다른 분점은
 * 서로 다른 장소다. 그래서 식별자·이름·주소·좌표를 함께 본다.
 *   - OSM 식별자가 같으면 같은 곳 (거리와 무관)
 *   - 이름이 같으면 60m 안까지 같은 곳 (node·way 로 중복 등록된 같은 가게)
 *   - 한쪽 이름이 다른 이름을 포함하면 30m 안까지 (지점명이 덧붙은 경우)
 *   - 이름이 서로 다르면 거리만으로 합치지 않는다
 *   - 이름이 없거나 한쪽만 있으면 같은 지점(8m) + 같은 주소일 때만
 */
export const SAME_PLACE_METERS = 60;
export const SAME_CONTAINED_NAME_METERS = 30;
export const SAME_POINT_METERS = 8;

function nameKeyOf(row) {
  return String(row?.name || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function addressKeyOf(row) {
  return String(row?.address || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,·()'"-]+/g, '')
    .trim();
}

function degreesApart(a, b) {
  const lat = Math.abs(Number(a.lat) - Number(b.lat));
  const lng = Math.abs(Number(a.lng) - Number(b.lng)) * Math.cos((Number(a.lat) * Math.PI) / 180);
  return Math.hypot(lat, lng);
}

/** 두 결과 사이 거리(미터) */
export function metersApart(a, b) {
  return degreesApart(a, b) * 111320;
}

/** 두 검색 결과가 같은 장소인가 — 거리·이름·주소·식별자를 함께 본다. */
export function isSameSearchPlace(a, b) {
  if (!a || !b) return false;
  const idA = String(a.id || '').trim();
  const idB = String(b.id || '').trim();
  if (idA && idB && idA === idB) return true;

  const nameA = nameKeyOf(a);
  const nameB = nameKeyOf(b);
  const meters = metersApart(a, b);

  if (nameA && nameB) {
    if (nameA === nameB) return meters <= SAME_PLACE_METERS;
    const shorter = Math.min(nameA.length, nameB.length);
    if (shorter >= 3 && (nameA.includes(nameB) || nameB.includes(nameA))) {
      return meters <= SAME_CONTAINED_NAME_METERS;
    }
    // 이름이 다르면 같은 건물·같은 주소라도 다른 곳으로 남긴다.
    return false;
  }

  // 이름이 없거나 한쪽만 있는 결과 — 같은 지점이고 주소가 겹칠 때만 같은 곳
  const addressA = addressKeyOf(a);
  const addressB = addressKeyOf(b);
  if (meters > SAME_POINT_METERS) return false;
  return !addressA || !addressB || addressA === addressB;
}

/**
 * 두 제공자 결과를 식별자·이름·주소·좌표로 중복 제거해 합친다.
 * 앞쪽(주 제공자) 결과의 순서를 유지한다.
 */
export function mergeSearchRows(primaryRows = [], secondaryRows = []) {
  const merged = [];
  [...primaryRows, ...secondaryRows].forEach(row => {
    if (!row || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) return;
    const duplicate = merged.some(other => isSameSearchPlace(row, other));
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
    id: osmRef(props.osm_type, props.osm_id),
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
 * Retry-After 헤더 — 초 단위 숫자나 HTTP 날짜 둘 다 온다.
 * 헤더를 읽을 수 없는 모의 응답이면 0 (백오프 기본값을 쓴다).
 */
export function retryAfterMsOf(response) {
  try {
    const raw = response?.headers?.get ? response.headers.get('Retry-After') : '';
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  } catch {
    // 헤더 접근이 막힌 응답 — 기본 백오프로 넘긴다
  }
  return 0;
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
  const cooldownMs = options.cooldownMs ?? GEOCODE_COOLDOWN_MS;
  const cooldownMaxMs = options.cooldownMaxMs ?? GEOCODE_COOLDOWN_MAX_MS;
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || createRateLimiter(options.minIntervalMs ?? GEOCODE_MIN_INTERVAL_MS);

  const cache = new Map();
  const inflight = new Map();
  const reverseInflight = new Map();
  /** 진행 중·대기 중인 역주소 요청의 취소 토큰 (좌표 키별) */
  const reverseTokens = new Map();
  const stats = {
    requests: 0, cached: 0, failures: 0, fallbacks: 0, emptyFallbacks: 0, coalesced: 0,
    providerSwitches: 0, cooldowns: 0, cancelled: 0,
  };

  /* 주 제공자 쿨다운 — 429 를 받으면 잠시 Photon 을 먼저 쓴다. */
  let cooldownUntil = 0;
  let cooldownStreak = 0;
  const primaryReady = () => !fallback || now() >= cooldownUntil;

  function notePrimaryFailure(error) {
    if (!fallback || error?.code !== 'rate_limited') return;
    cooldownStreak += 1;
    const backoff = Math.min(cooldownMs * 2 ** (cooldownStreak - 1), cooldownMaxMs);
    const wait = Math.max(backoff, Number(error?.retryAfterMs) || 0);
    cooldownUntil = now() + wait;
    stats.cooldowns += 1;
  }

  /** 주 제공자가 정상 응답하면 연속 실패 횟수를 되돌린다 — 다음 429 는 다시 1분부터. */
  function notePrimarySuccess() {
    if (cooldownStreak !== 0 || cooldownUntil !== 0) {
      cooldownStreak = 0;
      cooldownUntil = 0;
    }
  }

  function providerState() {
    return {
      primary: primary.id,
      fallback: fallback?.id || '',
      coolingDown: !primaryReady(),
      cooldownUntil,
      cooldownStreak,
      remainingMs: Math.max(0, cooldownUntil - now()),
    };
  }

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

  /** 재시도 간격 — Retry-After 가 있으면 그 값을, 없으면 지수 백오프 + 약간의 흔들림. */
const RETRY_MAX_WAIT_MS = 10 * 1000;
  function waitForRetry(error, attempt) {
    const retryAfter = Number(error?.retryAfterMs) || 0;
    // 5xx 재시도가 서버의 긴 Retry-After 를 그대로 기다리면 화면이 멈춘 것처럼 보인다.
    if (retryAfter > 0) return Math.min(retryAfter, RETRY_MAX_WAIT_MS);
    const base = retryDelayMs * 2 ** Math.max(0, attempt - 1);
    return Math.round(base + base * 0.15 * Math.random());
  }

  /**
   * 한 번의 HTTP 요청 — 레이트 리미터·타임아웃·재시도 포함. 429 는 rateLimited 로 표시한다.
   * 429 는 재시도하지 않는다: Retry-After 를 기다리면 대체 제공자가 그만큼 늦어진다.
   * `priority:'high'` 는 사용자 직접 검색, `cancelToken` 은 필요 없어진 역주소 요청을 끊는다.
   */
  async function requestJson(url, label = 'geocode', requestOptions = {}) {
    const priority = requestOptions.priority === 'high' ? 'high' : 'low';
    const cancelToken = requestOptions.cancelToken || null;
    const stopped = () => Boolean(cancelToken?.cancelled);
    if (stopped()) throw cancelledError();
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await delay(waitForRetry(lastError, attempt));
        if (stopped()) throw cancelledError();
      }
      let queued = null;
      let controller = null;
      const onCancel = () => {
        try {
          queued?.cancel?.();
        } catch {
          /* 이미 끝난 작업 */
        }
        try {
          controller?.abort();
        } catch {
          /* 이미 끝난 요청 */
        }
      };
      if (cancelToken) cancelToken.aborts.add(onCancel);
      try {
        // 레이트 리미터 안에서 요청해야 재시도까지 최소 간격이 지켜진다.
        queued = schedule(async () => {
          if (stopped()) throw cancelledError();
          controller = new AbortController();
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
              error.retryAfterMs = retryAfterMsOf(response);
              throw error;
            }
            if (!response.ok) {
              const error = new Error(`HTTP ${response.status}`);
              // 5xx 는 잠깐 뒤 다시 해 볼 만한 실패다 (게이트웨이 과부하 등)
              error.serverError = response.status >= 500;
              error.retryAfterMs = retryAfterMsOf(response);
              throw error;
            }
            return await response.json();
          } finally {
            clearTimeout(timer);
          }
        }, { priority });
        return await queued;
      } catch (error) {
        if (stopped() || error?.cancelled) throw cancelledError();
        lastError = error;
        if (error && error.name === 'AbortError') {
          lastError = new GeocodeError('timeout', { code: 'timeout', cause: error });
        }
        // 429 는 기다리지 않고 바로 대체 제공자로 넘긴다.
        if (lastError?.rateLimited) break;
        // 5xx 만 다시 해 보고, 그 밖의 실패는 다음 어댑터로 넘긴다.
        if (!error?.serverError) break;
      } finally {
        cancelToken?.aborts.delete(onCancel);
      }
    }
    stats.failures += 1;
    const rateLimited = Boolean(lastError?.rateLimited);
    const thrown = new GeocodeError(label, {
      code: rateLimited ? 'rate_limited' : 'request_failed',
      cause: lastError,
    });
    thrown.retryAfterMs = Number(lastError?.retryAfterMs) || 0;
    thrown.rateLimited = rateLimited;
    throw thrown;
  }

  function searchNominatim(query, priority = 'high') {
    const url = `${primary.search}?format=jsonv2&q=${encodeURIComponent(query)}&limit=5&accept-language=ko&addressdetails=1`;
    return requestJson(url, 'nominatim_search', { priority }).then(data =>
      (Array.isArray(data) ? data : []).map(displayFromNominatim)
        .filter(row => row.name && Number.isFinite(row.lat) && Number.isFinite(row.lng)));
  }

  function searchPhoton(query, priority = 'high') {
    const url = `${fallback.search}?q=${encodeURIComponent(query)}&lang=${PHOTON_LANG}&limit=5`;
    return requestJson(url, 'photon_search', { priority }).then(data =>
      (data?.features || []).map(rowFromPhoton)
        .filter(row => row.name && Number.isFinite(row.lat) && Number.isFinite(row.lng)));
  }

  function reverseNominatim(point, cancelToken) {
    const [lat, lng] = coordKey(point.lat, point.lng).split(',');
    const url = `${primary.reverse}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=ko`;
    return requestJson(url, 'nominatim_reverse', { cancelToken }).then(data => ({
      text: describeNominatimAddress(data),
      name: String(data?.name || ''),
      source: primary.id,
    }));
  }

  function reversePhoton(point, cancelToken) {
    const [lat, lng] = coordKey(point.lat, point.lng).split(',');
    const url = `${fallback.reverse}?lat=${lat}&lon=${lng}&lang=${PHOTON_LANG}`;
    return requestJson(url, 'photon_reverse', { cancelToken }).then(data => {
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
    // 429 쿨다운 중이면 Nominatim 을 건너뛰고 Photon 부터 쓴다.
    const triedPrimary = primaryReady();
    if (triedPrimary) {
      try {
        rows = await searchNominatim(query, 'high');
        notePrimarySuccess();
      } catch (error) {
        primaryError = error;
        notePrimaryFailure(error);
      }
    } else {
      stats.providerSwitches += 1;
    }

    if (!fallback) {
      if (primaryError) throw primaryError;
      writeCache(key, rows, rows.length ? undefined : emptyTtlMs);
      return rows;
    }

    if (!triedPrimary || primaryError) {
      stats.fallbacks += 1;
      try {
        const photonRows = await searchPhoton(query, 'high');
        rows = triedPrimary ? photonRows : mergeSearchRows(rows, photonRows);
      } catch (fallbackError) {
        throw new GeocodeError('search_unavailable', {
          code: 'search_unavailable',
          cause: fallbackError,
        });
      }
    } else if (fallbackOnEmpty && rows.length === 0) {
      stats.emptyFallbacks += 1;
      try {
        rows = mergeSearchRows(rows, await searchPhoton(query, 'high'));
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
   * 같은 좌표가 동시에 들어오면 한 번의 요청을 함께 쓴다.
   */
  function reverse(point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      return Promise.resolve({ text: '', source: '', error: 'invalid_point' });
    }
    const key = `reverse:${coordKey(point.lat, point.lng)}`;
    const hit = readCache(key);
    if (hit) return Promise.resolve(hit);
    const pending = reverseInflight.get(key);
    if (pending) {
      stats.coalesced += 1;
      return pending;
    }
    const token = makeCancelToken();
    reverseTokens.set(key, token);
    const tracked = runReverse(point, key, token).finally(() => {
      if (reverseInflight.get(key) === tracked) reverseInflight.delete(key);
      if (reverseTokens.get(key) === token) reverseTokens.delete(key);
    });
    reverseInflight.set(key, tracked);
    return tracked;
  }

  /**
   * 더 필요 없어진 역주소 요청을 끊는다 (참가자를 지우거나 다른 자리로 끌었을 때).
   * 아직 큐에 서 있으면 큐에서 빼고, 이미 나갔으면 AbortController 로 중단한다.
   * 반환: 실제로 취소한 요청이 있었는지
   */
  function cancelReverse(target) {
    const key = typeof target === 'string'
      ? (target.startsWith('reverse:') ? target : `reverse:${target}`)
      : (target && Number.isFinite(Number(target.lat)) && Number.isFinite(Number(target.lng))
        ? `reverse:${coordKey(target.lat, target.lng)}`
        : '');
    if (!key) return false;
    const token = reverseTokens.get(key);
    if (!token) return false;
    token.cancel();
    reverseTokens.delete(key);
    reverseInflight.delete(key);
    stats.cancelled += 1;
    return true;
  }

  async function runReverse(point, key, cancelToken) {
    let lastError = null;
    let sawEmpty = false;
    let emptySource = '';
    // 429 쿨다운 중이면 Photon 역주소부터 쓴다.
    const adapters = [];
    if (primaryReady()) adapters.push([primary.id, () => reverseNominatim(point, cancelToken), true]);
    else stats.providerSwitches += 1;
    if (fallback) adapters.push([fallback.id, () => reversePhoton(point, cancelToken), false]);
    for (const [id, run, isPrimary] of adapters) {
      if (cancelToken?.cancelled) return { text: '', source: '', error: 'cancelled' };
      try {
        const result = await run();
        if (cancelToken?.cancelled) return { text: '', source: '', error: 'cancelled' };
        if (result.text) {
          if (isPrimary) notePrimarySuccess();
          writeCache(key, result);
          return result;
        }
        // 주소가 비어 온 경우(HTTP 200 인데 주소 없음)도 대체 제공자를 확인한다.
        sawEmpty = true;
        emptySource = result.source || id;
      } catch (error) {
        if (cancelToken?.cancelled || error?.cancelled) {
          return { text: '', source: '', error: 'cancelled' };
        }
        lastError = error;
        if (isPrimary) {
          notePrimaryFailure(error);
          if (fallback) stats.fallbacks += 1;
        }
      }
    }
    // 주소를 받은 제공자가 하나도 없을 때: 진짜 빈 응답(no_result)과 요청 실패를 구분한다.
    if (sawEmpty) return { text: '', source: emptySource, error: 'no_result' };
    return { text: '', source: '', error: lastError?.code || 'reverse_failed' };
  }

  return { search, reverse, cancelReverse, stats, cache, providerState };
}

/* 앱이 함께 쓰는 기본 인스턴스 — 역주소와 검색이 같은 큐를 공유한다.
   index.html 에서 globalThis.HD2_GEOCODE_PROXY 를 먼저 채우면 서버 프록시로 붙는다. */
export const geocoder = createGeocoder();
