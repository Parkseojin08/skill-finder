# 결정 기록

명세(기능 1 구현 명세, 2026-10-23)에서 모호하거나 실행 결과가 달랐던 부분을 한 줄씩 남긴다.

## 스파이크 결과 (2026-10-23, Windows 10 / Node 24.21 / Claude Code 2.1.309)

| ID | 결과 | 반영 |
|---|---|---|
| S1 | 통과. `GET https://skills.sh/api/search?q=pdf&limit=5` → 200, `{query, searchType:"fuzzy", skills:[{id, source, skillId, name, installs}], count}`. 퍼지 검색이라 `pdf`에 `docx`·`canvas-design`도 섞임 | skills.sh 어댑터 사용. `skillId`도 읽어 폴더명 매칭에 쓴다 |
| S2 | 미실행. `GITHUB_TOKEN` 없음, `gh` 미로그인. 비인증 호출은 이 IP의 core·code_search 한도(시간당 60)가 이미 소진되어 403. `GET /rate_limit`에 `code_search` 리소스가 있는 것은 확인 | 토큰이 없으면 GitHub 어댑터를 건너뛰고 경고를 띄운다. 토큰 설정 후 다시 확인해야 함 |
| S3 | 통과. `claude-haiku-5-5`로 `structured_output` 수신. `num_turns: 2`(maxTurns 1이었으면 실패), 비용 $0.00048, 첫 호출 벽시계 3.4초, `apiKeySource: none`(Claude Code 로그인 자격 사용) | 명세 옵션 그대로 사용 |
| S4 | API 경로는 한도 소진으로 미확인. 대신 `git ls-remote` + `git fetch --depth 1 --filter=blob:none <url> <commit sha>`로 commit SHA를 지정한 트리 조회 성공(anthropics/skills, 약 2.3초, SKILL.md 20개 = 스킬 19 + template). `git ls-tree -l`은 blob을 지연 다운로드하느라 멈추므로 `GIT_NO_LAZY_FETCH=1`과 `-l` 없는 `ls-tree`를 쓴다 | 트리 조회는 "토큰이 있고 core 한도가 남으면 tree API, 아니면 git 부분 fetch"로 구현 |
| S5 | `claude`는 `%USERPROFILE%\.local\bin\claude.exe`(네이티브 exe). `spawn('claude', args, {shell:false})` 성공 | PATH에서 `.exe`를 먼저 찾고, `.cmd` shim만 있을 때만 검증된 인자를 인용해 `shell:true`로 실행 |

## 설계 결정

- 트리 조회: tree API가 `truncated: true`이면 contents API를 경로별로 부르는 대신 git 부분 fetch로 전체 트리를 다시 받는다. 호출 수가 1회로 고정되고 비인증 상태에서도 동작한다.
- git 부분 fetch로 받은 트리에는 파일 크기가 없다. 이 경우 파일 목록의 `size`는 `null`이고, 파일 원문 보기는 raw 다운로드를 256KB에서 끊어 판정한다.
- git 작업 폴더는 `data/tmp/git/` 아래에 만들고 목록을 뽑은 뒤 바로 지운다. checkout을 하지 않으므로 원격 파일이 작업 트리에 풀리지 않는다.
- 마지막 커밋 시각(F): 저장소 메타(`pushed_at`)가 있으면 그것을, 없으면 색인한 commit의 커밋 시각을 쓴다.
- 커밋 SHA 해석은 `git ls-remote`로 한다(API 한도를 쓰지 않음). 상대경로 플러그인의 `plugins.sha`에는 마켓플레이스 저장소의 현재 commit SHA를 넣어 증분 동기화 키로 쓴다.
- 상대경로 source와 `metadata.pluginRoot`: 베어 이름은 `pluginRoot`에 붙인다. `./`로 시작하는 경로는 `pluginRoot`를 붙인 경로가 트리에 있으면 그쪽, 없으면 마켓플레이스 루트 기준으로 해석한다(문서와 skills CLI 해석이 달라 둘 다 수용).
- 일반 저장소 모드는 skills CLI와 같게 name·description이 없는 SKILL.md를 건너뛴다. CLI가 `--skill`로 설치하지 못하기 때문이다. 플러그인 모드는 Claude Code처럼 모든 필드를 선택으로 본다.
- `shellInjection` 판정: `` !`cmd` ``는 줄 시작·공백·`(` 뒤에 올 때만 인정한다(`warning!` 같은 문장 끝 느낌표 오탐 방지). ```` ```! ```` 블록은 줄 시작 기준.
- `pluginRootDependency`는 `${CLAUDE_PLUGIN_ROOT}`와 `$CLAUDE_PLUGIN_ROOT`를 모두 잡는다. 판정 대상은 SKILL.md 본문이다.
- 위험 등급: `rmRf`는 "정보성"이므로 단독으로는 medium으로 올리지 않는다.
- 플러그인 수준 위험 신호(hooks/MCP/bin/monitors)는 그 플러그인에 속한 스킬마다 붙인다. 스킬을 설치하면 플러그인 전체가 설치되기 때문이다.
- 신뢰도(T): owner가 `anthropics`이고 `external_plugins/` 아래가 아니면 1.0, Anthropic 운영 마켓플레이스(official, anthropic-agent-skills, knowledge-work-plugins)의 외부 플러그인은 0.8, community 0.6, 그 외 0.4.
- FTS5 토크나이저는 `porter unicode61`을 쓴다. 영어 질의 확장 결과("extracting" ↔ "extract") 매칭이 좋아진다.
- `skills` 테이블에 `files_json`(스킬 폴더 파일 목록) 열을, `plugins` 테이블에 `skills_indexed_sha` 열을 추가했다. 상세 화면 파일 트리와 증분 색인에 필요하다.
- skills.sh·GitHub 검색에서 들어온 저장소가 마켓플레이스/플러그인 구조면 §5.2 규칙으로 스킬을 찾되, 설치는 skills CLI로 한다. 단 `pluginRootDependency` 스킬은 저장소에 marketplace.json이 있으면 그 마켓플레이스를 추가해 플러그인으로 설치하고, 없으면 수동 안내만 한다.
- 질의 확장·재순위 응답 캐시는 검색 결과 캐시(24시간)에 포함된다. 별도 캐시는 두지 않는다.
- 기본 필터의 최대 위험 등급은 `medium`(high 숨김). 화면 토글로 high도 볼 수 있다.
- Markdown 렌더링에서 원격 이미지는 불러오지 않고 링크로 바꾼다(추적 픽셀·IP 노출 방지). CSP도 `img-src 'self' data:`로 둔다.
- 상태를 바꾸는 요청(POST/PUT/DELETE)은 Origin 헤더가 앱 출처와 같아야 한다. Origin이 없는 요청(curl 등)도 거부한다.
- 설정 화면에서 GitHub 토큰을 입력하면 서버가 `.env`의 `GITHUB_TOKEN` 줄을 고쳐 쓴다. 응답에는 존재 여부만 돌려준다.
- 수집 작업에 `POST /api/collect`, `POST /api/jobs/:id/(pause|resume|cancel)`을 추가했다(명세 API 표에 없음, M6 중단·재개 요구 때문).
- (2026-10-26, 사용자 요청) 검색에서 AI(§8 질의 확장·재순위)를 없앴다. 검색어를 그대로 찾고 관련도(R)는 bm25·검색 순위로 계산한다. 화면에 영어로 검색하라는 안내를 두고, 한국어 검색어면 결과에 경고를 붙인다. 설정의 AI 항목(사용 여부·모델·예산)과 결과의 `summary_ko`·`why_ko`·`reranked` 필드도 지웠다. 이어서 사용자 요청으로 Claude 호출 모듈(`claude/structuredCall.ts`)과 `@anthropic-ai/claude-agent-sdk` 의존성도 지웠다(§8 전체 미사용). 아래 재순위·Claude 호출 관련 항목은 더 이상 적용되지 않는다. `claude` 실행 파일은 플러그인 설치·목록 조회에만 쓴다.
- (2026-10-26, 사용자 요청) 검색 결과에 정렬을 추가했다: 종합 점수(기본), 적합도(R), 다운로드, 스타, 최근 업데이트, 이름. 받은 결과 20개를 화면에서 다시 정렬하며, 값을 모르는 스킬은 뒤로 보낸다.
- (2026-10-26, 사용자 요청) 설명문 한국어 번역은 브라우저 내장 Translator API(Chrome 138+, 기기 안 번역)로 한다. 서버로 보내는 데이터도, 프로젝트가 내려받는 모델도 없다. 번역 결과는 브라우저 localStorage에 캐시한다. 비교한 대안: transformers.js + NLLB-200 600M(q8)은 모델 약 900MB에 이 PC(i7-4770K)에서 설명 하나당 14–18초라 실사용 불가. 더 작은 Marian(opus-mt-tc-big-en-ko) ONNX는 transformers.js용 토크나이저가 없어 출력이 깨졌다. Claude 앱 내장 브라우저(Electron)는 API는 있지만 `availability()`가 응답하지 않아 3초 뒤 "지원 안 함"으로 보고 영어로 보여 준다. 검색어는 사용자 요청대로 영어 입력을 유지한다.
- (2026-10-26, 사용자 요청) UI를 ui-ux-pro-max 스킬의 "developer tool" 디자인 시스템(어두운 slate 배경, 초록 강조색, 모노스페이스 제목, SVG 아이콘, 보이는 포커스, 150–250ms 전환, reduced-motion)으로 다시 칠했다. 스킬이 권하는 Google Fonts는 CSP(`font-src 'self'`)와 외부 요청 때문에 쓰지 않고 시스템 글꼴(한글 포함)로 대신한다. 라이트 모드도 유지한다.
- (2026-10-26, 사용자 요청) 프로젝트 경로 입력 옆에 "폴더 선택" 버튼을 두었다. 브라우저는 폴더의 절대경로를 페이지에 주지 않으므로 `POST /api/pick-folder`로 서버가 OS 폴더 선택 창을 연다(Windows: 탐색기 모양의 IFileOpenDialog(FOS_PICKFOLDERS)를 PowerShell+C# COM interop로 열고, 실패하면 FolderBrowserDialog로 대체. macOS: osascript, Linux: zenity/kdialog). 시작 폴더는 환경변수로만 넘기고 스크립트 문자열에 끼워 넣지 않는다. 백그라운드 프로세스라 창이 뒤에 뜨는 문제는, 대화상자 창을 찾아 HWND_TOPMOST로 올리고 Alt 키 입력으로 포그라운드 잠금을 풀어 SetForegroundWindow를 부르는 방식으로 해결한다. 창이 열려 있는 동안 웹 화면은 전체 오버레이와 `inert`로 잠근다.
- (2026-10-26, 사용자 요청) 명세의 "제거 명령 안내만"을 바꿔, 설치됨 화면에서 바로 삭제한다(`POST /api/uninstall`). 플러그인은 `claude plugin uninstall <id> --scope <scope> --json`(project/local은 그 플러그인의 프로젝트 폴더에서). 스킬은 skills CLI `remove`를 먼저 돌리고, 폴더가 남으면 `~/.claude/skills` 또는 `<프로젝트>/.claude/skills` 바로 아래이고 SKILL.md가 있는 폴더일 때만 직접 지운다(심볼릭 링크는 링크만). 앱 계정 동기화(`synced`) 플러그인은 지우지 않는다. 삭제 전 확인 창을 띄우고 기록은 install_log에 남긴다.
- (2026-10-26, 사용자 요청) 어두운 테마 배경을 검은색(`#000`)으로 바꾸고 카드·테두리·보조 글자색을 무채색 회색 계열로 맞췄다(라이트 모드는 그대로). 직전의 `rgb(63, 56, 76)` 보라 배경을 대체한다.
- (2026-10-26, 사용자 요청) 검색 결과를 페이지로 나눴다(기본 5개씩, 5/10/20 선택). 새 검색·정렬·개수 변경 시 1페이지로 돌아간다.
- (2026-10-26, 사용자 요청 "더 깔끔하고 쓰기 쉽게") 검색 화면 정리:
  - 결과 위 툴바: 개수·시간, "알림 N", 번역 상태 칩, 정렬, 페이지당 개수를 한 줄에 모았다.
  - 결과의 뜻을 바꾸는 경고는 그대로 보이고, 일상 안내만 "알림 N"에 접는다. 보이는 경고는 검색어, 서버, skills.sh·GitHub 검색 실패, 아직 확인 중인 후보다. 접는 안내는 GitHub 토큰 없음, 설명 없는 결과 숨김이다. 위험 등급으로 숨긴 결과는 툴바의 "모두 보기" 버튼으로 바로 보인다.
  - 카드에는 위험 등급과 신호 이름(최대 3개, 정보성 rm -rf는 뒤)만 보인다. 품질 경고는 상세 페이지에서만 보인다.
  - `/` 키로 검색창으로 간다. 앱 계정 동기화 플러그인은 설치됨 화면에서 접어 둔다. Claude Code·skills CLI 버전은 첫 화면 한 줄로 보인다.
- (2026-10-26, 사용자 요청 "CLI·사이버펑크·네온 느낌, 과하지 않게") ui-ux-pro-max의 "Cyberpunk UI" 스타일을 낮춰 적용했다:
  - 검은 배경은 유지했다. 그 위에 아주 옅은 격자와 상단 글로우만 얹었다.
  - 강조색은 네온 민트(`#3cf5a0`) 하나다. 시안·마젠타는 출처 배지와 점수 막대에만 쓴다.
  - 글로우는 포커스·호버·활성 상태에만 준다. 기본 버튼은 외곽선 네온이고 호버하면 채워진다.
  - 메뉴·버튼·배지·표 머리는 모노스페이스, 설명 본문은 한글 산세리프다.
  - CLI 표시: `>_` 로고와 깜박이는 커서, 검색창 `❯` 프롬프트, 제목의 `~/`·`#`, 예시·명령 앞의 `$`. 장식 기호는 스크린리더가 읽지 않는다. 커서 깜박임은 reduced-motion에서 끈다.
  - 글리치·스캔라인 효과는 넣지 않았다(가독성).
  - 네온 테마는 밝은 배경에서 성립하지 않아 라이트 모드를 없애고 어두운 테마만 둔다. 41·44행의 "라이트 모드 유지"를 대체한다.
- (2026-10-26, 사용자 요청) 관련도(R) 보정: 검색 엔진 신호(bm25·검색 순위, skills.sh 순위는 0.8배)에 검색어 단어가 스킬 이름·설명에 들어 있는 비율과 문장 일치를 섞는다(`0.45·엔진 + 0.25·설명 일치 + 0.2·이름 일치 + 0.1·문장 일치`). 단어는 간단한 어간 처리(복수형·-ing·-ion 등)로 맞춘다. 가중치는 근거 데이터 없는 추정값이다.
- (2026-10-26, 사용자 요청) 설치됨 화면의 켜짐/꺼짐은 `claude plugin list`(실행 폴더 기준)가 아니라 그 설치를 가진 설정 파일(`~/.claude/settings.json`, `<프로젝트>/.claude/settings.json`, `settings.local.json`)의 `enabledPlugins`로 판단한다.
- (2026-10-26, 사용자 요청) 후보 확인 마감 10초→15초, 동시 확인 10→16. 확인하지 못한 후보가 있으면 그 검색 결과는 24시간 대신 1분만 캐시한다(빠진 후보는 뒤에서 계속 색인되어 다음 검색에 포함됨).
- (2026-10-26, 사용자 요청) 지연 색인 마켓플레이스(커뮤니티)의 스킬을 전체 동기화 뒤 백그라운드에서 자동 수집한다(설정 `autoCollect`, 기본 켬, 동시 3개). 검색이 진행 중이면 수집이 잠시 멈춘다.
- (2026-10-26, 사용자 요청) 설명이 없는 결과(이름만 아는 well-known 출처)는 결과에서 숨기고 숨긴 개수를 알려 준다. 결과 수는 20→50(후보 60, 로컬 FTS 80, skills.sh 30)으로 늘렸다.
- (2026-10-26) 삭제 확인을 브라우저 `confirm()` 대신 앱 안의 확인 창으로 바꿨다(설치됨·마켓플레이스 화면).
- (2026-10-26, 사용자 요청) 다른 폴더(`%USERPROFILE%\Desktop\project\subproject\Skill Finder`)에 잘못 설치된 ui-ux-pro-max의 프로젝트 설치를 제거했다. 프로젝트에 git 저장소를 만들고 첫 커밋을 남겼다(`.env`, `data/`, `node_modules/`, `web/dist/`는 제외).
- (2026-10-26, 사용자 요청) 화면을 페이지 단위로 나눴다: 검색 `/`, 스킬 상세 `/skill?id=`(개요·설치·SKILL.md·파일 탭), 설치됨 `/installed`, 마켓플레이스 `/marketplaces`, 설정 `/settings`. 검색 결과 옆 상세 패널은 없앴다. 상세 페이지의 관련도·인기 점수는 검색 결과에서 열었을 때만 보인다.
- 재순위는 8개씩 배치, 동시 5개. 로컬 색인 후보는 수집 직후 바로 보내고, skills.sh·GitHub 후보는 확인되는 대로 큐에 넣는다. 검색 시작 27초에 재순위 대기를 끊고 남은 후보는 대체 순위로 정렬한다(30초 목표).
- 한국어 요약·이유는 프롬프트에서 60자·80자 이내로 요청한다(출력 토큰이 지연의 대부분). 잘라내기 한도 80/120자는 그대로.
- Claude 호출마다 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`로 출력 상한을 둔다(확장 호출 하나가 $0.14까지 간 적이 있음).
- 상세 API는 R·P를 계산하지 않는다(결과 집합 기준 상대값). 화면은 결과 카드의 R·P와 상세의 F·T를 합쳐 보여 준다.
- 설치 미리보기용 `GET /api/install/preview`, 마켓플레이스 관리용 `/api/marketplaces`를 추가했다.
- 루트 `npm start`는 web 빌드 후 서버를 띄운다.
- 루트 `npm run dev`의 `a & b`는 Windows cmd에서 순차 실행이라 두 번째가 뜨지 않는다. `scripts/dev.mjs`로 두 프로세스를 함께 띄운다.
