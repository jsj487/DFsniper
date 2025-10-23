import { useEffect, useState } from "react";

type DropEvent = {
  id: string;
  type: "ancient-drop";
  serverId: string;
  characterId: string;
  itemName: string;
  itemId: string;
  time: string; // ISO
};

export default function App() {
  const [health, setHealth] = useState<string>("(요청 전)");
  const [log, setLog] = useState<string>("");
  const [events, setEvents] = useState<DropEvent[]>([]);

  // 서버 헬스체크
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/health");
        const j = await res.json();
        setHealth(JSON.stringify(j));
      } catch {
        setHealth("요청 실패");
      }
    })();
  }, []);

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
        // ping 이벤트 등 JSON이 아닐 수 있음
      }
    };

    es.onerror = () => {
      setLog((prev) => prev + "\n[SSE] error/reconnect...");
    };

    return () => es.close();
  }, []);

  // 구독 등록
  async function subscribe(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      serverId: String(fd.get("serverId") || "").trim(),
      characterId: String(fd.get("characterId") || "").trim(),
    };
    const res = await fetch("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    setLog((prev) => prev + `\n[SUBSCRIBE] ${JSON.stringify(j)}`);
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 16, lineHeight: 1.5 }}>
      <h1>DF Watcher — React + SSE</h1>

      <section>
        <h2>서버 헬스체크</h2>
        <pre>{health}</pre>
      </section>

      <section>
        <h2>구독 등록</h2>
        <form onSubmit={subscribe} style={{ display: "flex", gap: 8 }}>
          <input name="serverId" placeholder="cain/siroco/..." required />
          <input name="characterId" placeholder="캐릭터 ID" required />
          <button>등록</button>
        </form>
      </section>

      <section>
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

      <section>
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
