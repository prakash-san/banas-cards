/**
 * Reproduces the reconnect/close race that orphaned players and broke
 * next-round / assign. Exits 0 on success.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = 3500 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);

    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }

    ws.on("message", onMessage);
  });
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function main() {
  const server = spawn("npx", ["tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let ready = false;
  server.stdout.on("data", (buf) => {
    if (String(buf).includes("running")) ready = true;
  });
  server.stderr.on("data", (buf) => process.stderr.write(buf));

  for (let i = 0; i < 40 && !ready; i++) await sleep(100);
  if (!ready) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // ignore
    }
    throw new Error("Server failed to start");
  }

  try {
    // --- Race: reconnect then close the old socket ---
    const ws1 = await openWs();
    ws1.send(JSON.stringify({ type: "create-vs-ai", playerName: "Tester", aiCount: 1 }));
    const joined = await waitForMessage(ws1, (m) => m.type === "joined");
    const { playerId, roomCode } = joined;

    // Wait until assignment phase
    let state = joined.state;
    if (state?.phase !== "assigning") {
      const msg = await waitForMessage(ws1, (m) => {
        if (m.type !== "state") return false;
        const s = m.states?.[playerId];
        return s?.phase === "assigning";
      });
      state = msg.states[playerId];
    }

    // New connection reconnects (as a refreshed tab would)
    const ws2 = await openWs();
    ws2.send(JSON.stringify({ type: "reconnect", playerId, roomCode }));
    const reconnected = await waitForMessage(
      ws2,
      (m) => m.type === "reconnected" && m.roomCode === roomCode
    );

    // Old tab closes AFTER reconnect — previously wiped the new socket
    await new Promise((resolve) => {
      ws1.once("close", resolve);
      ws1.close();
    });
    await sleep(150);

    let live = reconnected.state;
    if (live?.phase === "assigning" && !live.myAssignment) {
      const hand = live.myHand;
      const assignment = {
        power: hand[0].id,
        speed: hand[1].id,
        intelligence: hand[2].id,
      };
      ws2.send(JSON.stringify({ type: "assign", assignment }));
      const summary = await waitForMessage(ws2, (m) => {
        if (m.type !== "state") return false;
        const s = m.states?.[playerId];
        return s?.phase === "round-summary";
      }, 8000);
      live = summary.states[playerId];
    } else if (live?.phase !== "round-summary") {
      const summary = await waitForMessage(ws2, (m) => {
        if (m.type !== "state") return false;
        const s = m.states?.[playerId];
        return s?.phase === "round-summary";
      }, 8000);
      live = summary.states[playerId];
    }

    const roundBefore = live.round;
    ws2.send(JSON.stringify({ type: "next-round" }));
    await waitForMessage(ws2, (m) => {
      if (m.type === "error") throw new Error(`next-round error: ${m.message}`);
      if (m.type !== "state") return false;
      const s = m.states?.[playerId];
      return s?.phase === "assigning" && s.round === roundBefore + 1;
    }, 5000);

    console.log("PASS: reconnect race — assign + next-round still work");

    // --- Immediate room delete should NOT happen (grace period) ---
    const ws3 = await openWs();
    ws3.send(JSON.stringify({ type: "create-vs-ai", playerName: "Grace", aiCount: 1 }));
    const joined3 = await waitForMessage(ws3, (m) => m.type === "joined");
    const pid3 = joined3.playerId;
    const code3 = joined3.roomCode;

    await new Promise((resolve) => {
      ws3.once("close", resolve);
      ws3.close();
    });
    await sleep(200);

    const ws4 = await openWs();
    ws4.send(JSON.stringify({ type: "reconnect", playerId: pid3, roomCode: code3 }));
    await waitForMessage(ws4, (m) => m.type === "reconnected");
    console.log("PASS: empty-room grace period allows reconnect");

    ws2.close();
    ws4.close();
  } finally {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      try {
        server.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
