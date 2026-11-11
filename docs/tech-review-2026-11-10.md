# 프로젝트 분석과 기술 추천 (2026-11-10)

요청: 지금 프로젝트의 오류·검색 효율·사용성을 분석하고, 더 효율적이고 쓰기 좋고 기능적으로 낫게 만들 라이브러리·기술·언어를 찾는다.

## 0. 범위와 방법

- **코드 수치**는 작업 폴더 기준이다. 0.3.6에 3단계 작업분(미커밋)이 더해진 상태다. 3단계는 다른 세션에서 마무리 중이라, 거기서 아직 맞추지 않은 테스트 3개(서버 1, 웹 2)는 결함으로 세지 않았다.
- **화면 점검**은 배포한 0.3.6 패키지(`release/skill-finder`)를 임시 데이터 폴더로 따로 띄워서 했다. 실제 데이터와 설치본은 건드리지 않았다.
- **운영 수치**는 개발용 색인(`data/skill-finder.db`)과 앱 로그(`data/logs/server.log`)를 읽기 전용으로 읽었다.
- **라이브러리 버전**은 npm 레지스트리에서 직접 조회했다(2026-11-10). 정책·제품 사실은 웹에서 확인했고, 1차 출처로 확인하지 못한 것은 "미확인"이라고 적었다.
- 설치된 스킬 세 개의 틀을 썼다: `engineering:tech-debt`(우선순위 점수), `engineering:architecture`(선택지 비교), `design:design-critique`(사용성 비평).

## 1. 결론 먼저

1. **코드는 건강하다.** 서버 테스트 커버리지 약 93%, 타입 검사 통과, 실행에 쓰는 의존성의 알려진 취약점 0건, 의존성은 TypeScript만 빼고 사실상 최신이다.
2. **검색 엔진은 바꿀 이유가 없다.** 로컬 색인 검색은 16ms, 첫 결과는 약 50ms에 나온다. 최종 결과까지 걸리는 2.8초(중앙값)는 전부 GitHub·skills.sh를 기다리는 시간이다.
3. **가장 큰 구멍은 "화면을 지키는 자동 검사"와 "손으로 하는 배포"다.** 웹 116개 파일에 화면 테스트가 0개이고, CI가 없다. 11월 5일 CSS 레이어 사고와 11월 9일 npm 배포 실패가 여기서 나왔다.
4. **사용성의 벽은 화면보다 입구에 있다.** Node.js를 따로 깔아야 하고, GitHub 토큰을 손으로 만들어야 하고, 영어로 검색해야 한다. 화면 자체는 측정한 8개 화면 모두 대비·이름표 기준을 통과했다.
5. **언어나 프레임워크를 바꾸는 것은 권하지 않는다.** 병목이 네트워크와 프로세스(검사·배포)에 있고, 지금 스택(Node가 TS를 직접 실행, node:sqlite, React 19, Vite 8)은 최신이다.

## 2. 측정 결과

### 2.1 규모

| 영역 | 파일 | 줄 |
|---|---|---|
| 서버 `server/src` | 120 | 20,731 |
| 서버 테스트 `server/test` | 45 | 9,655 (테스트 476개) |
| 웹 `web/src` (CSS 포함) | 116 | 21,092 |
| 웹 테스트 `web/test` | 9 | 610 (테스트 37개, 함수와 정적 검사뿐) |
| 실행기 `launcher/SkillFinder.cs` | 1 | 1,266 |
| 배포 스크립트 `scripts/` | 7 | 985 |

가장 큰 파일은 `web/src/styles.css`(2,498줄), `server/src/search/pipeline.ts`(1,288줄), `web/src/pages/SearchPage.tsx`(1,275줄)다.

### 2.2 품질

| 항목 | 값 |
|---|---|
| 타입 검사 | 서버·웹 통과 |
| 서버 커버리지 (Node 내장 측정) | 줄 93.1% · 분기 83.8% · 함수 87.9% (119개 파일) |
| 커버리지가 낮은 파일 | `sources/gitTree.ts` 44.6% · `routes/install.ts` 60.4%(분기 49%) · `routes/admin.ts` 63.6% · `sources/github.ts` 74.3% · `routes/skills.ts` 74.8% |
| 웹 화면 테스트 (컴포넌트·E2E) | 0개 |
| CI | 없음 (`.github`에 이슈 템플릿만 있음) |
| 린터·포매터 설정 | 없음 |
| `npm audit` | 실행 의존성 0건. 개발 의존성 6건(보통 4, 낮음 2)은 모두 `shadcn` CLI → `ts-morph` → `minimatch` 경로 |
| 뒤처진 의존성 | 주 버전이 뒤처진 것은 `typescript` 5.9.3 → 7.0.2 하나다. `@types/node` 24 → 26은 쓰는 Node 버전을 따르는 것이고, 나머지는 패치·마이너 수준이다 |
| 160자 넘는 줄 | 서버 236줄(1.1%), 웹 364줄(2.2%) |

### 2.3 검색 (토큰 있음, 앱 로그의 새 검색 11건, 11월 3~5일)

| 단계 | 중앙값 | 90% | 최대 |
|---|---|---|---|
| 첫 결과 표시 (검색 기록 기준) | 51ms | 72ms | 78ms |
| 로컬 색인 검색 | 16ms | 42ms | 44ms |
| skills.sh | 834ms | 1,077ms | 2,584ms |
| GitHub 코드 검색 | 1,098ms | 3,012ms | 3,708ms |
| 같은 이름 저장소 검색 | 1,221ms | 1,472ms | 2,379ms |
| 후보 조회(enrich) | 772ms | 1,535ms | 9,179ms |
| **최종 결과** | **2,818ms** | **4,296ms** | **10,024ms** |

- 캐시 적중은 15건 중 3건(20%)이고, 적중하면 0~1ms다.
- 후보 조회 239건 가운데 결과가 된 것은 44건(18%)이다. 171건(72%)은 "별 수 미달" 판정이고, 판정마다 저장소 메타데이터를 한 건씩 따로 물었다(검색 한 번에 약 15.5회, `pipeline.ts:538-545`).
- 토큰 없이 띄운 0.3.6에서 "pdf"는 첫 결과 0.11초, 최종 6.5초였다. 후보 조회가 5.8초였고, 저장소 트리를 git으로 읽기 때문이다. 4분쯤 띄운 직후 이 PC의 비인증 GitHub API 한도(시간당 60회)가 바닥난 것도 확인했다. 그 인스턴스가 쓴 것으로 보이지만 단정할 수는 없다.
- 결과 0건인 검색은 없었고, 한국어 검색어도 없었다. 기록된 검색이 15건뿐이라 이 수치들의 신뢰도는 낮다.

### 2.4 번들

| 청크 | 원본 | gzip |
|---|---|---|
| `index-*.js` | 1,073KB | 331KB |
| `index-*.css` | 101KB | 21KB |
| `ArasakaGame-*.js` (지연 로딩) | 108KB | 38KB |

메인 청크의 코드 구성(소스맵으로 계산, 번역 사전 제외): react-dom 26%, 앱 코드 34%, 마크다운 처리(react-markdown·micromark 등) 약 15%, Base UI 11%, 아이콘 5%, `cn` 3%. 여기에 en·ja 번역 사전이 합쳐 약 276KB로, 메인 청크의 4분의 1쯤이다. 한국어로 쓰는 사람에게는 필요 없는 부분이다. 다만 localhost라서 화면이 뜨는 데 70ms가 걸릴 뿐이고, 지금은 문제가 아니다.

### 2.5 화면 (0.3.6, 1280×800과 375×812)

검색 첫 화면, 검색 결과, 스킬 상세, 설치됨, 마켓플레이스, 설정, README 추천, 즐겨찾기를 측정했다.

| 항목 | 결과 |
|---|---|
| 글자 대비 미달 (WCAG AA) | 0건 (모든 화면) |
| 이름 없는 컨트롤 | 0건 |
| `:focus-visible` 규칙 / 움직임 줄이기 | 26개 / 3곳 |
| 제목 구조·랜드마크 | H1 하나, header·nav·main 있음. 화면을 옮기면 H1로 포커스 이동 |
| 모바일 가로 넘침 | 없음 |
| 발견한 문제 | 마켓플레이스 추가 입력란에 레이블 없음(placeholder만) · 도움말 글이 제목(h2) 안에 들어 있음 · 결과 첫 카드까지 Tab 33번 · 건너뛰기 링크 없음 · 모바일에서 첫 카드가 749px 아래 |

### 2.6 운영

- 백그라운드 작업 29회 중 실패 3회는 모두 "앱이 끝나 마치지 못함"이다. 실제 오류는 없었다.
- 긴 작업: 위험 재검사 최대 691초, 저장소 정보 갱신 최대 300초. 검색과 같은 스레드에서 돈다.
- 색인 파일 89MB. `skills` 표 44.5MB, FTS 본문 사본 16.2MB.
- 앱 로그의 경고는 3줄뿐이다(저장소 정보 GraphQL 실패 2, 잘린 JSON 1). 2단계에서 재시도를 넣은 부분이다.

## 3. 발견한 문제

| # | 문제 | 근거 | 심각도 |
|---|---|---|---|
| E1 | 화면이 깨져도 테스트가 잡지 못한다 | 11월 5일 CSS 레이어 순서 사고: 모든 화면의 스타일이 사라졌는데 서버 385개·웹 20개 테스트가 통과했다. 웹 테스트는 함수와 정적 검사만 본다 | 높음 |
| E2 | CI가 없다 | 테스트는 내 PC에서, 배포 zip을 만들 때만 돈다. `engines`는 Node 22.20 이상인데 실제로 돌려 본 것은 24.21 하나다. Node 26은 v26.13.0(10월 28일)부터 LTS다 | 높음 |
| E3 | 배포가 이 PC에만 있는 것에 기댄다 | 옛 업데이트 주소(Worker) 배포 설정이 임시 폴더(`…\Temp\claude\…\scratchpad\old-worker\wrangler.jsonc`)에만 있다. 버전 올림은 손으로 한다. npm 로그인은 2시간 세션이라 11월 9일에 배포가 404로 실패했다 | 중간 |
| E4 | 설치·삭제 경로의 테스트가 얕다 | `routes/install.ts` 줄 60%·분기 49%. 앱에서 가장 위험한 동작(파일을 쓰고 지움)이 있는 곳이다 | 중간 |
| E5 | 서버 응답 모양을 웹에서 손으로 다시 적는다 | API 호출 82곳 중 69곳이 손으로 쓴 타입을 쓴다. 병렬 작업 때 `(s as { drift?: Drift })` 같은 캐스트가 생겼다(`as {` 9곳, `as unknown as` 4곳) | 중간 |
| E6 | SQL이 22개 파일에 흩어져 있다 | `db/` 밖 22개 파일이 `.prepare(`를 직접 쓰고, 행 캐스트가 41곳이다. 열 이름을 바꾸면 실행해 봐야 안다 | 낮음~중간 |
| E7 | 시간을 재는 테스트가 부하에서 흔들린다 | 512KB 입력 시간 테스트가 다른 작업과 겹치면 실패한다(병렬 에이전트 실행 때와 커버리지 측정 때 관찰) | 낮음 |
| E8 | 접근성 잔손질 | 2.5절의 5가지 | 낮음 |
| E9 | 웹 테스트 파일은 타입 검사를 받지 않는다 | `web/tsconfig.json`의 `include`가 `src`와 `vite.config.ts`뿐이다 | 낮음 |
| E10 | `node:sqlite`는 Node 26에서도 "릴리스 후보"다 | 공식 문서 Stability 1.2. 7월 말 보안 릴리스에서 이 모듈의 CVE-2026-58041이 고쳐졌다. 앱은 해당 API(`createTagStore`)를 쓰지 않아 영향이 없지만, 버전마다 돌려 볼 CI가 필요한 이유다 | 낮음 |
| E11 | 번역문에서 용어가 어긋난다 | "skill"이 "기술"로 번역된다("이 기술을 사용하십시오"). `web/src/translate.ts`에 용어 보호가 없다 | 낮음 |
| E12 | 소개 페이지에 robots.txt·sitemap·canonical·구조화 데이터가 없다 | `site/public/` | 정보 |

## 4. 추천: 우선순위 표

점수는 `tech-debt` 스킬의 공식이다: (영향 + 위험) × (6 − 노력). 각 값은 1~5이고, 내가 매긴 추정이다.

| 순위 | 항목 | 영향 | 위험 | 노력 | 점수 | 푸는 문제 |
|---|---|---|---|---|---|---|
| 1 | GitHub Actions CI | 4 | 4 | 1 | 40 | E2, E7, E10 |
| 1 | Playwright 화면 검사 | 5 | 5 | 2 | 40 | E1, E8 |
| 3 | 배포 설정을 저장소 안으로 | 3 | 4 | 1 | 35 | E3 |
| 4 | npm Trusted Publishing | 3 | 3 | 1 | 30 | E3 |
| 5 | 위험 규칙을 공개 데이터셋으로 채점 | 4 | 3 | 2 | 28 | 오탐률 미측정 |
| 6 | 실행기가 Node를 스스로 준비 | 5 | 3 | 3 | 24 | 입구 |
| 6 | "GitHub 연결" 버튼 (device flow) | 4 | 2 | 2 | 24 | 입구, 검색 속도 |
| 6 | 설치·삭제 라우트 테스트 보강 | 2 | 4 | 2 | 24 | E4 |
| 9 | oxlint + knip | 2 | 2 | 1 | 20 | 린터 없음 |
| 9 | 한국어 검색어를 브라우저에서 번역 | 4 | 1 | 2 | 20 | 입구 |
| 9 | 후보 조회를 GraphQL 한 번으로 | 3 | 2 | 2 | 20 | 검색 효율 |
| 9 | 모든 SQL을 미리 prepare해 보는 테스트 | 2 | 3 | 2 | 20 | E6 |
| 13 | 서버·웹 공유 응답 계약 (zod) | 3 | 3 | 3 | 18 | E5 |
| 14 | 입력하는 동안 로컬 결과 | 3 | 1 | 2 | 16 | 사용성 |
| 15 | TypeScript 7 | 2 | 1 | 1 | 15 | 속도 |
| 15 | 접근성 손질 + 번역 용어 보호 | 2 | 1 | 1 | 15 | E8, E11 |
| 15 | 단계별 시간·이벤트 루프 지연 기록 | 2 | 1 | 1 | 15 | 검색 효율 |
| 15 | SignPath로 exe 서명 | 3 | 2 | 3 | 15 | 입구 |

## 5. 추천 상세

### 5.1 검사와 배포 (가장 먼저)

**① GitHub Actions CI** — 노력 S
- 무엇을: push마다 타입 검사·서버·웹 테스트·웹 빌드. Node 22.20 / 24 / 26 × Windows / Ubuntu. 시간 재는 테스트는 따로 한 줄로 돌린다. 검색 벤치(`server/scripts/bench`, 오프라인 고정 자료)도 함께 돌려 순위와 속도 퇴행을 막는다.
- 왜: 저장소가 공개라 무료다. 지금은 내 PC의 Node 24.21에서만 확인한다.

**② Playwright 1.65 + @axe-core/playwright 4.14** — 노력 S~M
- 무엇을: 임시 데이터 폴더와 미리 만든 색인으로 앱을 띄우고(이번 점검에서 쓴 방식 그대로) 세 가지를 본다.
  - 흐름: 검색 → 상세 → 설치 확인 창이 열림(설치는 하지 않음), 설치됨·설정이 뜸.
  - 모양: 메뉴 간격·검색창 테두리 같은 계산된 스타일 몇 개. 레이어 사고는 이것으로 잡힌다. 스크린숏 비교는 글꼴 차이 때문에 CI 한 곳에서만 한다.
  - 접근성: axe 규칙 위반 0건 유지.
- 왜: 지금은 화면을 고칠 때마다 에이전트가 브라우저를 열어 확인한다. 그 비용이 매번 들고, 그래도 11월 5일에는 놓쳤다.
- 대안: Vitest 5.1 브라우저 모드에도 스크린숏 비교(`toMatchScreenshot`)가 있다. 다만 이 프로젝트는 `node:test`를 쓰고 있어 러너가 하나 더 생긴다. 전체 앱을 띄워 보는 데는 Playwright 하나면 된다.

**③ 배포 설정을 저장소로** — 노력 S
- 옛 Worker 설정을 `site/wrangler.old-worker.jsonc`로 옮긴다. 임시 폴더가 지워지면 0.3.4 이하 설치본의 업데이트 길이 끊긴다.
- 버전 올림·CHANGELOG 날짜·zip·npm 꾸러미·두 곳 배포를 `scripts/release.mjs` 하나로 묶는다. 11월 9일에는 이 순서를 대화 기록에서 찾아 다시 했다.

**④ npm Trusted Publishing (OIDC)** — 노력 S
- 무엇을: 태그를 push하면 GitHub Actions가 npm에 올린다. 저장된 토큰이 없고, 출처 증명(provenance)이 붙는다.
- 왜: 2025년 12월 9일부터 `npm login`은 2시간짜리 세션 토큰만 준다. 11월 9일의 404는 이 세션이 만료된 것이었다.
- 그대로 두는 것: Windows zip의 서명은 지금처럼 이 PC의 키로 한다.

**⑤ oxlint 1.93 + knip 6.44** — 노력 S
- 린터가 없다. oxlint는 설정 없이 빠르게 돌고, knip은 안 쓰는 파일·export·의존성을 찾는다.
- typescript-eslint는 TypeScript 7의 API 지원이 늦다는 보고가 있어(미확인) 고르지 않았다. 포매터까지 원하면 Biome 2.6이 린트와 포맷을 함께 한다.

**⑥ TypeScript 7.0.2** — 노력 S, 직접 돌려 확인함
- 서버는 그대로 통과한다. 웹은 `tsconfig.json`의 `baseUrl` 한 줄만 지우면 통과한다(TS 7에서 없어진 옵션, `paths`는 이미 `./src/*`).
- 웹 타입 검사가 14.2초 → 3.8초로 줄었다(npx 시작 시간 포함).

### 5.2 입구 낮추기 (사용성)

**⑦ 실행기가 Node를 스스로 준비** — 노력 M, 결정 필요
- 문제: zip에 Node가 없다. 실행기는 Node가 없으면 설치 페이지를 연다. Claude Code를 네이티브 설치 프로그램으로 깐 사람은 Node가 없을 수 있다(실행기 안내문에도 적혀 있다, `SkillFinder.cs:757`).
- 선택지:

| 선택지 | 장점 | 단점 |
|---|---|---|
| A. 첫 실행 때 nodejs.org에서 받아 앱 폴더에 둠 (추천) | zip 11.4MB 그대로. 서명된 meta.json에 버전과 SHA-256을 넣어 검증 | 첫 실행 때 36MB(zip) 내려받기 |
| B. zip에 Node 동봉 | 오프라인에서도 됨 | zip이 약 47MB가 되어 Cloudflare Pages 파일 한도(25MB)를 넘는다. 배포처를 옮겨야 함 |
| C. 단일 실행 파일 (Node SEA, Bun, Deno) | 파일 하나 | SEA는 Node 26에서도 "개발 중"(1.1). 앱이 TS를 직접 실행하고 내장 skills CLI를 `process.execPath`로 돌려서(`install/run.ts:53`) 그대로는 안 된다 |

**⑧ "GitHub 연결" 버튼 (OAuth device flow)** — 노력 S~M, 결정 필요
- 문제: 토큰이 없으면 GitHub 코드 검색을 건너뛴다. 토큰 없이 한 번 재 본 검색은 최종 결과까지 6.5초였다(토큰이 있을 때 중앙값 2.8초). 지금은 fine-grained 토큰을 손으로 만들어 붙여 넣어야 한다.
- 무엇을: 버튼을 누르면 8자리 코드가 나오고, 브라우저에서 승인하면 끝난다. 권한(scope)을 하나도 주지 않은 토큰이라 공개 읽기만 된다.
- 필요한 것: 내 GitHub 계정에 OAuth 앱 등록(무료, client id만 앱에 넣음).

**⑨ 한국어 검색어를 브라우저에서 영어로** — 노력 S~M, 결정 필요
- 문제: 색인에서 한글·일본어·한자가 든 설명은 4.7%뿐이라 영어로 검색해야 한다. 지금은 170여 단어 사전(`koreanTerms.ts`)으로 영어 검색어를 제안한다.
- 무엇을: 설명 번역에 이미 쓰는 Bergamot 경로를 반대로 쓴다. Mozilla 모델 목록에 `ko→en`, `ja→en`이 있는 것을 직접 확인했다. 번역한 검색어는 지금처럼 버튼으로만 제안한다("검색어는 입력 그대로" 규칙 유지).
- 걸리는 점: 모델을 한 번 더 내려받는다. Claude 호출도 외부 번역 서비스도 아니지만, "검색에 AI 금지" 결정의 범위에 드는지는 정해 줘야 한다.

**⑩ 입력하는 동안 로컬 결과** — 노력 S~M
- 로컬 검색이 16ms라 가능하다. 지금은 이름 자동완성만 뜨고 결과는 Enter를 눌러야 나온다. 입력 중에는 로컬 결과만, Enter에서 원격까지 찾는다.

**⑪ 접근성과 번역 손질** — 노력 S
- 마켓플레이스 입력란 레이블, 도움말을 제목 밖으로, "결과로 건너뛰기" 링크.
- 번역 전에 용어를 보호한다(skill → 스킬, plugin, hook, MCP 등은 자리표시자로 바꿨다가 되돌림).

**⑫ exe 서명 (SignPath Foundation)** — 노력 M, 결정 필요
- 문제: 소개 페이지가 "알 수 없는 게시자라고 하면 추가 정보 → 실행"이라고 안내한다(`site/public/index.html:208`). 보안을 내세우는 앱의 첫 화면이 경고다.
- 선택지: SignPath Foundation은 공개 오픈소스에 무료다(MIT·공개 저장소라 조건에 맞아 보이지만 신청 전 약관 확인 필요, 게시자 이름은 SignPath Foundation으로 나온다). Azure Artifact Signing(월 약 10달러)은 Microsoft 문서 기준으로 개인은 미국·캐나다만 된다. 일반 OV 인증서는 연 150~300달러다.
- 순서: CI에서 exe를 빌드하는 것이 먼저다.

### 5.3 검색 효율

**⑬ 후보 조회를 GraphQL 한 번으로** — 노력 S~M
- 지금: 별 수를 모르는 저장소마다 메타데이터를 한 건씩 묻는다(검색당 약 15.5회).
- 무엇을: 6시간마다 쓰는 묶음 질의(`github.ts:449 refreshRepoMeta`)를 검색 때도 쓴다. skills.sh·GitHub 결과가 도착하면 모르는 저장소를 모아 한 번에 묻는다. 같은 질의에 `object(expression: "HEAD:경로")`를 넣으면 SKILL.md 본문도 함께 온다.
- 기대: 요청 수가 크게 줄고(검색당 15회 → 1~2회), 조회 자리(24개)가 덜 막힌다. 지연은 조금 줄어드는 정도일 것이다(추측, 측정 필요).

**⑭ 재기 전에 기록부터** — 노력 S
- 단계별 시간(collect·enrich·출처별)은 지금 글 로그에만 있다. 검색 기록(`events.meta_json`)에 넣으면 상태 화면에서 중앙값·90%를 볼 수 있다.
- `perf_hooks.monitorEventLoopDelay`(Node 내장)로 이벤트 루프 지연을 상태 화면에 보인다. 백그라운드 작업이 검색을 막는지가 숫자로 나온다.

**⑮ 조건부로만**
- 백그라운드 색인을 `worker_threads`로 분리: ⑭에서 지연이 실제로 보일 때만. 지금 증거로는 로컬 검색 최대 44ms라 급하지 않다.
- FTS5 trigram 보조 색인(오타·부분 일치·한국어 부분 일치): 내장 SQLite 3.53.4가 지원한다. 고정 벤치를 통과할 때만.
- 연결 재사용 늘리기(undici `keepAliveTimeout`)와 검색창 포커스 때 미리 연결: 100~300ms를 줄일 수 있다(추측).

### 5.4 구조

**⑯ 서버·웹 공유 응답 계약** — 노력 M
- 무엇을: `shared/` 워크스페이스에 zod 스키마를 두고, 서버는 응답을 그것으로 만들고 웹은 `z.infer`로 타입을 얻는다. zod 4.6.7은 이미 서버에 있다.
- 왜: 서버가 필드를 바꾸면 웹 타입 검사가 바로 실패한다. 캐스트가 필요 없어진다.
- 대안: tRPC 11·oRPC 1.16은 타입이 자동으로 이어지지만 Express 라우트를 전부 다시 써야 한다. NDJSON 스트리밍 검색도 따로 맞춰야 해서 지금은 과하다.

**⑰ 모든 SQL을 미리 prepare해 보는 테스트** — 노력 S~M
- 무엇을: 질의 문자열을 모듈마다 한곳에 모으고, 테스트 하나가 마이그레이션을 끝낸 빈 DB에서 전부 `prepare`한다. 없는 열·표는 그 자리에서 실패한다.
- ORM은 권하지 않는다(6절).

**⑱ 설치·삭제 라우트 테스트** — 노력 M
- `routes/install.ts`의 분기(409 재확인, 확인 체크 누락, 덮어쓰기 전 보관, 삭제 허용 위치)를 가짜 CLI로 끝까지 태운다.

**⑲ 급하지 않은 것**
- 화면별 지연 로딩과 언어 사전 분리: 한국어 사용자는 en·ja 사전(약 276KB)이 필요 없다. 메인 청크가 4분의 1쯤 줄지만 localhost라 체감은 작다.
- TanStack Query 5.107: 손으로 짠 fetch·폴링을 캐시·중복 제거·재시도로 바꾼다. 화면 검사(②)가 생긴 뒤, 새 화면부터.
- TanStack Table 9.3: 설치됨 표가 3단계에서 8열이 된다. 열 숨기기·정렬이 필요해지면.

### 5.5 보안 규칙의 품질 (기능)

**⑳ 위험 규칙을 공개 데이터셋으로 채점** — 노력 S~M
- 문제: 새 신호 6종의 오탐·미탐을 아직 재지 못했다(기능 제안서도 "측정 전"이라고 적었다).
- 무엇을: "Malicious Agent Skills in the Wild"(arXiv 2602.06547)는 98,380개 스킬에서 확인된 악성 157개와 취약점 632개에 표시를 붙였고, 데이터와 분석 도구를 공개했다고 한다. 이것으로 놓친 비율을 재고, 내 색인의 공식·파트너 스킬로 오탐 비율을 잰다. 글로만 읽고 실행하지 않는다.
- 참고: Cisco `skill-scanner`(오픈소스, 정적 규칙 + 선택적 LLM)의 분류와 규칙을 대조용으로 볼 수 있다(라이선스 확인 필요). Snyk Agent Scan은 스킬 내용을 Snyk 서버로 보내므로 앱에 넣기에는 맞지 않는다.

**㉑ 알아 둘 것**
- skills.sh는 스킬마다 세 감사(Gen, Socket, Snyk)의 통과·경고·실패를 보여 준다. 앱은 지금 그 페이지로 링크만 건다. 상세 화면에 세 배지를 바로 보이려면 비공식 API를 써야 해서 약관 확인이 먼저다(결정 16과 같은 문제).
- Claude Code에 `/skill-doctor`(스킬별 컨텍스트 비용과 사용 빈도)와 `claude plugin eval`이 생겼다(각각 2.1.252, 2.1.269 이상이라는 보고, 이 PC는 2.1.309). 3단계의 사용량 기능과 겹치는 부분이 있으니 설치됨 화면에서 안내만 해도 된다.

## 6. 검토했지만 권하지 않는 것

| 후보 | 이유 |
|---|---|
| 언어 교체 (Rust·Go 재작성, Tauri·Electron) | 병목이 네트워크다. 실행기(C#)는 Windows 내장 컴파일러로 빌드되고 잘 동작한다. Tauri로 가도 Node가 필요한 것은 그대로다 |
| 검색 엔진 교체 (Orama 3.1, MiniSearch, Meilisearch) | 로컬 검색이 16ms다. FTS5는 파일에 남고 SQL과 함께 쓴다. 순위는 고정 벤치로 맞춰 둔 상태다 |
| 임베딩·벡터 검색 (transformers.js 4.3, sqlite-vec 0.1.9, Model2Vec) | 이전 결정(AI 금지, 모델 크기, 이 PC에서 실패)이 그대로 유효하다. 새로 확인한 것: 다국어 정적 모델(potion-multilingual-128M)은 1.28억 파라미터라 약 0.5GB로 추정되고, 영어 전용(potion-base-8M)은 약 30MB로 추정된다. 의미 검색은 skills.sh 결과가 이미 일부 채운다. 한국어 문제는 ⑨가 더 싸다 |
| 프레임워크 교체 (Express → Hono·Fastify, 라우터 도입) | 측정된 문제가 없다. Express 5.3은 최신이다 |
| ORM (Drizzle 0.45, Kysely 0.29) | `node:sqlite`는 동기식이고 FTS5 질의를 손으로 다듬어 쓴다. ⑰이 더 작다 |
| Node 권한 모델 (`--permission`) | Node 26에서 안정이지만, 문서상 네트워크는 `--allow-net`으로 켜고 끄는 것만 있고 Node 24에는 그 옵션도 없다. 프로젝트 폴더가 아무 경로나 될 수 있고 CLI를 자식 프로세스로 돌려서 허용 목록이 넓어진다. 효과가 작다 |
| MSIX로 Microsoft Store 등록 | 스토어가 무료로 서명해 주지만 Node를 넣어 다시 포장해야 한다. ⑦과 ⑫ 뒤에 볼 일 |
| TOML 라이브러리 (smol-toml 1.9) | 직접 만든 파서는 "출처 파일·줄"을 보이려고 줄 번호를 남긴다. 라이브러리는 그것을 주지 않는다 |
| React Compiler 1.0 | 렌더링이 느리다는 측정이 없다 |

## 7. 화면 비평 (design-critique 형식)

**전체 인상**: 무엇을 하는 앱인지 2초 안에 읽힌다. 가장 큰 기회는 색이다. 빨강이 강조색이면서 위험색이다.

**사용성**

| 발견 | 심각도 | 제안 |
|---|---|---|
| 빨강이 평범한 컨트롤(출처 칩, 검색 버튼, 활성 메뉴)과 경고("위험 높음 1개 숨김", "별 기준 없이 다시 찾기")에 함께 쓰인다 | 보통 | 출처 칩처럼 중립인 컨트롤은 회색 테두리로 낮추고, 빨강은 경고와 주 버튼에만 |
| 번역된 설명이 어색하다("기술을 사용하십시오") | 보통 | ⑪의 용어 보호 |
| 결과 첫 카드까지 Tab 33번 | 낮음 | 건너뛰기 링크, 또는 `j`/`k`로 카드 이동 |
| 설치됨 표에서 긴 경로가 이름 아래 두 줄로 접힌다. 3단계에서 열이 2개 더 는다 | 낮음 | 경로는 홈을 `~`로 줄이고 나머지는 툴팁, 열 숨기기 |
| 결과 메타 정보가 12px다(99개 요소) | 낮음 | 13px |
| 모바일에서 결과 위에 칩이 5줄 쌓인다 | 낮음 | 데스크톱 도구라 우선순위 낮음 |

**잘 된 것**
- 첫 결과가 0.1초 안에 뜨고, 어디서 몇 초 걸렸는지 결과 위에 보인다.
- 숨긴 것(별 기준, 위험 높음)을 개수와 함께 알리고 한 번에 풀 수 있다.
- 화면을 옮기면 제목으로 포커스가 간다. 모든 컨트롤에 이름이 있고 대비 미달이 없다.
- 미리 만든 색인 덕에 첫 실행 2.2초 뒤 13,219개 스킬을 바로 찾는다.

## 8. 실행 순서 제안

1. **1주차 (바탕)**: ① CI → ② Playwright → ③ 배포 설정 옮기기 → ⑥ TypeScript 7 → ⑤ 린터.
2. **2주차 (배포와 측정)**: ④ npm 자동 배포 → ⑳ 위험 규칙 채점 → ⑭ 단계별 시간 기록.
3. **그다음 (입구)**: ⑦ Node 자동 준비 → ⑧ GitHub 연결 → ⑨ 한국어 검색어 번역 → ⑩ 입력 중 로컬 결과 → ⑪ 손질.
4. **구조는 틈틈이**: ⑬ GraphQL 묶음 → ⑰ SQL 테스트 → ⑱ 설치 라우트 테스트 → ⑯ 공유 계약.
5. **CI가 exe를 빌드하게 된 뒤**: ⑫ 서명 신청.

## 9. 정해 줘야 할 것

1. **⑦** 실행기가 nodejs.org에서 Node를 받아 앱 폴더에 두어도 되는가?
2. **⑧** 내 GitHub 계정에 OAuth 앱을 등록하고 "GitHub 연결" 버튼을 둘 것인가?
3. **⑨** 브라우저 안 로컬 번역으로 한국어 검색어를 영어로 제안하는 것이 "검색에 AI 금지"에 걸리는가?
4. **④** npm 배포를 GitHub Actions로 옮길 것인가? (zip 서명 키는 PC에 그대로 둔다)
5. **⑫** SignPath Foundation에 신청할 것인가? (게시자 이름이 SignPath Foundation으로 나온다)
6. **㉑** skills.sh 감사 결과를 상세 화면에 바로 보일 것인가? (약관 확인 뒤)

## 10. 출처

- Node.js: [릴리스 목록](https://nodejs.org/dist/index.json) · [v26 sqlite](https://nodejs.org/docs/latest-v26.x/api/sqlite.html) · [v26 permissions](https://nodejs.org/docs/latest-v26.x/api/permissions.html) · [v26 SEA](https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html) · [v26 TypeScript](https://nodejs.org/docs/latest-v26.x/api/typescript.html)
- CVE-2026-58041: [Wiz](https://www.wiz.io/de-de/vulnerability-database/cve/cve-2026-58041) · [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-58041)
- npm: [classic 토큰 폐기·세션 인증 (2025-12-09)](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/) · [granular 토큰 변경 (2025-11-05)](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/) · [Trusted Publishing 설명](https://socket.dev/glossary/npm-trusted-publishing)
- TypeScript 7: [이전 안내](https://www.developersdigest.tech/blog/typescript-7-native-compiler-migration-guide) · [깨지는 것 점검](https://dev.to/booyaka101/bumping-to-typescript-7-catch-what-tsgo-breaks-in-your-repo-before-ci-does-1mdk) (호환 여부는 이 저장소에서 직접 실행해 확인)
- Vitest 브라우저 모드: [InfoQ](https://www.infoq.com/news/2025/12/vitest-4-browser-mode) · [Argos 안내](https://argos-ci.com/blog/vitest-visual-testing)
- 번역 모델: [Mozilla Remote Settings의 translations-models](https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records)
- 정적 임베딩: [Model2Vec](https://github.com/MinishLab/model2vec) · [potion-multilingual-128M](https://huggingface.co/minishlab/potion-multilingual-128M)
- 스킬 보안: [Malicious Agent Skills in the Wild (arXiv 2602.06547)](https://arxiv.org/abs/2602.06547) · [데이터 페이지](https://sites.google.com/view/malicious-agent-skills) · [Cisco skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) · [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub) · [skills.sh 감사 설명](https://vibecoding.app/blog/skills-sh-review)
- Windows 서명: [Microsoft: 코드 서명 선택지](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) · [SignPath Foundation 약관](https://signpath.org/terms) · [스토어의 Win32 앱](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store)
- Claude Code: [스킬 문서](https://code.claude.com/docs/en/skills) · [plugin eval 소개](https://dev.to/davekurian/claude-code-plugin-eval-gate-skills-on-delta-before-you-merge-5bh6)
