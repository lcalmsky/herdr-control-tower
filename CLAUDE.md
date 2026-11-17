# herdr-control-tower 작업 규칙

## 배포는 main 에 push 하는 것으로 끝난다

- herdr.dev 갤러리는 GitHub release 나 태그를 보지 않는다. 공개 저장소에 `herdr-layout` 토픽이 붙어 있으면 기본 브랜치(`main`)를 읽어 한 시간 안에 반영한다 (`~/.config/herdr-app/AGENTS.md` 의 "To share one" 절).
- 갤러리가 읽는 파일은 `RECIPE.md` 와 `preview.png`, 그리고 `layouts/`·`mods/` 의 실파일이다. 이 셋이 서로 어긋나지 않게 한 커밋에서 같이 고친다.
- 저장소 토픽(`herdr`, `herdr-layout`)과 공개 설정은 건드리지 않는다.

## mod·레이아웃을 고칠 때마다 같이 할 일

1. **`RECIPE.md` 갱신.** 크기·색·배치·동작이 바뀌었으면 해당 줄을 실파일 기준으로 고친다. 다른 에이전트가 이 문서만 보고 같은 것을 다시 만들 수 있어야 한다.
2. **`art/preview.html` 갱신.** 샘플 데이터로 창을 재현한 사본이다. mod 의 크기·색·배치 변경을 같은 값으로 옮긴다.
3. **`preview.png`·`demo.gif` 재생성.** 아래 명령으로 만든다. 결과 크기는 2400×1440 PNG, 1200×720 GIF(20 fps, 168 프레임)다.
   ```sh
   npm i --no-save --prefix /tmp/tower-render playwright-core
   NODE_PATH=/tmp/tower-render/node_modules node art/render.mjs
   ```
   Google Chrome 과 ffmpeg 이 필요하다. 렌더한 PNG 를 열어 바뀐 부분을 눈으로 확인한다.
4. **설치본 동기화.** 내 Herdr 에서 바로 보려면 바꾼 mod 파일을 `~/.config/herdr-app/mods/<mod>/` 로 복사한다. 설치본은 심볼릭 링크가 아니라 복사본이다.
5. **README 의 권한 고지 확인.** mod 가 새로 `exec`·`hc`·네트워크·폴더 밖 파일 읽기를 하게 됐으면 README 의 "Before adding it" 목록에 적는다.

## herdr-shared 에서 vendor 한 파일

- 아래 파일의 정본은 [herdr-shared](https://github.com/lcalmsky/herdr-shared) 이고, 이 저장소는 그것을 `vendor/herdr-shared` 서브모듈로 참조한다. 사본은 `vendor/herdr-shared/tools/vendor.sh` 가 써 넣은 것이다. 여기서 직접 고치지 않는다.
  ```sh
  vendor/herdr-shared/tools/vendor.sh --list .
  ```
- 대상: `mods/claude-accounts/` 의 `cca`, `usage-tap.sh`, `usage-api.mjs`, `codex-usage.mjs`, `models.mjs` 와 `mods/pulse/scan.sh` (`herdr-shared.list` 가 그룹과 대상을 정한다).
- 공용 스크립트를 고칠 때는 herdr-shared 에서 고쳐 push 한 뒤 그 저장소에서 `tools/sync-themes.sh --commit --push` 를 돌린다. 이 저장소의 서브모듈 포인터가 그 커밋으로 올라가고, 사본이 다시 쓰인다.
- vendor 한 뒤 `./tools/check-vendor.sh` 와 `node --test tests/` 를 돌린다. check-vendor 는 `vendor/herdr-shared/tools/check-vendor.sh` 를 부르는 얇은 호출자이고, 서브모듈이 없으면 건너뛴다.

## claude-accounts mod 의 정본

- `mods/claude-accounts/` 의 `main.js`, `mod.json`(그리고 `fonts/`·아이콘)의 정본은 `~/git-repo/herdr-claude-accounts` 다. 이 저장소의 사본은 레이아웃이 싣기 위해 두는 복사본이다.
- 정본에서 그 파일을 고치면 같은 푸시에서 이 저장소의 `mods/claude-accounts/` 로도 그대로 복사한다. `main.js`, `mod.json` 이 두 사본에서 달라지면 안 된다.
- `cca`, `usage-tap.sh`, `usage-api.mjs`, `codex-usage.mjs`, `models.mjs` 는 위의 vendor 규칙을 따른다.

## 라이선스

`mods/tower-tabs` 는 Herdr 의 `tabs` mod 를 고친 것이라 Apache 2.0 이다. 이 폴더를 고치면 `main.js` 첫 줄의 수정 내역 주석도 같이 고친다.

## 미리보기 규칙 (herdr-* 저장소 공통)

이 절은 `~/git-repo/herdr-*` 저장소가 똑같이 싣는다. 한 곳에서 고치면 나머지 저장소의 같은 절도 같이 고친다.

- **레이아웃 선택 화면 그림.** 레이아웃이 있는 저장소는 `layouts/<name>.json` 루트에 `"preview": "layouts/<name>.png"` 를 두고 `layouts/<name>.png`(640×400)를 저장소에 싣는다. 필드나 그림 중 하나라도 없으면 Herdr 설정 화면에 빈 틀이 나온다 (`~/.config/herdr-app/AGENTS.md` 의 `preview` 항목).
- **설치는 JSON 과 PNG 를 같이 옮긴다.** 설치 스크립트와 README 의 복사 명령이 둘 다 옮기는지 확인한다. 설치본(`~/.config/herdr-app/layouts/`)에만 필드나 그림을 넣지 않는다. 다음 설치가 JSON 을 통째로 덮어써서 필드가 사라진다.
- **갤러리 그림.** herdr.dev 갤러리는 저장소 루트의 `preview.png` 를 보여 준다. 16:10(예: 2560×1600)으로 만들고, 선택 화면 그림은 같은 화면을 640×400 으로 줄여 쓴다.
- **공개되는 그림에는 지어낸 데모 데이터만 쓴다.** `preview.png`, `layouts/*.png`, README·docs 의 스크린샷과 GIF 가 대상이다. 화면 속 글은 전부 영어로 하고, 회사 업무가 드러나는 것이 보이지 않아야 한다: 티켓 키, 사내 저장소·서비스·채널 이름, 고객과 동료 이름, 실제 터미널 내용, 홈 경로의 계정 이름. 실제로 쓰는 창을 그대로 찍은 그림은 싣지 않는다.
- **모양을 바꾸면 같은 커밋에서 두 그림을 다시 만든다.** 커밋하기 전에 그림을 열어 위 항목을 눈으로 확인한다.
