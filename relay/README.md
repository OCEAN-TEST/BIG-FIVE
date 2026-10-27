# 분식집 중계 서버

친구들이 각자 다른 인터넷(LTE, 다른 집 와이파이)으로 접속해도 방에 잘 들어가지게, 모두 이 서버를 거쳐서 연결해요.
Cloudflare Workers 무료 플랜에서 돌아가요. 무료 한도를 넘으면 돈이 나가지 않고 그날만 멈춰요 (한국 시간 오전 9시에 다시 풀려요).
멈춘 날이나 서버가 안 될 때는 게임이 알아서 예전 방식(PeerJS)으로 연결해요.

## 올리는 법 (한 번만)

1. <https://dash.cloudflare.com> 에서 무료로 가입해요. 카드는 넣지 않아요.
2. **Workers & Pages** → **Create application** → **Import a repository** 를 골라요.
3. GitHub 계정을 연결하고 `ocean-test/big-five` 저장소를 골라요.
4. 설정
   - 이름(Project name): `bunsik-relay` (꼭 이 이름. `wrangler.toml`의 `name`과 같아야 해요)
   - Root directory (Advanced settings 안): `relay`
   - Build command: 비워 둬요
   - Deploy command: `npx wrangler deploy` (기본값 그대로)
5. **Save and Deploy**. 끝나면 `https://bunsik-relay.<내 이름>.workers.dev` 주소가 생겨요.
6. 게임의 `duo/index.html`에서 `RELAY_HOME`에 그 주소를 `wss://`로 바꿔서 넣어요.
   예: `wss://bunsik-relay.<내 이름>.workers.dev`

그 뒤로는 `main`에 `relay/` 폴더가 바뀌어 올라오면 Cloudflare가 알아서 다시 올려요.

## 이 컴퓨터에서 시험하기

```
cd relay && npx wrangler dev --port 8787
```

그다음 게임 주소 끝에 `?relay=ws://localhost:8787` 을 붙여서 열어요.

## 운영자 페이지

`https://bunsik-relay.alamguy.workers.dev/stats?k=열쇠` 에서 지금 열린 방 코드·인원, 오늘 연 방 수를 볼 수 있어요.
방 코드·인원 숫자만 모으고 이름·채팅은 안 모아요. 방마다 "관전" 버튼을 누르면 운영자 관전(`?watch=코드&mod`)으로 열리고,
그 방 모두의 화면 오른쪽 위에 "Mod Spectating"이 떠요.

술래잡기(`tag/`) 방도 같은 중계 서버를 써요. 운영자 페이지에는 "술래잡기"로 따로 보이고, 관전 버튼은 없어요.

열쇠 자체는 저장소에 없고 SHA-256 값만 있어요. 열쇠를 바꾸려면 Cloudflare 대시보드의 bunsik-relay →
Settings → Variables and Secrets 에 비밀 값(Secret) `STATS_KEY`를 넣으면 그 값으로도 열려요.
