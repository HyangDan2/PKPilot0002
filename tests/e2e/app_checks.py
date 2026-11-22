#!/usr/bin/env python3
"""PKPilot0002 상호작용 E2E 검사 — 코드리뷰 P1·P2 수정분의 회귀 확인.

    python3 tests/e2e/app_checks.py                 # 로컬 서버 (지도 타일은 인증상 401)
    python3 tests/e2e/app_checks.py --base https://hyangdan2.github.io/PKPilot0002/

로컬에서 확인하는 것 (지도 없이도 동작)
- 같은 자리에 참가자를 두 명 넣을 수 있다 (20m 중복 차단 완화)
- 비동기 렌더(실시간 조회) 중에도 이름 입력의 포커스·커서가 유지된다
- 자차 만남 기준이 공유 URL 로 왕복한다 (t=car&a=highway)
- 카카오맵 딥링크가 공식 규칙(sp·ep·by / link/by)으로 나온다
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
        page.on("pageerror", lambda exc: console_errors.append(str(exc)))

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
        mobile.close()

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
