#!/usr/bin/env node
/* 지오코딩 큐 지연 측정 — WO-06 (사용자 검색 우선순위)
 *
 *   node tools/measure_queue.mjs
 *
 * 참가자 12명(역주소 12건)이 큐에 쌓인 상태에서 새 주소를 검색할 때,
 * 검색 요청이 큐에서 나가기까지 걸리는 시간을 잰다.
 *   - FIFO(예전): 역주소 12건이 끝날 때까지 기다린다
 *   - 우선순위(현재): 진행 중 1건만 기다리고 곧바로 나간다
 */
import { createGeocoder, createRateLimiter } from '../js/geocode.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = payload => ({ ok: true, status: 200, json: async () => payload });

async function measureSearchWait(profile, players = 12) {
  const interval = profile.interval;
  let searchStartedAt = 0;
  const fetchImpl = async url => {
    if (url.includes('/reverse')) {
      await sleep(profile.networkMs);
      return json({ address: { road: '테스트로' }, display_name: '테스트로 1' });
    }
    searchStartedAt = Date.now();
    return json([{ display_name: '강남역', name: '강남역', lat: '37.4979', lon: '127.0276' }]);
  };
  const geocoder = createGeocoder({ fetchImpl, minIntervalMs: interval });
  const reverses = Array.from({ length: players }, (_, i) =>
    geocoder.reverse({ lat: 37.5 + i * 0.001, lng: 127.0 }));
  await sleep(50); // 첫 역주소가 진행 중, 나머지는 큐에 선 상태
  const calledAt = Date.now();
  await geocoder.search('강남역');
  const searchWait = searchStartedAt - calledAt;
  await Promise.all(reverses);
  return searchWait;
}

async function measureFifo(profile, players = 12) {
  const schedule = createRateLimiter(profile.interval);
  const tasks = Array.from({ length: players }, () => schedule(async () => {
    await sleep(profile.networkMs);
  }));
  await sleep(50);
  const calledAt = Date.now();
  await schedule(async () => {});
  const wait = Date.now() - calledAt;
  await Promise.all(tasks);
  return wait;
}

const profiles = [
  { name: '실제 앱 (1.1초 간격)', interval: 1100, networkMs: 120 },
  { name: '단축 측정 (120ms 간격)', interval: 120, networkMs: 30 },
];

for (const profile of profiles) {
  const fifo = await measureFifo(profile);
  const priority = await measureSearchWait(profile);
  console.log(`${profile.name}`);
  console.log(`  참가자 12명 역주소가 쌓인 뒤 검색 요청이 나가기까지`);
  console.log(`  - 예전 FIFO          : ${fifo}ms`);
  console.log(`  - 현재(검색 우선순위): ${priority}ms`);
  console.log(`  - 단축: ${fifo - priority}ms (${(fifo / Math.max(1, priority)).toFixed(1)}배 빠름)`);
  console.log('');
}
