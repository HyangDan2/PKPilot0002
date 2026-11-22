# CI — GitHub Actions 워크플로

실행본은 [`docs/ci-workflow.yml`](ci-workflow.yml) 한 파일이다. 이 파일은 **순수 YAML** 이라
그대로 복사하면 Actions 가 읽는다.

```sh
mkdir -p .github/workflows
cp docs/ci-workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions 워크플로 추가"
git push
```

`main` 푸시와 모든 PR 에서 두 작업이 돈다.

| 작업 | 내용 | 같은 로컬 명령 |
| --- | --- | --- |
| `unit` | 저장소 검사 · 단위 테스트 | `python3 tests/check_repo.py` · `npm run test:unit` |
| `e2e` | 상호작용 E2E (로컬 정적 서버) | `npm run test:e2e` |

## 아직 올리지 못한 이유 — GitHub App 의 `workflows` 권한

Pickle 의 GitHub App 설치에는 **Workflows 권한이 없다.** `.github/workflows/` 파일이
포함된 푸시는 GitHub 가 다음처럼 거절한다.

```
$ git push origin HEAD
To https://github.com/HyangDan2/PKPilot0002.git
 ! [remote rejected] ... (refusing to allow a GitHub App to create or update
   workflow `.github/workflows/ci.yml` without `workflows` permission)
error: failed to push some refs to 'https://github.com/HyangDan2/PKPilot0002.git'
```

거절된 푸시는 원격에 아무것도 남기지 않는다(브랜치·커밋 모두). 우회 경로(웹 API 로
파일만 쓰기 등)는 쓰지 않았다 — 권한 없는 쓰기를 우회하면 저장소 주인이 허용하지 않은
변경이 남기 때문이다.

## 지금의 대체 검증

워크플로를 올리기 전에도 같은 두 명령을 로컬에서 돌려 결과를 남긴다. 숫자는 README 의
테스트 절과 실행 로그를 따른다.

| 워크플로 단계 | 로컬 명령 | 최근 결과 |
| --- | --- | --- |
| Unit tests | `npm run test:unit` | 아래 실행 로그 참고 (전부 통과) |
| Interaction E2E | `npm run test:e2e` | 모든 상호작용 검사 통과 |
| Repo checks | `python3 tests/check_repo.py` | `docs/ci-workflow.yml` 순수 YAML 확인 |

## 올리는 방법 (권한이 생긴 뒤)

1. GitHub App 설치 권한에 **Workflows** 를 추가한다
   (<https://github.com/apps/pickle/installations/new>).
2. 위 복사 명령을 그대로 실행한다.
3. Actions 탭에서 `Unit tests` · `Interaction E2E` 가 `main` 과 PR 에서 도는지 확인하고,
   실행 링크를 남긴다.
