#!/usr/bin/env python3
"""PKPilot0002 상호작용 E2E 검사 — 코드리뷰 P1·P2 수정분의 회귀 확인.

    python3 tests/e2e/app_checks.py                 # 로컬 서버 (지도 타일은 인증상 401)
    python3 tests/e2e/app_checks.py --base https://hyangdan2.github.io/PKPilot0002/

로컬에서 확인하는 것 (지도 없이도 동작)
- 같은 자리에 참가자를 두 명 넣을 수 있다 (20m 중복 차단 완화)
- 비동기 렌더(실시간 조회) 중에도 이름 입력의 포커스·커서가 유지된다
- 자차 만남 기준이 공유 URL 로 왕복한다 (t=car&a=highway)
- 카카오맵 딥링크가 공식 규칙(sp·ep·by / link/by)으로 나온다
- 앱 미설치 시 Midpoint 화면을 덮어쓰지 않고 새 탭/인앱 안내로 넘긴다 (티맵 → 카카오 자동차 경로)
- Nominatim 이 0건이어도 Photon 결과를 lang=default 로 받아 보여 준다
- 공평도 카드가 중심점 기준과 거점 기준을 구분해 보여 준다
- 페이지 확대를 막지 않는다 (viewport 메타)

배포본(--base)에서는 지도 타일이 뜰 때만 핀 상호작용까지 확인한다.
"""
from __future__ import annotations

import argparse
import http.server
import json
import re
import sys
import threading
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent   # PKPilot0002/
REPO = ROOT.parent
DESKTOP = {"width": 1280, "height": 900}
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


def serve():
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(REPO))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.socket.getsockname()[1]


def live_fixture(lat: float, lng: float) -> dict:
    """거점 앞 식당 2곳 + 도보 3분 거리 카페 2곳 — 실시간 조회 모의 응답."""
    def node(nid, name, amenity, dlat, dlng, extra=None):
        tags = {"amenity": amenity, "name": name}
        tags.update(extra or {})
        return {"type": "node", "id": nid, "lat": lat + dlat, "lon": lng + dlng, "tags": tags}

    return {
        "elements": [
            node(1, "모의 손칼국수", "restaurant", 0.0003, 0, {"cuisine": "korean"}),
            node(2, "모의 왕족발", "restaurant", -0.0003, 0.0002, {"cuisine": "korean"}),
            node(3, "모의 카페", "cafe", 0.0003, 0.0024, {"outdoor_seating": "yes"}),
            node(4, "모의 로스터리", "cafe", -0.0003, 0.0026),
        ],
    }


def payload_for(request) -> dict:
    body = request.post_data or ""
    around = re.search(r"around:\d+,([\d.]+),([\d.]+)", body)
    if around:
        return live_fixture(float(around.group(1)), float(around.group(2)))
    box = re.search(r"bbox=([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)", request.url)
    if box:
        west, south, east, north = (float(value) for value in box.groups())
        return live_fixture((south + north) / 2, (west + east) / 2)
    return {"elements": []}


def install_live_mock(page) -> dict:
    """Overpass·OSM 지도 API 응답을 모의한다 — 테스트가 네트워크에 기대지 않게.

    state["hold"] = True 로 두면 응답을 붙잡아 두고 flush_live() 로 내보낸다.
    (입력 도중 실시간 조회가 끝나 render() 가 도는 상황을 만들 때 쓴다)
    """
    state = {"hold": False, "pending": []}

    def handler(route, request):
        if state["hold"]:
            state["pending"].append((route, request))
            return
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(payload_for(request), ensure_ascii=False),
        )

    page.route("**/api/interpreter", handler)
    page.route("**/api/0.6/map.json*", handler)
    return state


def flush_live(state: dict, keep: int = 1) -> int:
    """붙잡아 둔 실시간 요청 중 keep 개를 응답한다 — 나머지는 버린다."""
    pending = state["pending"]
    sent = 0
    while pending and sent < keep:
        route, request = pending.pop(0)
        body = request.post_data or ""
        around = re.search(r"around:\d+,([\d.]+),([\d.]+)", body)
        payload = live_fixture(float(around.group(1)), float(around.group(2))) if around else {"elements": []}
        try:
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(payload, ensure_ascii=False))
        except Exception:  # 이미 끝난 요청
            pass
        sent += 1
    for route, _ in pending:
        try:
            route.fulfill(status=200, content_type="application/json", body='{"elements": []}')
        except Exception:
            pass
    pending.clear()
    state["hold"] = False
    return sent



def _rgba(value: str) -> tuple[float, float, float, float]:
    match = re.match(r"rgba?\(([^)]+)\)", value or "")
    if not match:
        return (0.0, 0.0, 0.0, 0.0)
    parts = [float(p) for p in re.split(r"[ ,/]+", match.group(1).strip()) if p]
    while len(parts) < 4:
        parts.append(1.0)
    return (parts[0], parts[1], parts[2], parts[3])


def luminance(color: str, base: tuple[float, float, float] = (250, 250, 253)) -> float:
    r, g, b, a = _rgba(color)
    if a < 1:
        r, g, b = (r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a))

    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(fg: str, bg: str, base: tuple[float, float, float]) -> float:
    fg_lum, bg_lum = luminance(fg, base), luminance(bg, base)
    hi, lo = max(fg_lum, bg_lum), min(fg_lum, bg_lum)
    return (hi + 0.05) / (lo + 0.05)


def theme_state(page) -> dict:
    return page.evaluate(
        """() => {
          const sw = document.querySelector('#themeSwitch');
          const read = sel => {
            const node = document.querySelector(sel);
            if (!node) return null;
            const s = getComputedStyle(node);
            return { bg: s.backgroundColor, color: s.color };
          };
          return {
            theme: document.documentElement.dataset.theme,
            stored: (() => { try { return localStorage.getItem('hd2-theme'); } catch (e) { return null; } })(),
            checked: sw ? sw.getAttribute('aria-checked') : null,
            inHeader: !!(sw && sw.closest('.header-actions')),
            floating: !!document.querySelector('#hd2ThemeToggle'),
            meta: (document.querySelector('meta[name=theme-color]') || {}).content,
            legend: read('.legend'),
            tool: read('.map-tool'),
            header: read('.app-header'),
            popupBg: (() => {
              const node = document.querySelector('.map-popup');
              return node ? getComputedStyle(node.parentElement).backgroundColor : null;
            })(),
          };
        }"""
    )


def add_search(page, term: str, wait: int = 700):
    page.fill("#searchInput", term)
    page.wait_for_selector("#searchResults li.res-row", timeout=8000)
    page.click(f'#searchResults li.res-row:has-text("{term}")')
    page.wait_for_timeout(wait)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=None, help="검사할 앱 주소 (기본: 로컬 서버)")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright가 필요합니다: pip install playwright && playwright install chromium", file=sys.stderr)
        return 1

    server = None
    base = args.base
    if not base:
        server, port = serve()
        base = f"http://127.0.0.1:{port}/PKPilot0002/"
    if not base.endswith("/"):
        base += "/"
    problems: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=DESKTOP)
        console_errors: list[str] = []

        def on_pageerror(exc):
            text = str(exc)
            stack = getattr(exc, "stack", "") or ""
            # 로컬(localhost)은 네이버 지도 키의 허용 도메인이 아니라 인증이 401 로 떨어지고,
            # 그 실패 콜백이 SDK 내부에서 TypeError(forEach/isArray of null)를 던진다 — 앱 오류가 아니다.
            # 페이지 오류의 메시지에는 호스트가 없고 스택에만 있어 스택까지 확인한다.
            # (허용 도메인인 배포본에서는 나지 않는다)
            if "oapi.map.naver.com" in text:
                return
            if "oapi.map.naver.com" in stack and base not in stack:
                return
            console_errors.append(text)

        page.on("pageerror", on_pageerror)

        def on_console(msg):
            if msg.type != "error":
                return
            url = (msg.location or {}).get("url", "") or ""
            if "Failed to load resource" in msg.text and (
                "overpass" in url or "openstreetmap.org" in url or "photon" in url or "oapi.map.naver" in url
            ):
                return
            console_errors.append(f"{msg.text} [{url}]")

        page.on("console", on_console)
        install_live_mock(page)
        page.goto(base, wait_until="load")
        page.wait_for_timeout(1200)

        # ---------- viewport ----------
        viewport = page.get_attribute('meta[name="viewport"]', "content") or ""
        if "user-scalable=no" in viewport or "maximum-scale=1" in viewport:
            problems.append(f"페이지 확대가 막혀 있습니다: {viewport}")

        # ---------- 같은 자리 참가자 허용 ----------
        page.click('.chip:has-text("강남")')
        page.wait_for_timeout(500)
        page.click('.chip:has-text("강남")')
        page.wait_for_timeout(600)
        count = page.locator(".participant").count()
        if count != 2:
            problems.append(f"같은 자리 참가자가 등록되지 않았습니다: {count}명")
        page.click('.chip:has-text("홍대입구")')
        page.wait_for_timeout(1200)

        # ---------- 공평도 두 기준 ----------
        fair_head = page.locator(".fair-copy h3").first.inner_text()
        if "중심점 공평도" not in fair_head:
            problems.append(f"공평도 카드가 중심점 기준임을 밝히지 않습니다: {fair_head}")
        station_meta = page.locator(".station-meta").first.inner_text()
        if "거점 기준 공평도" not in station_meta:
            problems.append(f"거점 카드에 거점 기준 공평도가 없습니다: {station_meta}")
        if "거점까지 가장 먼 참가자" not in station_meta:
            problems.append(f"거점 카드의 거리 기준이 모호합니다: {station_meta}")
        approach = page.locator(".station-meta .est").count()
        if approach == 0:
            problems.append("직선거리 예상 표기가 없습니다")

        # ---------- 카카오 딥링크 (데스크톱 → 웹 길찾기) ----------
        kakao = page.locator(".nav-chip").first.get_attribute("href") or ""
        if not kakao.startswith("https://map.kakao.com/link/by/"):
            problems.append(f"카카오 웹 길찾기 형식이 아닙니다: {kakao}")
        if "/link/urlroute" in kakao:
            problems.append(f"없는 카카오 경로가 남아 있습니다: {kakao}")
        if "traffic" not in kakao and "car" not in kakao:
            problems.append(f"카카오 이동 수단 코드가 없습니다: {kakao}")

        # ---------- 비동기 렌더 중 이름 입력 유지 ----------
        page.click("#resetBtn")
        page.wait_for_timeout(400)
        mock = install_live_mock(page)
        mock["hold"] = True
        add_search(page, "사당역")
        add_search(page, "이수역")
        page.wait_for_timeout(600)
        first_input = page.locator(".participant input.p-name").first
        first_input.click()
        page.keyboard.press("Control+a")
        page.keyboard.type("재혁", delay=90)
        # 입력 도중 실시간 조회 결과가 도착하며 render() 가 돌아도 입력이 살아 있어야 한다
        flush_live(mock)
        page.wait_for_timeout(2200)
        focused = page.evaluate("document.activeElement && document.activeElement.getAttribute('data-name')")
        value = page.evaluate("document.activeElement && document.activeElement.value")
        if not focused:
            problems.append("비동기 렌더 뒤 이름 입력의 포커스가 풀렸습니다")
        elif value != "재혁":
            problems.append(f"입력 중이던 이름이 바뀌었습니다: {value}")
        else:
            caret = page.evaluate("document.activeElement.selectionStart")
            if caret != len("재혁"):
                problems.append(f"커서 위치가 끝이 아닙니다: {caret}")

        # ---------- 자차 만남 기준 공유 왕복 ----------
        page.click("#resetBtn")
        page.wait_for_timeout(400)
        page.click('.chip:has-text("서울역")')
        page.wait_for_timeout(500)
        page.click('.chip:has-text("부산역")')
        page.wait_for_timeout(900)
        page.click('#modeToggle button[data-travel="car"]')
        page.wait_for_timeout(900)
        highway_btn = page.locator('[data-car-anchor="highway"]')
        if highway_btn.count() == 0:
            problems.append("자차 IC·휴게소 기준 버튼이 없습니다")
        else:
            highway_btn.first.click()
            page.wait_for_timeout(700)
        share_query = page.evaluate("location.search")
        if "t=car" not in share_query:
            problems.append(f"공유 URL 에 이동 수단이 없습니다: {share_query}")
        if "a=highway" not in share_query:
            problems.append(f"공유 URL 에 자차 만남 기준이 없습니다: {share_query}")

        page2 = browser.new_page(viewport=DESKTOP)
        install_live_mock(page2)
        page2.goto(f"{base}{share_query}", wait_until="load")
        page2.wait_for_timeout(1500)
        if page2.locator('#modeToggle button[data-travel="car"]').get_attribute("aria-pressed") != "true":
            problems.append("공유 링크에서 자차 모드가 복원되지 않았습니다")
        restored = page2.locator('[data-car-anchor="highway"]').first.get_attribute("aria-pressed")
        if restored != "true":
            problems.append(f"공유 링크에서 IC·휴게소 기준이 복원되지 않았습니다: {restored}")
        page2.close()

        # ---------- 모바일: 카카오 앱 스킴 + 웹 대체 ----------
        mobile = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                  user_agent=MOBILE_UA)
        install_live_mock(mobile)
        mobile.goto(base, wait_until="load")
        mobile.wait_for_timeout(900)
        mobile.click('.chip:has-text("강남")')
        mobile.wait_for_timeout(400)
        mobile.click('.chip:has-text("홍대입구")')
        mobile.wait_for_timeout(1500)
        app_link = mobile.locator(".nav-chip").first
        href = app_link.get_attribute("href") or ""
        if not href.startswith("kakaomap://route?"):
            problems.append(f"모바일 카카오 앱 스킴이 아닙니다: {href}")
        else:
            if "sp=" not in href or "ep=" not in href:
                problems.append(f"출발지·목적지 좌표가 빠졌습니다: {href}")
            if "by=" not in href:
                problems.append(f"이동 수단 코드가 없습니다: {href}")
            if "PUBLIC" in href or "TRANSIT" in href or "/link/urlroute" in href:
                problems.append(f"예전 형식이 남아 있습니다: {href}")
            if not app_link.get_attribute("data-app-fallback"):
                problems.append("앱 미설치 시 웹 대체 경로가 없습니다")

        # ---------- P2-04: 티맵 대체 경로 · Midpoint 화면 보존 ----------
        ctx = mobile.context
        ctx.route("https://map.kakao.com/**", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<h1>kakao map fallback</h1>"))
        mobile.click('#modeToggle button[data-travel="car"]')
        mobile.wait_for_timeout(700)
        tmap_chip = mobile.locator('.nav-chip:has-text("티맵")').first
        if tmap_chip.count() == 0:
            problems.append("자차 모드에 티맵 길찾기가 없습니다")
        else:
            tmap_fallback = tmap_chip.get_attribute("data-app-fallback") or ""
            if not tmap_fallback.startswith("https://map.kakao.com/link/by/car/"):
                problems.append(f"티맵 앱 미설치 대체 경로가 카카오 자동차 길찾기가 아닙니다: {tmap_fallback}")
            before_url = mobile.url
            pages_before = len(ctx.pages)
            tmap_chip.click()
            mobile.wait_for_timeout(2200)
            if mobile.url != before_url:
                problems.append(f"앱 미설치 대체가 Midpoint 화면을 덮어썼습니다: {mobile.url}")
            elif len(ctx.pages) == pages_before and not mobile.locator("#mapFallback").is_visible():
                problems.append("앱이 열리지 않았는데 웹 지도도 안내도 없습니다")
            # 팝업이 막히는 환경 — 인앱 안내가 버튼을 내놓고 화면은 그대로여야 한다
            mobile.evaluate("() => { window.__probeOpen = window.open; window.open = () => null; }")
            mobile.locator('.nav-chip:has-text("티맵")').first.click()
            mobile.wait_for_timeout(1800)
            if not mobile.locator("#mapFallback").is_visible():
                problems.append("팝업이 막혔을 때 인앱 대체 안내가 뜨지 않습니다")
            else:
                fallback_href = mobile.locator("#mapFallbackOpen").get_attribute("href") or ""
                if not fallback_href.startswith("https://map.kakao.com/link/by/car/"):
                    problems.append(f"인앱 안내의 웹 지도 링크가 틀렸습니다: {fallback_href}")
                mobile.click("#mapFallbackClose")
                mobile.wait_for_timeout(300)
                if mobile.locator("#mapFallback").is_visible():
                    problems.append("인앱 대체 안내를 닫을 수 없습니다")
            mobile.evaluate("() => { if (window.__probeOpen) window.open = window.__probeOpen; }")
            if mobile.url != before_url:
                problems.append("대체 경로 확인 뒤 Midpoint 화면을 잃었습니다")
            # 앱이 실제로 열린 경우(문서 blur/pagehide)는 미설치로 단정하지 않는다
            pages_before = len(ctx.pages)
            mobile.locator('.nav-chip:has-text("티맵")').first.click()
            mobile.evaluate("() => window.dispatchEvent(new Event('blur'))")
            mobile.wait_for_timeout(1900)
            if mobile.locator("#mapFallback").is_visible():
                problems.append("앱이 열린 경우에도 미설치 안내를 띄웁니다")
            if len(ctx.pages) != pages_before:
                problems.append("앱이 열린 경우에도 웹 지도를 새 탭으로 열었습니다")
            if mobile.url != before_url:
                problems.append("앱 스킴 시도 뒤 Midpoint 화면을 잃었습니다")
        mobile.close()

        # ---------- P1-01 · P2-05: Nominatim 0건 → Photon(lang=default) 대체 ----------
        geo_requests: list[str] = []
        photon_feature = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {
                    "name": "포톤 대체역", "street": "테스트로", "district": "테스트구",
                    "city": "서울특별시", "state": "서울특별시",
                },
                "geometry": {"type": "Point", "coordinates": [127.1, 37.5]},
            }],
        }

        def empty_route(route):
            geo_requests.append(route.request.url)
            route.fulfill(status=200, content_type="application/json", body="[]")

        def photon_route(route):
            geo_requests.append(route.request.url)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(photon_feature, ensure_ascii=False))

        geo = browser.new_page(viewport=DESKTOP)
        geo.route(re.compile(r"https://nominatim\.openstreetmap\.org/search.*"), empty_route)
        geo.route(re.compile(r"https://photon\.komoot\.io/api/.*"), photon_route)
        geo.goto(base, wait_until="load")
        geo.wait_for_timeout(700)
        geo.fill("#searchInput", "미드포인트테스트")
        geo.press("#searchInput", "Enter")
        try:
            geo.wait_for_selector('#searchResults li.res-row:has-text("포톤 대체역")', timeout=12000)
        except Exception:
            problems.append("Nominatim 0건일 때 Photon 대체 결과가 나오지 않습니다")
        else:
            nominatim_calls = [url for url in geo_requests if "nominatim" in url]
            photon_calls = [url for url in geo_requests if "photon" in url]
            if not nominatim_calls:
                problems.append("Nominatim 검색을 부르지 않았습니다")
            if not photon_calls:
                problems.append("0건 뒤 Photon 을 부르지 않았습니다")
            elif "lang=ko" in photon_calls[0]:
                problems.append(f"Photon 이 지원하지 않는 lang=ko 를 보냅니다: {photon_calls[0]}")
            elif "lang=default" not in photon_calls[0]:
                problems.append(f"Photon 언어가 default 가 아닙니다: {photon_calls[0]}")
            if len(geo.locator('#searchResults li.res-row:has-text("포톤 대체역")').all()) > 1:
                problems.append("같은 장소가 중복으로 표시됩니다")
        geo.close()

        # ---------- P1-01: 역주소(reverse)도 Photon 대체 · lang=default ----------
        reverse_calls: list[str] = []
        photon_reverse = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"name": "포톤역", "street": "테스트로", "district": "테스트구",
                               "city": "서울특별시", "state": "서울특별시"},
                "geometry": {"type": "Point", "coordinates": [127.1, 37.5]},
            }],
        }

        def nominatim_reverse_500(route):
            reverse_calls.append(route.request.url)
            route.fulfill(status=500, content_type="application/json", body="{}")

        def photon_reverse_ok(route):
            reverse_calls.append(route.request.url)
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(photon_reverse, ensure_ascii=False))

        rev = browser.new_page(viewport=DESKTOP)
        rev.route(re.compile(r"https://nominatim\.openstreetmap\.org/reverse.*"), nominatim_reverse_500)
        rev.route(re.compile(r"https://photon\.komoot\.io/reverse.*"), photon_reverse_ok)
        # 공유 링크로 두 참가자를 불러오면 좌표마다 역주소를 묻는다
        rev.goto(f"{base}?p=37.4979,127.0276|37.5012,127.0310&n=%EA%B0%80~%EB%82%98", wait_until="load")
        try:
            rev.wait_for_function(
                "() => Array.from(document.querySelectorAll('.p-addr'))"
                ".some(node => node.textContent.includes('테스트로'))",
                timeout=15000,
            )
        except Exception:
            problems.append("Nominatim 역주소 실패 시 Photon 역주소로 주소를 채우지 못합니다")
        else:
            photon_reverse_calls = [url for url in reverse_calls if "photon" in url]
            if not photon_reverse_calls:
                problems.append("역주소 대체로 Photon 을 부르지 않았습니다")
            elif "lang=ko" in photon_reverse_calls[0]:
                problems.append(f"Photon 역주소가 lang=ko 를 보냅니다: {photon_reverse_calls[0]}")
            elif "lang=default" not in photon_reverse_calls[0]:
                problems.append(f"Photon 역주소 언어가 default 가 아닙니다: {photon_reverse_calls[0]}")
        rev.close()

        # ---------- P2-05: 실시간 0곳과 조회 실패를 화면에서 구분 ----------
        def live_state_page(handler) -> str:
            page_live = browser.new_page(viewport=DESKTOP)
            page_live.route("**/api/interpreter", handler)
            page_live.route("**/api/0.6/map.json*", handler)
            page_live.goto(base, wait_until="load")
            page_live.wait_for_timeout(500)
            add_search(page_live, "사당역", wait=200)
            add_search(page_live, "이수역", wait=200)
            try:
                page_live.wait_for_function(
                    "() => { const chip = document.querySelector('.nearby-live');"
                    " return !!(chip && chip.dataset.live && chip.dataset.live !== 'loading'); }",
                    timeout=25000,
                )
                page_live.wait_for_timeout(300)
                return page_live.evaluate(
                    "() => { const chip = document.querySelector('.nearby-live');"
                    " const empty = document.querySelector('.nearby-empty');"
                    " return JSON.stringify({ status: chip && chip.dataset.live,"
                    " text: chip && chip.textContent.trim(),"
                    " error: !!(empty && empty.classList.contains('is-error')),"
                    " body: empty && empty.textContent }); }"
                ), page_live
            except Exception:
                return "", page_live

        empty_json = {"elements": []}
        empty_state, empty_page = live_state_page(
            lambda route: route.fulfill(status=200, content_type="application/json",
                                        body=json.dumps(empty_json)))
        empty_page.close()
        if not empty_state:
            problems.append("실시간 0곳 화면 상태를 읽지 못했습니다")
        else:
            state = json.loads(empty_state)
            if state["status"] != "empty" or "0곳" not in (state["text"] or ""):
                problems.append(f"진짜 0곳을 '실시간 0곳'으로 알리지 않습니다: {state}")
            if state["error"]:
                problems.append("0곳인데 조회 실패처럼 표시합니다")

        fail_state, fail_page = live_state_page(
            lambda route: route.fulfill(status=503, content_type="application/json", body="{}"))
        fail_page.close()
        if not fail_state:
            problems.append("실시간 조회 실패 화면 상태를 읽지 못했습니다")
        else:
            state = json.loads(fail_state)
            if state["status"] != "error":
                problems.append(f"조회 실패를 error 로 표시하지 않습니다: {state}")
            if "0곳" in (state["text"] or ""):
                problems.append(f"조회 실패를 '실시간 0곳'으로 표시합니다: {state}")
            if state["body"] and not state["error"]:
                problems.append(f"조회 실패 안내가 오류 문구가 아닙니다: {state['body']}")

        # ---------- 배포본에서만: 지도 핀 상호작용 ----------
        if args.base:
            # 앞선 자차 테스트에서 바뀐 모드를 되돌린다
            if page.locator('#modeToggle button[data-travel="transit"]').get_attribute("aria-pressed") != "true":
                page.click('#modeToggle button[data-travel="transit"]')
                page.wait_for_timeout(600)
            tiles = page.evaluate(
                "Array.from(document.querySelectorAll('#map img')).filter(i => i.complete && i.naturalWidth > 0).length"
            )
            if tiles == 0:
                problems.append("지도 타일이 로드되지 않아 핀 상호작용을 확인하지 못했습니다")
            else:
                page.click("#resetBtn")
                page.wait_for_timeout(400)
                add_search(page, "역삼역")
                add_search(page, "교대역")
                page.wait_for_timeout(2000)
                # 맛집 탭 → '지도에서' 로 장소를 강조한 뒤에도 거점 핀 탭이 살아 있어야 한다
                page.click(".nearby-tabs button[data-place-view='restaurant']")
                page.wait_for_timeout(500)
                page.locator(".place-card .mini-btn").first.click()
                page.wait_for_timeout(800)
                if page.locator(".pin-focus").count() != 1:
                    problems.append("'지도에서' 핀이 그려지지 않았습니다")
                station_pin = page.locator(".pin-station")
                if station_pin.count() == 0:
                    problems.append("추천 거점 핀이 없습니다")
                else:
                    station_pin.first.click()
                    page.wait_for_timeout(500)
                    if page.locator(".map-popup").count() == 0:
                        problems.append("장소 확인 뒤 거점 핀을 눌러도 말풍선이 열리지 않습니다 (탭 처리기 유실)")
                    else:
                        page.keyboard.press("Escape")
                        page.wait_for_timeout(200)
                # 코스 ①·② 핀도 같은 레이어 처리기를 쓴다 — 장소 확인 뒤에도 살아 있어야 한다
                page.click(".nearby-tabs button[data-place-view='course']")
                page.wait_for_timeout(700)
                course_pins = page.locator(".pin-course")
                if course_pins.count() != 2:
                    problems.append(f"코스 핀이 2개가 아닙니다: {course_pins.count()}")
                else:
                    course_pins.first.click()
                    page.wait_for_timeout(500)
                    if page.locator(".map-popup").count() == 0:
                        problems.append("장소 확인 뒤 코스 핀을 눌러도 말풍선이 열리지 않습니다")
                    else:
                        page.keyboard.press("Escape")
                        page.wait_for_timeout(200)

        # ---------- 헤더 라이트/다크 슬라이드 토글 · 테마 추종 ----------
        if page.locator(".header-actions #themeSwitch").count() == 0:
            problems.append("헤더에 테마 슬라이드 토글(#themeSwitch)이 없습니다")
        if page.locator("#themeSwitch[role='switch']").count() == 0:
            problems.append("테마 토글이 role=switch 가 아닙니다")
        light = theme_state(page)
        if light["floating"]:
            problems.append("지도 우하단 플로팅 테마 버튼(#hd2ThemeToggle)이 남아 있습니다")
        if light["theme"] != "light" or light["checked"] != "false":
            problems.append(f"라이트 모드 기본 상태가 아닙니다: {light['theme']}/{light['checked']}")
        if light["legend"]:
            if luminance(light["legend"]["bg"]) < 0.6:
                problems.append(f"라이트 모드 범례 바가 어둡습니다: {light['legend']['bg']}")
            ratio = contrast(light["legend"]["color"], light["legend"]["bg"], (250, 250, 253))
            if ratio < 4.5:
                problems.append(f"라이트 모드 범례 글자 대비가 낮습니다: {ratio:.2f}")

        page.click("#themeSwitch")
        page.wait_for_timeout(600)
        dark = theme_state(page)
        if dark["theme"] != "dark" or dark["checked"] != "true":
            problems.append(f"토글을 눌러도 다크 모드가 되지 않습니다: {dark['theme']}/{dark['checked']}")
        if dark["stored"] != "dark":
            problems.append(f"테마 선택이 localStorage 에 저장되지 않았습니다: {dark['stored']}")
        if dark["meta"] != "#0B1020":
            problems.append(f"theme-color 메타가 다크 팔레트가 아닙니다: {dark['meta']}")
        if dark["floating"]:
            problems.append("다크 모드에서 플로팅 테마 버튼이 생겼습니다")
        if dark["legend"]:
            if luminance(dark["legend"]["bg"], (11, 16, 32)) > 0.2:
                problems.append(f"다크 모드 범례 바가 밝습니다: {dark['legend']['bg']}")
            ratio = contrast(dark["legend"]["color"], dark["legend"]["bg"], (11, 16, 32))
            if ratio < 4.5:
                problems.append(f"다크 모드 범례 글자 대비가 낮습니다: {ratio:.2f}")
        if light["tool"] and dark["tool"] and light["tool"]["bg"] == dark["tool"]["bg"]:
            problems.append(f"지도 도구 버튼이 테마를 따라가지 않습니다: {dark['tool']['bg']}")
        if light["header"] and dark["header"] and light["header"]["bg"] == dark["header"]["bg"]:
            problems.append("헤더 배경이 테마를 따라가지 않습니다")

        page.reload(wait_until="load")
        page.wait_for_timeout(1200)
        persisted = theme_state(page)
        if persisted["theme"] != "dark" or persisted["checked"] != "true":
            problems.append(f"새로고침 뒤 다크 모드가 유지되지 않습니다: {persisted['theme']}/{persisted['checked']}")
        page.click("#themeSwitch")
        page.wait_for_timeout(500)
        if theme_state(page)["theme"] != "light":
            problems.append("다시 눌러도 라이트 모드로 돌아오지 않습니다")

        # 390px 폰에서 헤더가 한 줄에 들어가고 가로로 넘치지 않는다
        phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        phone.goto(base, wait_until="load")
        phone.wait_for_timeout(1200)
        for theme in ("light", "dark"):
            phone.evaluate("t => window.HD2Theme && window.HD2Theme.set(t)", theme)
            phone.wait_for_timeout(400)
            box = phone.evaluate(
                "() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth,"
                " header: document.querySelector('.app-header').getBoundingClientRect().height,"
                " switch: document.querySelector('#themeSwitch').getBoundingClientRect().width })"
            )
            if box["scroll"] > box["inner"] + 1:
                problems.append(f"390px {theme} 모드에서 헤더가 가로로 넘칩니다: {box}")
            if box["header"] > 60:
                problems.append(f"390px {theme} 모드에서 헤더가 두 줄로 접혔습니다: {box['header']}px")
            if box["switch"] < 40:
                problems.append(f"390px {theme} 모드에서 테마 토글이 너무 작습니다: {box['switch']}px")
        phone.evaluate("t => window.HD2Theme && window.HD2Theme.set('light')")
        phone.close()

        for error in console_errors:
            problems.append(f"콘솔 오류: {error}")

        browser.close()

    if server:
        server.shutdown()

    if problems:
        print("검사 실패:")
        for item in problems:
            print("  ✗", item)
        return 1
    print("상호작용 E2E 검사 모두 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
