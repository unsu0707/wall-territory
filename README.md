# Wall Territory (벽 영토전)

2~4명이 온라인으로 함께 하는 벽 쌓기 영역 게임입니다. 서버(Node.js + WebSocket)가 규칙을 판정하고, 브라우저만 있으면 참가할 수 있습니다.

## 실행

```bash
npm install
npm start            # 0.0.0.0:3000 에서 대기, 같은 네트워크 주소도 출력 (PORT=4321 npm start 로 포트 변경)
npm test             # 봇 3명이 한 판을 끝까지 두는 자동 테스트
```

## GitHub Pages로 하기 (서버 없음)

`public/` 폴더는 정적 사이트라서 GitHub Pages에 그대로 올라갑니다. main에 push하면 `.github/workflows/pages.yml`이 자동 배포합니다(저장소 Settings → Pages → Source를 **GitHub Actions**로).

이때는 **방을 만든 사람의 브라우저가 서버 역할**을 하고, 참가자는 WebRTC(PeerJS)로 직접 연결됩니다. PeerJS 공개 서버는 처음 연결을 이어주는 데만 쓰입니다.

- 방장이 탭을 닫으면 방이 끝납니다. 새로고침은 괜찮습니다(게임 상태 복원).
- 아주 엄격한 회사/학교 네트워크나 일부 모바일 회선에서는 직접 연결이 안 될 수 있습니다(TURN 서버 미사용).
- 페이지가 `/healthz`에 응답하는 Node 서버에서 열리면 자동으로 WebSocket 모드, 아니면 P2P 모드가 됩니다. `?mode=p2p`로 강제할 수 있습니다.

## 친구와 같이 하기 (Node 서버)

- **같은 와이파이**: 내 컴퓨터 IP(예: `http://192.168.0.12:3000`)로 접속하면 됩니다.
- **인터넷으로 바로**: `cloudflared tunnel --url http://localhost:3000` (Homebrew: `brew install cloudflared`) → 나오는 `https://….trycloudflare.com` 주소를 공유.
- **상시 배포**: Render / Railway / Fly.io 같은 Node 호스팅에 이 폴더를 올리고 시작 명령을 `npm start`로 두면 됩니다. WebSocket은 같은 포트를 쓰므로 추가 설정이 필요 없습니다. 방 정보는 메모리에만 있어서 서버가 재시작되면 사라집니다.

## 규칙

1. 방장이 시작하면 자리 순서가 무작위로 정해지고, 뱀 순서(1→2→3→3→2→1…)로 말을 놓습니다. (기본: 2명 4개, 3명 3개, 4명 2개)
2. 내 차례에는 말 하나를 상하좌우로 0~2칸 움직이고(벽·다른 말 통과 불가), 그 말이 선 칸의 네 변 중 하나에 반드시 벽을 세웁니다.
3. 내 말이 모두 다른 사람과 분리된 구역에 들어가면 "봉인"되어 턴이 오지 않습니다.
4. 모두 봉인되면 끝. 내 말만 있는 구역의 칸 수 합이 점수이고, 동점이면 가장 큰 단일 구역으로 가립니다.
5. 제한 시간을 넘기면 제자리에서 무작위 벽이 세워집니다.

방장은 보드 크기(5~11), 1인당 말 수, 이동 칸 수, 제한 시간을 바꿀 수 있습니다.

## 구조

- `public/engine.js` — 방/턴/타이머/수 검증 엔진 (Node 서버와 P2P 방장 브라우저가 같이 씀)
- `public/net.js` — WebSocket / P2P 전송 계층
- `public/i18n.js` — 한국어 / 日本語
- `server.js` — (선택) 정적 파일 + WebSocket 서버, 0.0.0.0 바인딩
- `public/rules.js` — 이동 가능 칸, 벽, 구역 계산 (서버와 브라우저가 같이 씀)
- `public/client.js`, `index.html`, `style.css` — 화면
