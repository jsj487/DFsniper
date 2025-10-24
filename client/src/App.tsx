import { useEffect, useState } from "react";

/** 서버에서 푸시되는 드랍 이벤트(SSE) */
type DropEvent = {
  id: string;
  type: "ancient-drop";
  serverId: string;
  characterId: string;
  itemName: string;
  itemId: string;
  time: string;
};

/** 캐릭터 검색 결과 */
type CharacterCandidate = {
  characterId: string;
  characterName: string;
  level: number;
  jobName: string;
  jobGrowName: string;
};

/** 요약 응답 */
type Summary = {
  ok: boolean;
  character: {
    serverId: string;
    characterId: string;
    characterName: string;
    level: number;
    jobName: string;
    jobGrowName: string;
    image: string;
  };
  ancientDrops: {
    itemId: string;
    itemName: string;
    time: string;
    image: string;
  }[];
};

export default function App() {
  const [log, setLog] = useState<string>("");
  const [events, setEvents] = useState<DropEvent[]>([]);

  // 닉네임 검색/선택 관련 상태
  const [candidates, setCandidates] = useState<CharacterCandidate[]>([]);
  const [selected, setSelected] = useState<CharacterCandidate | null>(null);
  const [selectedServer, setSelectedServer] = useState<string>("casillas"); // 셀렉트의 현재 값 동기화

  // 등록 완료 후의 요약(최근 90일 태초 리스트)
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // SSE 연결
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      setLog((prev) => prev + `\n[SSE] ${ev.data}`);
      try {
        const obj = JSON.parse(ev.data) as DropEvent;
        if (obj?.id) {
          setEvents((prev) => {
            if (prev.some((p) => p.id === obj.id)) return prev;
            const next = [obj, ...prev];
            next.sort((a, b) => b.time.localeCompare(a.time));
            return next.slice(0, 100);
          });
        }
      } catch {
        /* ping 등 */
      }
    };
    es.onerror = () => setLog((prev) => prev + "\n[SSE] error/reconnect...");
    return () => es.close();
  }, []);

  // 자동완성 검색
  async function search(e: React.ChangeEvent<HTMLInputElement>) {
    const name = e.target.value.trim();
    const serverSel = document.querySelector(
      'select[name="serverId"]'
    ) as HTMLSelectElement | null;
    const serverId = serverSel ? serverSel.value : "casillas";
    setSelectedServer(serverId);
    setSelected(null);
    setSummary(null);

    if (!name) return setCandidates([]);
    const r = await fetch(
      `/search-character?serverId=${encodeURIComponent(
        serverId
      )}&name=${encodeURIComponent(name)}`
    );
    const j = await r.json();
    const rows = Array.isArray(j?.rows) ? j.rows.slice(0, 8) : [];
    setCandidates(rows);
  }

  // 캐릭터 이미지 URL (네오플 img-api 규칙)
  function characterImageURL(serverId: string, characterId: string, zoom = 2) {
    return `https://img-api.neople.co.kr/df/servers/${encodeURIComponent(
      serverId
    )}/characters/${encodeURIComponent(characterId)}?zoom=${zoom}`;
  }

  // 등록(선택한 후보를 구독 + 요약 불러오기)
  async function registerSelected() {
    if (!selected) return;
    setBusy(true);
    try {
      // 1) 구독 등록: ID로 바로 등록(/subscribe 사용)
      const res1 = await fetch("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: selectedServer,
          characterId: selected.characterId,
        }),
      });
      const j1 = await res1.json();
      setLog((prev) => prev + `\n[SUBSCRIBE(id)] ${JSON.stringify(j1)}`);

      // 2) 요약(최근 90일 태초 드랍) 조회
      const params = new URLSearchParams({
        serverId: selectedServer,
        characterId: selected.characterId,
      });
      const res2 = await fetch(`/character/summary?${params.toString()}`);
      const j2: Summary = await res2.json();
      setLog(
        (prev) =>
          prev +
          `\n[SUMMARY] ${JSON.stringify({
            ok: j2.ok,
            drops: j2?.ancientDrops?.length,
          })}`
      );
      if (j2.ok) setSummary(j2);

      // UI 정리: 후보 리스트 접기
      setCandidates([]);
    } catch (e: any) {
      setLog((prev) => prev + `\n[ERR] ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 16, lineHeight: 1.5 }}>
      <h1>DF Watcher</h1>

      {/* 닉네임으로 구독 등록(검색창 유지) */}
      <section>
        <h2>닉네임으로 캐릭터 검색</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "160px 1fr",
            gap: 8,
            alignItems: "center",
          }}
        >
          <select
            name="serverId"
            defaultValue="casillas"
            onChange={(e) => setSelectedServer(e.currentTarget.value)}
          >
            <option value="casillas">카시야스</option>
            <option value="cain">카인</option>
            <option value="siroco">시로코</option>
            <option value="diregie">디레지에</option>
            <option value="hilder">힐더</option>
            <option value="prey">프레이</option>
            <option value="anton">안톤</option>
            <option value="bakal">바칼</option>
          </select>

          <input
            name="characterName"
            placeholder="캐릭터 닉네임"
            onChange={search}
          />
        </div>

        {/* 후보 리스트 */}
        {candidates.length > 0 && (
          <ul style={{ margin: "12px 0 0", paddingLeft: 16 }}>
            {candidates.map((c) => (
              <li
                key={c.characterId}
                style={{ cursor: "pointer", marginBottom: 6 }}
                onClick={() => {
                  setSelected(c);
                  setSummary(null);
                }}
                title="이 후보를 선택"
              >
                {c.characterName} · Lv.{c.level} · {c.jobGrowName}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 선택된 캐릭터 확인 카드 (+ 등록 버튼) */}
      {selected && (
        <section style={{ marginTop: 16 }}>
          <h2>이 캐릭터가 맞나요?</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: 16,
              alignItems: "start",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <img
              src={characterImageURL(selectedServer, selected.characterId, 2)}
              alt="character"
              width={220}
              height={250}
              style={{ borderRadius: 8, background: "#111" }}
            />
            <div>
              <h3 style={{ margin: "0 0 6px" }}>
                {selected.characterName} (Lv.{selected.level}) —{" "}
                {selected.jobName} / {selected.jobGrowName}
              </h3>
              <p style={{ margin: "0 0 12px", color: "#666" }}>
                서버: {selectedServer} · ID: {selected.characterId}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={registerSelected} disabled={busy}>
                  {busy ? "등록 중..." : "이 캐릭터 등록"}
                </button>
                <button
                  onClick={() => {
                    setSelected(null);
                    setSummary(null);
                  }}
                >
                  다시 검색
                </button>
              </div>
              <p style={{ marginTop: 8, color: "#666" }}>
                * 등록하면 실시간 알림(SSE/디스코드) + 아래에 최근 90일 ‘태초’
                드랍 이력이 표시됩니다.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* 등록 후 보여줄: 최근 90일 ‘태초’ 드랍 리스트 */}
      {summary && (
        <section style={{ marginTop: 16 }}>
          <h2>최근 90일 ‘태초’ 드랍 이력</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: 16,
              alignItems: "start",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <img
              src={summary.character.image}
              alt="character"
              width={220}
              height={250}
              style={{ borderRadius: 8, background: "#111" }}
            />
            <div>
              <h3 style={{ margin: "0 0 6px" }}>
                {summary.character.characterName} (Lv.{summary.character.level})
                — {summary.character.jobName} / {summary.character.jobGrowName}
              </h3>
              <p style={{ margin: "0 0 12px", color: "#666" }}>
                서버: {summary.character.serverId} · ID:{" "}
                {summary.character.characterId}
              </p>

              {summary.ancientDrops.length === 0 ? (
                <p>최근 90일 기록 없음</p>
              ) : (
                <ul>
                  {summary.ancientDrops.map((d) => (
                    <li
                      key={`${d.itemId}-${d.time}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "28px 1fr",
                        gap: 8,
                        alignItems: "center",
                        marginBottom: 6,
                      }}
                    >
                      <img
                        src={d.image}
                        width={28}
                        height={28}
                        alt={d.itemName}
                      />
                      <span>
                        [{d.time}] {d.itemName} ({d.itemId})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 실시간 수신 이벤트 */}
      <section style={{ marginTop: 16 }}>
        <h2>수신 이벤트(최근 100)</h2>
        <ul>
          {events.map((ev) => (
            <li key={ev.id}>
              [{ev.time}] {ev.serverId}/{ev.characterId} — {ev.itemName}(
              {ev.itemId})
            </li>
          ))}
        </ul>
      </section>

      {/* 로그 */}
      <section style={{ marginTop: 16 }}>
        <h2>로그</h2>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#111",
            color: "#ddd",
            padding: 12,
          }}
        >
          {log || "(로그 없음)"}
        </pre>
      </section>
    </main>
  );
}
