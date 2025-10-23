import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 정적 파일 제공(선택): ./public 폴더가 있으면 사용
app.use(express.static(path.join(__dirname, "public")));

// 헬스체크
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* =======================
   SSE 상태 및 유틸
======================= */
// 연결된 SSE 응답 스트림
const sseClients = new Set(); // Set<express.Response>

// 구독 목록(데모용 메모리 저장)
// key: `${serverId}:${characterId}` -> { serverId, characterId, createdAt }
const subscriptions = new Map();

function sseBroadcast(eventObj) {
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // 오류 시 자동 정리되므로 무시
    }
  }
}

/* =======================
   SSE 엔드포인트
======================= */
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // 일부 환경에선 flush 필요
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // 접속 확인용 핑
  res.write(`event: ping\ndata: "connected"\n\n`);

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

/* =======================
   구독 등록 API
======================= */
app.post("/subscribe", (req, res) => {
  const { serverId, characterId } = req.body ?? {};
  if (!serverId || !characterId) {
    return res
      .status(400)
      .json({ ok: false, message: "serverId, characterId 필수" });
  }
  const key = `${serverId}:${characterId}`;
  subscriptions.set(key, {
    serverId,
    characterId,
    createdAt: new Date().toISOString(),
  });
  return res.json({ ok: true, count: subscriptions.size });
});

/* =======================
   모의 이벤트 루프(10초)
   - 프론트/SSE 연동 확인 용도
   - 실제 DF API 연동은 다음 단계에서 교체
======================= */
setInterval(() => {
  if (subscriptions.size === 0) return;

  const now = new Date().toISOString();
  const firstEntry = subscriptions.entries().next().value;
  if (!firstEntry) return;

  const [, any] = firstEntry;
  const evt = {
    id: `${now}`, // 실제 구현 시 타임라인 이벤트ID/조합키로 교체 권장
    type: "ancient-drop",
    serverId: any.serverId,
    characterId: any.characterId,
    itemName: "모의 태초 아이템",
    itemId: "FAKE-ITEM-ID",
    time: now,
  };

  sseBroadcast(evt);
}, 10_000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DF watcher listening on :${PORT}`);
});
