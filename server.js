import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";

dotenv.config();

/* =======================
   상수/맵/유틸
======================= */
const API_HOST = "https://api.neople.co.kr";
const NEOPLE_API_KEY = process.env.NEOPLE_API_KEY || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const POLL_INTERVAL_SEC = 15;
const DEDUPE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

const ITEM_EVENT_CODES = [
  501, 502, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 516,
  517, 518, 519, 520, 521,
].join(",");

// 서버명 정규화(한글 허용)
const SERVER_ID_MAP = {
  cain: "cain",
  siroco: "siroco",
  diregie: "diregie",
  hilder: "hilder",
  prey: "prey",
  anton: "anton",
  bakal: "bakal",
  casillas: "casillas",
  카인: "cain",
  시로코: "siroco",
  디레지에: "diregie",
  힐더: "hilder",
  프레이: "prey",
  안톤: "anton",
  바칼: "bakal",
  카시야스: "casillas",
};
function normalizeServerId(input) {
  if (!input) return "";
  const key = String(input).trim().toLowerCase();
  if (SERVER_ID_MAP[key]) return SERVER_ID_MAP[key];
  const kr = Object.keys(SERVER_ID_MAP).find((k) => k.toLowerCase() === key);
  return kr ? SERVER_ID_MAP[kr] : key;
}

/* =======================
   앱/미들웨어
======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(helmet());
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: 60_000, max: 300 })); // 분당 300요청

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =======================
   헬스체크
======================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* =======================
   SSE 상태/구독/중복캐시
======================= */
const sseClients = new Set(); // Set<express.Response>
const subscriptions = new Map(); // key: `${serverId}:${characterId}`
const sentKeys = new Map(); // key: `${serverId}:${characterId}:${itemId}:${timeISO}` -> expireAt

function sseBroadcast(eventObj) {
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {}
  }
}
function makeEventKey({ serverId, characterId, itemId, timeISO }) {
  return `${serverId}:${characterId}:${itemId}:${timeISO}`;
}
function putDedupe(key) {
  sentKeys.set(key, Date.now() + DEDUPE_TTL_MS);
}
function hasDedupe(key) {
  const exp = sentKeys.get(key);
  if (!exp) return false;
  if (exp < Date.now()) {
    sentKeys.delete(key);
    return false;
  }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of sentKeys.entries()) if (exp < now) sentKeys.delete(k);
}, 60_000);

/* =======================
   Discord Webhook (임베드)
======================= */
async function notifyDiscordDrop({
  serverId,
  characterId,
  itemName,
  itemId,
  time,
}) {
  if (!DISCORD_WEBHOOK_URL) return;
  const img = `https://img-api.dfoneople.com/df/items/${encodeURIComponent(
    itemId
  )}`;
  const payload = {
    content: `🎉 [${serverId}/${characterId}] 태초 아이템 획득!`,
    embeds: [
      {
        title: itemName,
        description: `획득 시각: ${time}`,
        thumbnail: { url: img },
      },
    ],
  };
  await axios.post(DISCORD_WEBHOOK_URL, payload);
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
  res.flushHeaders?.();
  res.write(`event: ping\ndata: "connected"\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

/* =======================
   캐릭터 검색(닉네임 → 목록)
======================= */
app.get("/search-character", async (req, res) => {
  try {
    let serverId = String(req.query.serverId || "");
    const name = String(req.query.name || "");
    if (!serverId || !name)
      return res
        .status(400)
        .json({ ok: false, message: "serverId, name 필요" });

    serverId = normalizeServerId(serverId);
    const url = `${API_HOST}/df/servers/${encodeURIComponent(
      serverId
    )}/characters`;
    const { data } = await axios.get(url, {
      params: { characterName: name, limit: 10, apikey: NEOPLE_API_KEY },
      timeout: 10000,
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =======================
   구독 등록 (닉네임 전용)
======================= */
app.post("/subscribe-name", async (req, res) => {
  try {
    let { serverId, characterName, limit = 10 } = req.body ?? {};
    if (!serverId || !characterName)
      return res
        .status(400)
        .json({ ok: false, message: "serverId, characterName 필수" });

    serverId = normalizeServerId(serverId);
    const baseUrl = `${API_HOST}/df/servers/${encodeURIComponent(
      serverId
    )}/characters`;
    const common = { apikey: NEOPLE_API_KEY, limit };

    // (1) 완전일치 → (2) match
    const { data: d1 } = await axios.get(baseUrl, {
      params: { ...common, characterName, wordType: "full" },
      timeout: 10000,
    });
    let candidates = Array.isArray(d1?.rows) ? d1.rows : [];
    if (candidates.length === 0) {
      const { data: d2 } = await axios.get(baseUrl, {
        params: { ...common, characterName, wordType: "match" },
        timeout: 10000,
      });
      candidates = Array.isArray(d2?.rows) ? d2.rows : [];
    }
    if (candidates.length === 0)
      return res
        .status(404)
        .json({ ok: false, message: "닉네임으로 캐릭터를 찾을 수 없음" });

    const exact =
      candidates.find((r) => r.characterName === characterName) ||
      candidates[0];
    const characterId = exact?.characterId;
    if (!characterId)
      return res
        .status(404)
        .json({ ok: false, message: "characterId 획득 실패" });

    const key = `${serverId}:${characterId}`;
    subscriptions.set(key, {
      serverId,
      characterId,
      lastCheckedISO: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    res.json({
      ok: true,
      serverId,
      characterId,
      characterName: exact.characterName,
      count: subscriptions.size,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =======================
   구독 등록 (ID 직접)
   - 닉네임이 들어오면 자동 변환
======================= */
app.post("/subscribe", async (req, res) => {
  try {
    let { serverId, characterId } = req.body ?? {};
    if (!serverId || !characterId)
      return res
        .status(400)
        .json({ ok: false, message: "serverId, characterId 필수" });

    serverId = normalizeServerId(serverId);
    characterId = String(characterId).trim();

    // 닉네임으로 보이면 변환
    const looksLikeName = /[^\w-]/.test(characterId);
    if (looksLikeName) {
      const url = `${API_HOST}/df/servers/${encodeURIComponent(
        serverId
      )}/characters`;
      const { data } = await axios.get(url, {
        params: {
          characterName: characterId,
          wordType: "full",
          limit: 5,
          apikey: NEOPLE_API_KEY,
        },
        timeout: 10000,
      });
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const exact =
        rows.find((r) => r.characterName === characterId) || rows[0];
      if (!exact?.characterId)
        return res
          .status(404)
          .json({ ok: false, message: "닉네임으로 characterId를 찾지 못함" });
      characterId = exact.characterId;
    }

    const key = `${serverId}:${characterId}`;
    subscriptions.set(key, {
      serverId,
      characterId,
      lastCheckedISO: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true, serverId, characterId, count: subscriptions.size });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =======================
   네오플 API 유틸
======================= */
async function fetchTimelineAll({
  serverId,
  characterId,
  startISO,
  endISO,
  limit = 50,
}) {
  serverId = normalizeServerId(serverId);
  let url =
    `${API_HOST}/df/servers/${encodeURIComponent(serverId)}` +
    `/characters/${encodeURIComponent(characterId)}/timeline` +
    `?startDate=${encodeURIComponent(startISO)}` +
    `&endDate=${encodeURIComponent(endISO)}` +
    `&limit=${limit}` +
    `&code=${encodeURIComponent(ITEM_EVENT_CODES)}` +
    `&apikey=${encodeURIComponent(NEOPLE_API_KEY)}`;

  const collected = [];
  for (let page = 0; page < 10; page++) {
    const { data } = await axios.get(url, { timeout: 10000 });
    const tl = Array.isArray(data?.timeline) ? data.timeline : [];
    collected.push(...tl);
    const next = data?.next;
    if (!next) break;
    url = next;
  }
  return collected;
}
async function fetchItemsDetail(itemIds) {
  const unique = [...new Set(itemIds)].slice(0, 15);
  if (unique.length === 0) return [];
  const url = `${API_HOST}/df/multi/items`;
  const { data } = await axios.get(url, {
    params: { itemIds: unique.join(","), apikey: NEOPLE_API_KEY },
    timeout: 10000,
  });
  return Array.isArray(data?.rows) ? data.rows : [];
}

/* =======================
   폴링 루프
======================= */
async function handleOneSubscription(sub) {
  const endISO = new Date().toISOString();
  const startISO =
    sub.lastCheckedISO ||
    new Date(Date.now() - POLL_INTERVAL_SEC * 1000).toISOString();

  try {
    const events = await fetchTimelineAll({
      serverId: sub.serverId,
      characterId: sub.characterId,
      startISO,
      endISO,
    });
    if (events.length === 0) {
      sub.lastCheckedISO = endISO;
      return;
    }

    const itemIds = events.map((ev) => ev?.data?.itemId).filter(Boolean);
    const details = await fetchItemsDetail(itemIds);
    const byId = new Map(details.map((it) => [it.itemId, it]));

    for (const ev of events) {
      const itemId = ev?.data?.itemId;
      if (!itemId) continue;
      const info = byId.get(itemId);
      if (!info) continue;

      if (info.rarity === "태초") {
        const timeISO = ev?.date || endISO;
        const key = makeEventKey({
          serverId: sub.serverId,
          characterId: sub.characterId,
          itemId,
          timeISO,
        });
        if (hasDedupe(key)) continue;

        const payload = {
          id: key,
          type: "ancient-drop",
          serverId: sub.serverId,
          characterId: sub.characterId,
          itemName: info.itemName || "무명 아이템",
          itemId,
          time: timeISO,
        };

        sseBroadcast(payload);
        await notifyDiscordDrop(payload);
        putDedupe(key);
      }
    }
    sub.lastCheckedISO = endISO;
  } catch (e) {
    console.error(
      "timeline error:",
      sub.serverId,
      sub.characterId,
      e?.response?.status || e?.code || e?.message,
      e?.response?.data || ""
    );
  }
}

// 캐릭터 기본정보
async function fetchCharacterBasic({ serverId, characterId }) {
  const url = `${API_HOST}/df/servers/${encodeURIComponent(
    serverId
  )}/characters/${encodeURIComponent(characterId)}`;
  const { data } = await axios.get(url, {
    params: { apikey: NEOPLE_API_KEY },
    timeout: 10000,
  });
  return data; // { characterId, characterName, level, jobName, jobGrowName, ... }
}

// 타임라인에서 '태초' 드랍만 추려 리스트 만들기 (최대 90일)
async function listAncientDrops({ serverId, characterId }) {
  const endISO = new Date().toISOString();
  const startISO = new Date(
    Date.now() - 90 * 24 * 60 * 60 * 1000
  ).toISOString();

  // 기존 fetchTimelineAll 재사용: &code=501..521 포함(아이템 관련 이벤트만) — 응답량 감소
  const events = await fetchTimelineAll({
    serverId,
    characterId,
    startISO,
    endISO,
    limit: 100,
  });
  if (!Array.isArray(events) || events.length === 0) return [];

  // itemId 수집 → 다건 상세 조회(최대 15개/회, 여기선 간단히 15개 단위 배치)
  const itemIds = events.map((ev) => ev?.data?.itemId).filter(Boolean);
  const batches = [];
  const uniq = [...new Set(itemIds)];
  for (let i = 0; i < uniq.length; i += 15) batches.push(uniq.slice(i, i + 15));

  const byId = new Map();
  for (const ids of batches) {
    const rows = await fetchItemsDetail(ids);
    rows.forEach((r) => byId.set(r.itemId, r)); // {itemId, itemName, rarity, ...}
  }

  // “태초”만 필터링하여 정렬(최신 먼저)
  const drops = [];
  for (const ev of events) {
    const itemId = ev?.data?.itemId;
    if (!itemId) continue;
    const info = byId.get(itemId);
    if (!info || info.rarity !== "태초") continue;
    drops.push({
      itemId,
      itemName: info.itemName,
      time: ev?.date || endISO,
      // 아이템 이미지 URL (공식 공지 안내) :contentReference[oaicite:2]{index=2}
      image: `https://img-api.neople.co.kr/df/items/${encodeURIComponent(
        itemId
      )}`,
    });
  }
  drops.sort((a, b) => b.time.localeCompare(a.time));
  return drops;
}

// 캐릭터 요약 API
app.get("/character/summary", async (req, res) => {
  try {
    let serverId = normalizeServerId(String(req.query.serverId || ""));
    let { characterId, characterName } = req.query ?? {};
    characterId = characterId ? String(characterId).trim() : "";
    characterName = characterName ? String(characterName).trim() : "";

    if (!serverId || (!characterId && !characterName)) {
      return res.status(400).json({
        ok: false,
        message: "serverId와 characterId(또는 characterName) 중 하나 필요",
      });
    }

    // 닉네임으로 들어오면 ID 변환 (완전일치→match 순서)
    if (!characterId && characterName) {
      const baseUrl = `${API_HOST}/df/servers/${encodeURIComponent(
        serverId
      )}/characters`;
      const common = { apikey: NEOPLE_API_KEY, limit: 10 };

      const { data: d1 } = await axios.get(baseUrl, {
        params: { ...common, characterName, wordType: "full" },
        timeout: 10000,
      });
      let candidates = Array.isArray(d1?.rows) ? d1.rows : [];
      if (candidates.length === 0) {
        const { data: d2 } = await axios.get(baseUrl, {
          params: { ...common, characterName, wordType: "match" },
          timeout: 10000,
        });
        candidates = Array.isArray(d2?.rows) ? d2.rows : [];
      }
      if (candidates.length === 0)
        return res
          .status(404)
          .json({ ok: false, message: "닉네임으로 캐릭터를 찾을 수 없음" });
      const exact =
        candidates.find((r) => r.characterName === characterName) ||
        candidates[0];
      characterId = exact.characterId;
      // 조회된 정확한 닉네임으로 덮어두기
      characterName = exact.characterName;
    }

    // 기본정보
    const basic = await fetchCharacterBasic({ serverId, characterId }); // endpoint 존재(캐릭터 기본 정보) :contentReference[oaicite:3]{index=3}

    const characterImage = `https://img-api.neople.co.kr/df/servers/${encodeURIComponent(
      serverId
    )}/characters/${encodeURIComponent(characterId)}?zoom=2`;

    // 90일간 ‘태초’ 드랍 리스트
    const ancientDrops = await listAncientDrops({ serverId, characterId });

    return res.json({
      ok: true,
      character: {
        serverId,
        characterId,
        characterName: characterName || basic?.characterName,
        level: basic?.level,
        jobName: basic?.jobName,
        jobGrowName: basic?.jobGrowName,
        image: characterImage,
      },
      ancientDrops,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.response?.data || e.message });
  }
});

setInterval(async () => {
  if (subscriptions.size === 0 || !NEOPLE_API_KEY) return;
  const now = Date.now();
  for (const [, sub] of subscriptions) {
    const last = sub._lastRunAt || 0;
    if (now - last < POLL_INTERVAL_SEC * 1000 - 200) continue;
    sub._lastRunAt = now;
    await handleOneSubscription(sub);
  }
}, 1000);

/* =======================
   서버 시작
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DF watcher listening on :${PORT}`);
});
