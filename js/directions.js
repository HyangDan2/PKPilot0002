/* ==================================================================
   HD2Lab | Midpoint (PKPilot0002)
   directions.js — 실제 길찾기·내비게이션 딥링크 (카카오맵/네이버지도/티맵)
   ================================================================== */

const num = v => Number(v).toFixed(6).replace(/\.?0+$/, '');

/** 네이버지도 길찾기가 쓰는 웹 메르카토르 좌표 (EPSG:3857) */
export function webMercatorX(lng) {
  const R = 6378137.0;
  return R * (Number(lng) * Math.PI) / 180;
}

export function webMercatorY(lat) {
  const R = 6378137.0;
  const phi = (Number(lat) * Math.PI) / 180;
  return R * Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

function naverPin(name, lat, lng) {
  return `${webMercatorX(lng)},${webMercatorY(lat)},${encodeURIComponent(name || '')},,`;
}

export const isMobileDevice = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator?.userAgent || '');

export const isAndroid = () => /Android/i.test(navigator?.userAgent || '');
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator?.userAgent || '');

/* ------------------------------------------------------------------
   길찾기 링크 — { from: 출발지 | null(현위치), to: 목적지, mode }

   카카오맵 공식 규칙 (apis.map.kakao.com)
   - 앱 스킴: kakaomap://route?sp=위도,경도&ep=위도,경도&by=car|publictransit|foot
   - 웹 링크: https://map.kakao.com/link/by/{car|traffic|walk}/이름,위도,경도/이름,위도,경도
     (출발지가 없으면 https://map.kakao.com/link/to/이름,위도,경도 → 현위치 출발)
   이동 수단 코드는 앱 스킴과 웹 링크가 다르다 — 앱은 publictransit, 웹은 traffic.
   ------------------------------------------------------------------ */

/** 좌표 표기 — 위도,경도 (딜리미터 없이 반올림해 붙인다) */
const coord = point => `${num(point.lat)},${num(point.lng)}`;
const pin = point => `${encodeURIComponent(point.name || '')},${coord(point)}`;

/** 앱 스킴 이동 수단 코드 */
export const KAKAO_APP_BY = { car: 'car', transit: 'publictransit', walk: 'foot' };
/** 웹 링크 이동 수단 코드 */
export const KAKAO_WEB_MODE = { car: 'car', transit: 'traffic', walk: 'walk' };

function modeKey(travelMode) {
  return travelMode === 'car' ? 'car' : travelMode === 'walk' ? 'walk' : 'transit';
}

/** kakaomap:// 앱 길찾기 — 출발지·목적지 좌표를 모두 넘긴다. */
export function kakaoAppUrl({ from, to, travelMode = 'transit' }) {
  if (!to) return '';
  const by = KAKAO_APP_BY[modeKey(travelMode)];
  const dest = `ep=${coord(to)}&by=${by}`;
  // 출발지가 없으면 앱이 현위치를 출발지로 잡는다 (sp 생략)
  return from ? `kakaomap://route?sp=${coord(from)}&${dest}` : `kakaomap://route?${dest}`;
}

/** 앱 미설치·데스크톱 대체 경로 — 카카오맵 웹 길찾기 */
export function kakaoWebRouteUrl({ from, to, travelMode = 'transit' }) {
  if (!to) return 'https://map.kakao.com/';
  if (!from) return `https://map.kakao.com/link/to/${pin(to)}`;
  const mode = KAKAO_WEB_MODE[modeKey(travelMode)];
  return `https://map.kakao.com/link/by/${mode}/${pin(from)}/${pin(to)}`;
}

/**
 * 참가자별 길찾기 버튼이 쓰는 입구.
 * 모바일은 앱 스킴(카카오내비·카카오맵 앱), PC는 웹 길찾기로 보낸다.
 */
export function kakaoMapUrl({ from, to, travelMode = 'transit' }) {
  if (!isMobileDevice()) return kakaoWebRouteUrl({ from, to, travelMode });
  return kakaoAppUrl({ from, to, travelMode });
}

export function naverDirectionsUrl({ from, to, travelMode = 'transit' }) {
  const type = travelMode === 'car' ? 'car' : travelMode === 'walk' ? 'walk' : 'transit';
  const start = from ? naverPin(from.name, from.lat, from.lng) : '-';
  return `https://map.naver.com/p/directions/${start}/${naverPin(to.name, to.lat, to.lng)}/${type}`;
}

/** 카카오맵 웹 길찾기 — 도보 경로로 열린다. */
export function kakaoWalkRouteUrl({ from, to }) {
  return kakaoWebRouteUrl({ from, to, travelMode: 'walk' });
}

/** 티맵 — 앱 스킴만 있다. 출발지를 함께 넘겨야 목적지까지 바로 계산된다. */
export function tmapRouteUrl({ from, to }) {
  if (!to) return '';
  const parts = [];
  if (from) {
    parts.push(`startname=${encodeURIComponent(from.name || '출발')}`);
    parts.push(`startx=${num(from.lng)}`);
    parts.push(`starty=${num(from.lat)}`);
  }
  parts.push(`goalname=${encodeURIComponent(to.name || '목적지')}`);
  parts.push(`goalx=${num(to.lng)}`);
  parts.push(`goaly=${num(to.lat)}`);
  return `tmap://route?${parts.join('&')}`;
}

export const PROVIDERS = {
  kakao: {
    label: '카카오맵',
    carLabel: '카카오내비',
    icon: 'i-nav-kakao',
    web: kakaoWebRouteUrl,
    app: kakaoMapUrl,
    appScheme: 'kakaomap://',
    appOnly: false,
  },
  naver: {
    label: '네이버지도',
    carLabel: '네이버지도',
    icon: 'i-nav-naver',
    web: naverDirectionsUrl,
    app: naverDirectionsUrl,
    appOnly: false,
  },
  tmap: {
    label: '티맵',
    carLabel: '티맵내비',
    icon: 'i-nav-tmap',
    web: null,          // 앱 스킴만 있다 — 모바일에서 카카오·네이버 웹 링크로 대체한다
    app: tmapRouteUrl,
    appScheme: 'tmap://',
    appOnly: true,
  },
};

/** 모드에 맞는 제공자 목록 (대중교통: 카카오맵·네이버지도, 자차: 카카오내비·네이버지도·티맵) */
export function providerList(travelMode) {
  return travelMode === 'car'
    ? ['kakao', 'naver', 'tmap']
    : ['kakao', 'naver'];
}

/**
 * 앱 스킴만 있는 제공자(티맵)의 웹 대체 길찾기.
 * 티맵 앱이 없으면 자동차 경로를 아는 카카오맵 웹 길찾기로 넘긴다.
 */
export function appFallbackWebUrl(key, { from, to, travelMode = 'transit' } = {}) {
  const provider = PROVIDERS[key];
  if (!provider) return '';
  if (provider.web) return provider.web({ from, to, travelMode });
  return kakaoWebRouteUrl({ from, to, travelMode: travelMode === 'car' ? 'car' : travelMode });
}

/** 앱 스킴 링크인지 (웹 링크·일반 https 는 대체 경로가 필요 없다) */
export function isAppSchemeUrl(key, url) {
  const scheme = PROVIDERS[key]?.appScheme;
  return Boolean(scheme) && String(url || '').startsWith(scheme);
}

/* ------------------------------------------------------------------
   장소 검색 딥링크 — 등록 POI가 없는 거점의 fallback
   "강남역 맛집" 처럼 검색어를 만들어 지도 앱/웹 검색으로 넘긴다.
   ------------------------------------------------------------------ */

export const PLACE_KIND_LABEL = {
  restaurant: '맛집',
  cafe: '카페',
  dessert: '디저트 카페',
  brunch: '브런치',
};

/** '강남역 맛집' — 거점 이름 + 종류 */
export function placeSearchQuery(spotName, kind = 'restaurant') {
  const label = PLACE_KIND_LABEL[kind] || PLACE_KIND_LABEL.restaurant;
  const base = String(spotName || '').trim();
  return base ? `${base} ${label}` : label;
}

/** 네이버지도·카카오맵 검색 결과로 바로 넘기는 링크 */
export function placeSearchUrl(provider, query) {
  const q = encodeURIComponent(String(query || '').trim());
  if (provider === 'naver') return `https://map.naver.com/p/search/${q}`;
  return `https://map.kakao.com/link/search/${q}`;
}
