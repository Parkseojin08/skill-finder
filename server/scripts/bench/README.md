# 검색 측정 도구 (bench)

성능 토론 로드맵 1-1(`docs/perf-debate-final-report.md`). 진짜 검색 코드(`src/search/pipeline.ts`)를 DB 사본 위에서 돌려, 화면이 무엇을 언제 보였는지 기록하고 채점합니다. 네트워크는 세 방식 중 하나입니다.

| 모드 | 네트워크 | 시계 | 쓰임 |
|---|---|---|---|
| `offline` | 전부 실패 | `--now`(기본: DB 파일 시각) | 로컬 색인만의 정렬·속도. 질의마다 쓰기를 되돌림 |
| `record` | 실제(앱의 `.env` 토큰) | 실제 | 녹화 파일(`*.rec.json.gz`) 만들기. `--token yes\|no` 필수, 기대와 다르면 멈춤 |
| `replay` | 녹화에서 녹화된 지연대로 | 녹화 시각 | 실제 검색 없이 같은 조건 A/B. 녹화에 없는 요청은 끝에 출력 |

시계를 고정하는 이유: 다운로드 수(30일), 저장된 별 수(7일), 최신성이 날짜에 따라 달라서, 같은 스냅숏도 8일 뒤에는 29개 중 26개 질의의 결과가 바뀝니다.

## 쓰는 법 (`server/`에서)

```bash
node --disable-warning=ExperimentalWarning scripts/bench/run.ts offline --db <DB 사본> --queries scripts/bench/data/holdout.json --out out/a.json
```

```bash
node --disable-warning=ExperimentalWarning scripts/bench/score.ts out/a.json --eval scripts/bench/data/holdout.json --extra scripts/bench/data/holdout-extra.json --json out/per-a.json
```

```bash
node --disable-warning=ExperimentalWarning scripts/bench/compare.ts out/per-a.json out/per-b.json
```

- `--db`는 항상 **사본**을 가리킵니다(4317 앱의 `data/`를 직접 쓰지 않음). 도구가 다시 한 번 복사해 쓰고 지웁니다. `--keep-db`를 주면 그 파일을 그대로 써서, 두 번 실행하면 "앱을 다시 켠 뒤"를 잴 수 있습니다.
- 코드 변경 전후 비교: 같은 녹화·같은 DB로 변경 전 코드와 변경 후 코드에서 각각 `run.ts` → `score.ts --json` 한 뒤 `compare.ts`.
- `record`는 사용자의 GitHub 한도를 씁니다. 질의 간격 기본 7초(`--gap`).
- `--runtime`: 질의마다 힙 증가와 RSS(`node --expose-gc`로 실행하면 수집 뒤 값).
- 녹화·DB 사본·고정 색인은 측정 폴더 `%LOCALAPPDATA%\SkillFinderBench\`(`SKILL_FINDER_BENCH_DIR`로 바꿈)에 둡니다. %TEMP%는 정리될 수 있고, 수십 MB라 git에 넣지 않습니다. 그 폴더의 `README.txt`에 무엇이 어느 녹화와 짝인지 적습니다(지금: `rec3-2026-10-30` 녹화 + `snap-2026-10-30` 사본).

## 고정 색인 (`fixture.ts`)

판정 질의가 닿는 스킬(질의마다 전문 검색 상위 150개, 그중 상위 50개와 판정된 스킬의 같은 이름 사본, 판정된 스킬 전부)과 그 플러그인·마켓플레이스·저장소 행만 남긴 작은 색인을 만듭니다. 검색 캐시·기록·설치 기록은 지웁니다. 같은 고정 색인끼리만 비교합니다(전체 색인 결과와는 후보가 달라 조금 다름).

```bash
node --disable-warning=ExperimentalWarning scripts/bench/fixture.ts --db <DB 사본>
```

출력은 측정 폴더의 `fixtures/fixture-<날짜>.db`입니다(2026-10-30 사본에서 6,522개, 33MB).

## 채점

- 화면 기준: 웹의 `web/src/lib/resultOrder.ts`를 그대로 불러 기본 정렬·같은 이름 접기·저장소 접기를 한 뒤 셉니다.
- nDCG@10(판정 0·1·2, 판정 없음 = 0), P@5(2점만), must-find(정해 둔 정답이 정해 둔 순위 안), keep5(첫 카드 5개 중 최종 5개에 남는 수), stableAt(상위 5가 마지막으로 바뀐 시각).
- 판정 기준(`docs/search-debate-final-report.md`): 새 정렬 규칙은 CI 하한 > 0이고 must-find가 줄지 않아야, 버그·재현율 수정은 비열등(CI 하한 −0.01 이상, must 순감 0), 결과가 같아야 하는 수정은 최종 목록 동일.

## 질의셋 (`data/`)

| 파일 | 내용 |
|---|---|
| `holdout.json` + `holdout-extra.json` | 보류셋 29개(설계에 쓰지 않은 질의, 2026-10-28) + 성능 토론에서 더한 판정 |
| `design.json` | 설계셋(규칙을 만들 때 본 질의라 판정용으로는 약함) |
| `alias.json` + `alias-labels.json` | 영어 별칭 시험용 14개(별칭 표를 얼린 뒤 미리 정한 질의) |
| `rep12.json` + `rep12-labels.json` | 성능 토론에서 녹화한 12개 질의 |

판정은 모두 같은 모델 계열 에이전트가 붙였습니다. 사람이 20건쯤 다시 판정하면 독립성이 좋아집니다.
