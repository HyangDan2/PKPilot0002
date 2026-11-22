/* ==================================================================
   PKPilot0002 단위 테스트 — 길찾기 딥링크 (js/directions.js)

   카카오맵은 공식 URL Scheme 규칙을 따른다.
   - 앱: kakaomap://route?sp=위도,경도&ep=위도,경도&by=car|publictransit|foot
   - 웹: https://map.kakao.com/link/by/{car|traffic|walk}/이름,위도,경도/이름,위도,경도
   ================================================================== */

import {
  PROVIDERS,
  appFallbackWebUrl,
  isAppSchemeUrl,
  kakaoAppUrl,
  kakaoWalkRouteUrl,
  kakaoWebRouteUrl,
  naverDirectionsUrl,
  placeSearchQuery,
  placeSearchUrl,
  providerList,
  tmapRouteUrl,
} from '../../js/directions.js';
import { assert, assertClose, assertEqual, test } from './harness.js';

const FROM = { name: '서울역', lat: 37.5558, lng: 126.9720 };
const TO = { name: '강남역', lat: 37.4979, lng: 127.0276 };

/** 쿼리 문자열을 안전하게 꺼낸다 (이름은 인코딩되어 있다) */
function queryOf(url) {
  const index = url.indexOf('?');
  const out = new Map();
  if (index < 0) return out;
  for (const segment of url.slice(index + 1).split('&')) {
    const eq = segment.indexOf('=');
    const key = eq < 0 ? segment : segment.slice(0, eq);
    const value = eq < 0 ? '' : segment.slice(eq + 1);
    out.set(key, decodeURIComponent(value));
  }
  return out;
}

/* ------------------------------------------------------------------
   카카오맵 앱 스킴 — 공식 규칙
   ------------------------------------------------------------------ */
test('카카오 앱: 출발지·목적지 좌표와 공식 이동 수단 코드를 넘긴다', () => {
  const url = kakaoAppUrl({ from: FROM, to: TO, travelMode: 'transit' });
  assert(url.startsWith('kakaomap://route?'), url);
  const q = queryOf(url);
  assertEqual(q.get('sp'), '37.5558,126.972');
  assertEqual(q.get('ep'), '37.4979,127.0276');
  assertEqual(q.get('by'), 'publictransit');
  // 잘못된 예전 형식(/link/urlroute, 빈 sp)이 남지 않는다
  assert(!url.includes('/link/'), url);
  assert(!url.includes('sp=&'), url);
});

test('카카오 앱: 자동차는 car, 도보는 foot', () => {
  assertEqual(queryOf(kakaoAppUrl({ from: FROM, to: TO, travelMode: 'car' })).get('by'), 'car');
  assertEqual(queryOf(kakaoAppUrl({ from: FROM, to: TO, travelMode: 'walk' })).get('by'), 'foot');
});

test('카카오 앱: 출발지가 없으면 sp 를 빼고 현위치 출발로 둔다', () => {
  const url = kakaoAppUrl({ from: null, to: TO });
  const q = queryOf(url);
  assert(!q.has('sp'), url);
  assertEqual(q.get('ep'), '37.4979,127.0276');
  assertEqual(kakaoAppUrl({ from: FROM, to: null }), '');
});

/* ------------------------------------------------------------------
   카카오맵 웹 링크 — 공식 규칙
   ------------------------------------------------------------------ */
test('카카오 웹: /link/by/{이동수단}/출발지/목적지 형태', () => {
  const transit = kakaoWebRouteUrl({ from: FROM, to: TO, travelMode: 'transit' });
  assertEqual(
    transit,
    'https://map.kakao.com/link/by/traffic/%EC%84%9C%EC%9A%B8%EC%97%AD,37.5558,126.972/%EA%B0%95%EB%82%A8%EC%97%AD,37.4979,127.0276',
  );
  const car = kakaoWebRouteUrl({ from: FROM, to: TO, travelMode: 'car' });
  assert(car.includes('/link/by/car/'), car);
  assert(car.includes('37.5558,126.972'), '출발지 좌표가 빠졌다');
  assert(car.includes('37.4979,127.0276'), '목적지 좌표가 빠졌다');
});

test('카카오 웹: 도보 길찾기는 /link/by/walk', () => {
  const walk = kakaoWalkRouteUrl({ from: FROM, to: TO });
  assert(walk.startsWith('https://map.kakao.com/link/by/walk/'), walk);
  assert(walk.includes('37.4979,127.0276'));
});

test('카카오 웹: 출발지가 없으면 link/to (현위치 출발)', () => {
  const url = kakaoWebRouteUrl({ from: null, to: TO });
  assert(url.startsWith('https://map.kakao.com/link/to/'), url);
  assert(!url.includes('undefined'), url);
});

/* ------------------------------------------------------------------
   네이버지도 — 출발지·목적지 좌표 일관성
   ------------------------------------------------------------------ */
test('네이버: 두 지점이 함께 실리고 모드가 맞는다', () => {
  const url = naverDirectionsUrl({ from: FROM, to: TO, travelMode: 'transit' });
  assert(url.startsWith('https://map.naver.com/p/directions/'), url);
  assert(url.endsWith('/transit'), url);
  const parts = url.replace('https://map.naver.com/p/directions/', '').split('/');
  assertEqual(parts.length, 3, `경로 구간이 3개가 아니다: ${url}`);
  // 출발지·목적지 모두 '웹 메르카토르 x,y,이름,,' 형식
  for (const part of parts.slice(0, 2)) {
    const [x, y] = part.split(',');
    assert(Number.isFinite(Number(x)) && Math.abs(Number(x)) > 1000, `x 좌표가 이상하다: ${part}`);
    assert(Number.isFinite(Number(y)) && Math.abs(Number(y)) > 1000, `y 좌표가 이상하다: ${part}`);
  }
  // 두 좌표가 같은 지점이면 안 된다 (출발지가 목적지로 덮이던 오류)
  assert(parts[0] !== parts[1], '출발지와 목적지가 같다');
});

test('네이버: 자차는 /car, 도보는 /walk', () => {
  assert(naverDirectionsUrl({ from: FROM, to: TO, travelMode: 'car' }).endsWith('/car'));
  assert(naverDirectionsUrl({ from: FROM, to: TO, travelMode: 'walk' }).endsWith('/walk'));
  const noFrom = naverDirectionsUrl({ from: null, to: TO });
  assert(noFrom.includes('/-/'), '출발지 없음은 - 로 표시해야 한다');
});

/* ------------------------------------------------------------------
   티맵 — 출발지도 넘긴다
   ------------------------------------------------------------------ */
test('티맵: 출발지·목적지 이름과 좌표를 모두 넘긴다', () => {
  const url = tmapRouteUrl({ from: FROM, to: TO });
  assert(url.startsWith('tmap://route?'), url);
  const q = queryOf(url);
  assertEqual(q.get('startname'), '서울역');
  assertClose(Number(q.get('startx')), FROM.lng, 1e-6);
  assertClose(Number(q.get('starty')), FROM.lat, 1e-6);
  assertEqual(q.get('goalname'), '강남역');
  assertClose(Number(q.get('goalx')), TO.lng, 1e-6);
  assertClose(Number(q.get('goaly')), TO.lat, 1e-6);
});

test('티맵: 출발지가 없으면 목적지만', () => {
  const q = queryOf(tmapRouteUrl({ from: null, to: TO }));
  assert(!q.has('startx'));
  assertEqual(q.get('goalname'), '강남역');
});

/* ------------------------------------------------------------------
   제공자 목록·장소 검색
   ------------------------------------------------------------------ */
test('제공자: 대중교통은 카카오·네이버, 자차는 티맵까지', () => {
  assertEqual(providerList('transit').join(','), 'kakao,naver');
  assertEqual(providerList('car').join(','), 'kakao,naver,tmap');
});

test('제공자: 카카오는 앱 스킴과 웹 대체 경로를 함께 준다', () => {
  assert(PROVIDERS.kakao.appScheme === 'kakaomap://');
  assert(typeof PROVIDERS.kakao.web === 'function');
  const web = PROVIDERS.kakao.web({ from: FROM, to: TO, travelMode: 'car' });
  assert(web.startsWith('https://map.kakao.com/link/by/car/'), web);
});

test('장소 검색: 거점 이름 + 종류로 질의를 만든다', () => {
  assertEqual(placeSearchQuery('강남역', 'cafe'), '강남역 카페');
  assertEqual(placeSearchUrl('naver', '강남역 맛집'), 'https://map.naver.com/p/search/%EA%B0%95%EB%82%A8%EC%97%AD%20%EB%A7%9B%EC%A7%91');
  assert(placeSearchUrl('kakao', '강남역 맛집').startsWith('https://map.kakao.com/link/search/'));
});

/* ------------------------------------------------------------------
   P2-04 · 앱 미설치 대체 경로
   앱 스킴만 있는 티맵도 웹 길찾기(카카오맵 자동차 경로)로 넘겨
   길찾기 버튼이 죽지 않게 한다.
   ------------------------------------------------------------------ */

test('앱 대체: 카카오·티맵 스킴 링크에만 웹 대체 URL 을 붙인다', () => {
  const kakaoApp = kakaoAppUrl({ from: FROM, to: TO, travelMode: 'car' });
  assert(isAppSchemeUrl('kakao', kakaoApp), '카카오 앱 스킴을 알아보지 못했다');
  const kakaoWeb = appFallbackWebUrl('kakao', { from: FROM, to: TO, travelMode: 'car' });
  assert(kakaoWeb.startsWith('https://map.kakao.com/link/by/car/'), kakaoWeb);

  // 네이버는 앱·웹이 같은 https 링크라 대체가 필요 없다
  const naver = PROVIDERS.naver.app({ from: FROM, to: TO, travelMode: 'car' });
  assert(!isAppSchemeUrl('naver', naver), '네이버 https 링크를 앱 스킴으로 봤다');
});

test('앱 대체: 티맵은 웹 길찾기가 없어 카카오맵 자동차 경로로 넘긴다', () => {
  assertEqual(PROVIDERS.tmap.web, null);
  const tmap = tmapRouteUrl({ from: FROM, to: TO });
  assert(isAppSchemeUrl('tmap', tmap));
  const fallback = appFallbackWebUrl('tmap', { from: FROM, to: TO, travelMode: 'car' });
  assert(fallback.startsWith('https://map.kakao.com/link/by/car/'), `티맵 대체 경로가 없다: ${fallback}`);
  assert(fallback.includes(encodeURIComponent('서울역')) && fallback.includes(encodeURIComponent('강남역')),
    `출발지·목적지가 빠졌다: ${fallback}`);
});
