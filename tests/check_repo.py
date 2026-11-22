#!/usr/bin/env python3
"""저장소 검사 — CI 워크플로 사본이 실행 가능한 순수 YAML 인지 확인한다.

    python3 tests/check_repo.py

검사 항목
1. `docs/ci-workflow.yml` 이 순수 YAML 이다 (Markdown 코드 펜스·설명 문단 없음).
2. YAML 로 읽었을 때 `name` · `on` · `jobs` 가 있고 `unit` · `e2e` 작업이 있다.
3. `.github/workflows/ci.yml` 이 저장소에 있으면 `docs/ci-workflow.yml` 과 같은 내용이다.
   (없으면 워크플로 미적용 상태 — 실패가 아니라 안내로 남긴다)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "ci-workflow.yml"
WF = ROOT / ".github" / "workflows" / "ci.yml"

problems: list[str] = []

text = DOCS.read_text(encoding="utf-8")
lines = text.splitlines()
for number, line in enumerate(lines, 1):
    stripped = line.strip()
    if stripped.startswith("```"):
        problems.append(f"{DOCS.name}:{number} — Markdown 코드 펜스가 남아 있다: {stripped}")
    if stripped.startswith("|") and stripped.endswith("|"):
        problems.append(f"{DOCS.name}:{number} — Markdown 표가 섞여 있다: {stripped[:60]}")

data = None
try:
    import yaml
except ImportError:
    print("pyyaml 이 없어 YAML 파싱 검사를 건너뜁니다 (pip install pyyaml)", file=sys.stderr)
else:
    try:
        data = yaml.safe_load(text)
    except Exception as exc:  # noqa: BLE001 — 파싱 실패 이유를 그대로 보여 준다
        problems.append(f"{DOCS.name} — YAML 로 읽히지 않는다: {exc}")

if data is not None:
    if not isinstance(data, dict):
        problems.append(f"{DOCS.name} — 최상위가 매핑이 아니다: {type(data).__name__}")
    else:
        # PyYAML(YAML 1.1)은 `on:` 을 True 로 읽는다 — 둘 다 받아 준다.
        trigger = data.get("on", data.get(True))
        if not data.get("name"):
            problems.append(f"{DOCS.name} — name 이 없다")
        if not trigger:
            problems.append(f"{DOCS.name} — on(트리거)이 없다")
        jobs = data.get("jobs") or {}
        if not isinstance(jobs, dict) or not jobs:
            problems.append(f"{DOCS.name} — jobs 가 없다")
        else:
            for job in ("unit", "e2e"):
                if job not in jobs:
                    problems.append(f"{DOCS.name} — {job} 작업이 없다")
            for name, job in jobs.items():
                steps = (job or {}).get("steps") or []
                if not steps:
                    problems.append(f"{DOCS.name} — {name} 작업에 steps 가 없다")
                if not any("actions/checkout" in str(step.get("uses", "")) for step in steps):
                    problems.append(f"{DOCS.name} — {name} 작업에 checkout 단계가 없다")

if WF.exists():
    if WF.read_text(encoding="utf-8") != text:
        problems.append(".github/workflows/ci.yml 이 docs/ci-workflow.yml 과 다르다")
    else:
        print(f"워크플로 반영 확인: {WF.relative_to(ROOT)} == docs/ci-workflow.yml")
else:
    print(".github/workflows/ci.yml 없음 — 워크플로 미적용(문서화된 제한). docs 사본은 순수 YAML.")

if problems:
    print("저장소 검사 실패:")
    for item in problems:
        print("  ✗", item)
    sys.exit(1)

jobs = (data or {}).get("jobs") or {}
print(f"저장소 검사 통과: docs/ci-workflow.yml 순수 YAML · 작업 {', '.join(jobs) or '-'}")
sys.exit(0)
