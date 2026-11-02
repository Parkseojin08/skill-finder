# Skill Finder

Claude Code 스킬을 한곳에서 찾아 점수·위험 신호와 함께 보고, 설치 전에 무엇이 함께 들어오는지 확인한 뒤 설치·삭제하는 로컬 웹 앱입니다. 화면은 한국어·영어·일본어입니다.

> **English:** A local web app (127.0.0.1) that searches Claude Code skills across plugin marketplaces, skills.sh and GitHub, scores them, flags risky signals, and installs or removes them only after showing the exact command, the install location and the files that come along. No AI calls; the UI is in Korean, English or Japanese (Settings). Run it with `npx skill-finder` on Windows, macOS or Linux.

## 무엇을 하나요

- **세 곳을 한 번에 검색**: Claude Code 플러그인 마켓플레이스, skills.sh, GitHub(토큰을 넣으면 코드 검색까지). 같은 스킬의 사본은 하나로 묶습니다.
- **설치 전에 보여 주기**: 실행할 정확한 명령, 설치 위치, 함께 들어오는 파일 검사(내려받아 실행하는 코드 등), 위험 신호(훅, MCP 서버, Bash 사전 승인, 셸 명령 주입, 원격 스크립트 실행). 위험 등급은 규칙으로 판정한 것이며 안전 보증이 아닙니다.
- **점수**: 관련도·인기(다운로드·별)·최신성·신뢰도(Anthropic 공식·파트너·커뮤니티). 결과는 이름 일치 → 다운로드 → 별 순서로 정렬합니다.
- **README 추천**: 프로젝트 폴더의 README(없으면 package.json 같은 설명 파일과 CLAUDE.md·AGENTS.md)에서 단어를 뽑아 비슷한 스킬을 보여 줍니다.
- **설치됨**: 설치된 플러그인·스킬, 매 턴·사용 시 컨텍스트 토큰 추정, 설치 기록, 삭제.
- **공유·내보내기**: 설치 명령·Markdown 한 줄·공유용 글·공유 링크(앱 없이 열리는 페이지) 복사, 검색 결과와 설치 목록을 JSON·Markdown으로 저장(브라우저 안에서만).
- **팀 프리셋·즐겨찾기**: 설치된 스킬을 파일로 내보내 팀원이 같은 스킬을 확인 창을 거쳐 설치하고, 이 PC의 계정으로 로그인해 즐겨찾기를 모읍니다.
- **언어**: 한국어·English·日本語 (설정에서 고름).

## 설치

### Windows

[소개 페이지](https://skill-finder.a01075011775.workers.dev)에서 zip을 받아 압축을 풀고 `SkillFinder.exe`를 실행합니다. 서버를 켜고 브라우저를 열며, 새 버전이 나오면 서명을 확인한 뒤 업데이트합니다.

### macOS·Linux·Windows (npx)

Node.js 22.18 이상이 있으면 설치 없이 실행합니다. 데이터는 사용자 폴더(macOS `~/Library/Application Support/Skill Finder`, Linux `~/.local/share/skill-finder`, Windows `%LOCALAPPDATA%\SkillFinder\npx-data`)에 남습니다.

```bash
npx skill-finder
```

### Claude Code 안에서 쓰기

같은 명령에 읽기 전용 하위 명령이 있습니다. 앱이 꺼져 있으면 백그라운드로 켜고 결과만 출력하므로, Claude Code에게 "skill-finder로 pdf 스킬 찾아 줘"처럼 시킬 수 있습니다. 설치·삭제는 하지 않습니다(앱 화면의 확인 창에서만).

```bash
npx skill-finder search "pdf tables" --limit 5
npx skill-finder show gh:anthropics/skills:skills/pdf
npx skill-finder recommend          # 지금 폴더의 README와 비슷한 스킬
npx skill-finder installed --json
npx skill-finder stop               # 백그라운드로 켠 앱 끄기
```

`--json`은 기계가 읽는 출력, `--lang ko|en|ja`는 출력 언어입니다.

### 소스에서

필요한 것: Node.js 22.18 이상(24 권장), git, Claude Code(`claude` 명령).

```bash
npm install
npm start
```

이 저장소를 내려받은 폴더에서 실행한 뒤 브라우저로 http://127.0.0.1:4317 을 엽니다. 첫 실행 때는 스킬 색인을 모으느라 몇 분 걸립니다.

GitHub 토큰은 선택입니다. 설정 화면에서 넣거나 `.env`의 `GITHUB_TOKEN`에 적습니다(`.env.example` 참고). 공개 저장소 읽기만 되는 fine-grained 토큰이면 되고, GitHub 코드 검색과 빠른 색인에 쓰입니다.

## 안전과 개인 정보

- 서버는 127.0.0.1에만 열리고, Host 허용 목록·전용 요청 헤더·같은 출처 검사로 다른 사이트의 요청을 막습니다.
- 설치·삭제는 확인 창을 거친 뒤 `claude plugin` 또는 skills CLI를 셸 없이 실행합니다. 앱이 원격 스킬의 코드를 직접 실행하지 않습니다.
- 검색·추천에 AI를 부르지 않습니다. 설명 번역은 브라우저에 들어 있는 Translator API만 씁니다.
- 밖으로 나가는 요청은 GitHub API, skills.sh 검색, 마켓플레이스 저장소, 업데이트 확인뿐입니다.
- 색인과 설정은 `data/`(SQLite)에 남습니다. 검색 기록은 설정에서 끌 수 있습니다.

## 개발

```bash
npm run dev        # 서버(--watch) + Vite
npm test           # 서버·웹 테스트
npm run typecheck
```

- `server/`: Node가 TypeScript를 그대로 실행합니다(타입만 지우는 문법, import에 `.ts`). Express 5, `node:sqlite`.
- `web/`: React 19 + Vite, Tailwind v4 + shadcn/ui.
- `docs/DECISIONS.md`: 처음 명세와 다르게 정한 것들의 기록입니다. 고칠 때 먼저 확인하세요.

## 문제 신고

버그와 제안은 GitHub 이슈로 남겨 주세요. 설정 화면의 "진단 정보 복사" 내용을 붙이면 원인을 찾기 쉽습니다. 보안 문제는 [SECURITY.md](SECURITY.md)를 보세요.

## 라이선스

[MIT](LICENSE)
