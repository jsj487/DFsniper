// server.js (ESM)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") }); // server.js와 같은 폴더의 .env를 확정 로드

/* =======================
   상수/유틸
======================= */
const API_HOST = "https://api.neople.co.kr";
const NEOPLE_API_KEY = (process.env.NEOPLE_API_KEY ?? "").trim();

if (!NEOPLE_API_KEY) {
  console.warn(
    "[WARN] NEOPLE_API_KEY 가 .env에 없습니다. 외부 API 호출이 실패합니다."
  );
} else {
  console.log(`[apikey] loaded, length=${NEOPLE_API_KEY.length}`);
}

// 네오플 타임라인 아이템 관련 코드(획득/보상/제작/업그레이드 등)
const ITEM_EVENT_CODES = [
  501, 502, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 516,
  517, 518, 519, 520, 521,
].join(",");

// 서버명 정규화(한글/영문 모두 허용)
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
  return SERVER_ID_MAP[key] || key;
}

// 유틸: 초단위 ISO
function isoSec(dt) {
  return new Date(dt).toISOString().slice(0, 19) + "Z";
}

// 유틸: '태초' 판정(보조)
function isAncientRarity(r) {
  return typeof r === "string" && /태초|mythic|ancient/i.test(r);
}

/* =======================
   앱/미들웨어
======================= */
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("combined"));

/* =======================
   네오플 API 래퍼
======================= */

// 닉네임으로 캐릭터 목록(완전일치 → 포함)
async function searchCharacters({ serverId, name, limit = 10 }) {
  const base = `${API_HOST}/df/servers/${encodeURIComponent(
    serverId
  )}/characters`;

  // 1) 완전일치
  const pCommon = { apikey: NEOPLE_API_KEY, characterName: name, limit };
  let { data } = await axios.get(base, {
    params: { ...pCommon, wordType: "full" },
    timeout: 10000,
  });
  let rows = Array.isArray(data?.rows) ? data.rows : [];

  // 2) 포함(match)
  if (rows.length === 0) {
    ({ data } = await axios.get(base, {
      params: { ...pCommon, wordType: "match" },
      timeout: 10000,
    }));
    rows = Array.isArray(data?.rows) ? data.rows : [];
  }
  return rows;
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
  return data;
}

// 타임라인 페이지네이션(안전한 next 처리 + /df 보정)
async function fetchTimelineAll({
  serverId,
  characterId,
  startISO,
  endISO,
  limit = 50,
}) {
  if (limit > 50) limit = 50;
  serverId = normalizeServerId(serverId);

  // ① 정상 베이스
  const base = `${API_HOST}/df/servers/${encodeURIComponent(
    serverId
  )}/characters/${encodeURIComponent(characterId)}/timeline`;

  // ② 첫 페이지는 params로
  let url = base;
  let params = {
    startDate: isoSec(startISO),
    endDate: isoSec(endISO),
    limit,
    code: ITEM_EVENT_CODES, // 콤마 그대로
    apikey: NEOPLE_API_KEY,
  };

  const out = [];
  for (let page = 0; page < 10; page++) {
    const safe = params ? { ...params, apikey: "[HIDDEN]" } : undefined;
    console.log("[timeline] GET", url, safe || "(no params)");

    const { data } = await axios.get(url, { params, timeout: 10000 });
    const rows = Array.isArray(data?.timeline?.rows) ? data.timeline.rows : [];
    out.push(...rows);

    const rawNext = data?.timeline?.next;
    console.log("[timeline] next(raw):", rawNext, "rows+", rows.length);
    if (!rawNext || typeof rawNext !== "string") break;

    // ③ next에서 '쿼리스트링만' 추출해서 베이스에 이식
    let qs = "";
    try {
      // 절대/상대 모두 허용해서 일단 URL 객체로 만든 뒤 search만 뽑음
      const u = /^https?:\/\//i.test(rawNext)
        ? new URL(rawNext)
        : new URL(
            rawNext.startsWith("/")
              ? `${API_HOST}${rawNext}`
              : `${API_HOST}/${rawNext}`
          );
      qs = u.search || "";
    } catch (e) {
      console.error(
        "[timeline] FAIL at",
        url,
        "status:",
        err?.response?.status,
        "body:",
        err?.response?.data || err.message
      );
      throw err;
    }

    // ④ apikey 보장
    const nextURL = new URL(base + qs);
    if (!nextURL.searchParams.has("apikey"))
      nextURL.searchParams.set("apikey", NEOPLE_API_KEY);
    url = nextURL.toString();
    params = undefined; // 다음 페이지부턴 url에 쿼리 포함
    console.log("[timeline] next(normalized):", url);
  }
  return out;
}

/* =======================
   도메인 로직: 요약
======================= */

function characterImageURL(serverId, characterId, zoom = 2) {
  return `https://img-api.neople.co.kr/df/servers/${encodeURIComponent(
    serverId
  )}/characters/${encodeURIComponent(characterId)}?zoom=${zoom}`;
}

function itemImageURL(itemId) {
  return `https://img-api.neople.co.kr/df/items/${encodeURIComponent(itemId)}`;
}

// 최근 90일 ‘태초’ 드랍 리스트(타임라인의 itemRarity 우선)
async function listAncientDrops({ serverId, characterId }) {
  const endISO = isoSec(new Date());
  const startISO = isoSec(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const events = await fetchTimelineAll({
    serverId,
    characterId,
    startISO,
    endISO,
    limit: 50,
  });
  if (!Array.isArray(events) || events.length === 0) return [];

  const drops = [];
  for (const ev of events) {
    const d = ev?.data || {};
    const itemId = d.itemId;
    if (!itemId) continue;

    // 타임라인 자체 희귀도 우선
    if (!isAncientRarity(d.itemRarity)) continue;

    drops.push({
      itemId,
      itemName: d.itemName,
      time: ev?.date || endISO,
      image: itemImageURL(itemId),
    });
  }
  // 최신순
  drops.sort((a, b) => b.time.localeCompare(a.time));
  return drops;
}

/* =======================
   라우트
======================= */

// 헬스체크
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 간단 구독 테이블
const subscriptions = new Map(); // key: `${serverId}:${characterId}`

app.post("/subscribe", (req, res) => {
  try {
    const serverId = String(req.body?.serverId || "").trim();
    const characterId = String(req.body?.characterId || "").trim();
    if (!serverId || !characterId) {
      return res
        .status(400)
        .json({ ok: false, message: "serverId, characterId 필요" });
    }
    const key = `${serverId}:${characterId}`;
    if (!subscriptions.has(key)) {
      subscriptions.set(key, {
        serverId,
        characterId,
        createdAt: new Date().toISOString(),
      });
    }
    return res.json({
      ok: true,
      serverId,
      characterId,
      count: subscriptions.size,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "subscribe failed" });
  }
});

// 닉네임 자동완성 (serverId + name)
app.get("/search-character", async (req, res) => {
  try {
    let serverId = normalizeServerId(String(req.query.serverId || ""));
    const name = String(req.query.name || "").trim();
    if (!serverId || !name) {
      return res
        .status(400)
        .json({ ok: false, message: "serverId, name 필요" });
    }
    const rows = await searchCharacters({ serverId, name, limit: 10 });
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// 캐릭터 요약(기본정보 + 최근 90일 태초 이력)
// - characterId 또는 characterName 중 하나만 줘도 됨
app.get("/character/summary", async (req, res) => {
  try {
    let serverId = normalizeServerId(String(req.query.serverId || ""));
    let characterId = String(req.query.characterId || "").trim();
    const characterName = String(req.query.characterName || "").trim();

    if (!serverId || (!characterId && !characterName)) {
      return res.status(400).json({
        ok: false,
        message: "serverId와 characterId(또는 characterName) 중 하나 필요",
      });
    }

    // 닉네임 → ID 변환
    if (!characterId) {
      const baseUrl = `${API_HOST}/df/servers/${encodeURIComponent(
        serverId
      )}/characters`;
      const { data: d1 } = await axios.get(baseUrl, {
        params: {
          apikey: NEOPLE_API_KEY,
          characterName,
          wordType: "full",
          limit: 10,
        },
        timeout: 10000,
      });
      let rows = Array.isArray(d1?.rows) ? d1.rows : [];
      if (rows.length === 0) {
        const { data: d2 } = await axios.get(baseUrl, {
          params: {
            apikey: NEOPLE_API_KEY,
            characterName,
            wordType: "match",
            limit: 10,
          },
          timeout: 10000,
        });
        rows = Array.isArray(d2?.rows) ? d2.rows : [];
      }
      if (rows.length === 0)
        return res.status(404).json({
          ok: false,
          message: "닉네임으로 캐릭터를 찾을 수 없습니다.",
        });
      const exact =
        rows.find((r) => r.characterName === characterName) || rows[0];
      characterId = exact.characterId;
    }

    // 기본정보
    const basic = await fetchCharacterBasic({ serverId, characterId });

    // 최근 90일 타임라인
    const endISO = isoSec(new Date());
    const startISO = isoSec(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const events = await fetchTimelineAll({
      serverId,
      characterId,
      startISO,
      endISO,
      limit: 50,
    });

    const ancientDrops = [];
    for (const ev of events) {
      const id = ev?.data?.itemId;
      if (!id) continue;
      const rarityFromTimeline = isAncientRarity(ev?.data?.itemRarity);
      if (rarityFromTimeline) {
        ancientDrops.push({
          itemId: id,
          itemName: ev?.data?.itemName,
          time: ev?.date,
          image: `https://img-api.neople.co.kr/df/items/${encodeURIComponent(
            id
          )}`,
        });
      }
    }
    ancientDrops.sort((a, b) => b.time.localeCompare(a.time));

    return res.json({
      ok: true,
      character: {
        serverId,
        characterId,
        characterName: basic?.characterName,
        level: basic?.level,
        jobName: basic?.jobName,
        jobGrowName: basic?.jobGrowName,
        image: `https://img-api.neople.co.kr/df/servers/${encodeURIComponent(
          serverId
        )}/characters/${encodeURIComponent(characterId)}?zoom=2`,
      },
      ancientDrops,
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const payload = e?.response?.data || {
      message: e.message || "unknown error",
    };
    console.error("[/character/summary] error", status, payload);
    return res.status(status).json({ ok: false, error: payload });
  }
});

const sseClients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  // 최초 인사 + 연결 확인용 ping
  res.write(`event: ping\ndata: "connected"\n\n`);
  sseClients.add(res);

  // 30초마다 keep-alive
  const timer = setInterval(() => {
    try {
      res.write(`event: ping\ndata: "${Date.now()}"\n\n`);
    } catch {}
  }, 30000);

  req.on("close", () => {
    clearInterval(timer);
    sseClients.delete(res);
  });
});

/* =======================
   서버 기동
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DF API server listening on :${PORT}`);
});
