/**
 * 3-player disconnect recovery:
 * - Host drop transfers host so another player can continue
 * - Dropped player is auto-assigned so the round does not freeze at 2/3
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = 3600 + Math.floor(Math.random() * 200);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const HOST_TRANSFER_MS = 400;
const DISCONNECT_AUTOPLAY_MS = 800;

function waitForMessage(ws, predicate, timeoutMs = 5000) {
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

function stateOf(msg, playerId) {
  if (msg.type === "joined" || msg.type === "reconnected") return msg.state;
  if (msg.type === "state") return msg.states?.[playerId] ?? null;
  return null;
}

async function main() {
  const server = spawn("npx", ["tsx", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BANAS_HOST_TRANSFER_MS: String(HOST_TRANSFER_MS),
      BANAS_DISCONNECT_AUTOPLAY_MS: String(DISCONNECT_AUTOPLAY_MS),
    },
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

  const sockets = [];
  try {
    const host = await openWs();
    sockets.push(host);
    host.send(JSON.stringify({ type: "create", playerName: "Host" }));
    const created = await waitForMessage(host, (m) => m.type === "joined");
    const roomCode = created.roomCode;
    const hostId = created.playerId;

    const p2 = await openWs();
    sockets.push(p2);
    p2.send(JSON.stringify({ type: "join", roomCode, playerName: "Two" }));
    const joined2 = await waitForMessage(p2, (m) => m.type === "joined");
    const id2 = joined2.playerId;

    const p3 = await openWs();
    sockets.push(p3);
    p3.send(JSON.stringify({ type: "join", roomCode, playerName: "Three" }));
    await waitForMessage(p3, (m) => m.type === "joined");

    host.send(JSON.stringify({ type: "start" }));
    const assigning = await waitForMessage(p2, (m) => {
      const s = stateOf(m, id2);
      return s?.phase === "assigning";
    });

    let live = stateOf(assigning, id2);
    const hand2 = live.myHand;
    p2.send(
      JSON.stringify({
        type: "assign",
        assignment: {
          power: hand2[0].id,
          speed: hand2[1].id,
          intelligence: hand2[2].id,
        },
      })
    );
    await waitForMessage(p2, (m) => {
      const s = stateOf(m, id2);
      return s?.submittedCount === 1;
    });

    // Drop player 3 without assigning — round must still resolve via autoplay.
    await new Promise((resolve) => {
      p3.once("close", resolve);
      p3.close();
    });

    // Drop the host — host should transfer to player 2.
    await new Promise((resolve) => {
      host.once("close", resolve);
      host.close();
    });

    const hostTransferred = await waitForMessage(
      p2,
      (m) => {
        const s = stateOf(m, id2);
        if (!s) return false;
        const me = s.players.find((p) => p.id === id2);
        const oldHost = s.players.find((p) => p.id === hostId);
        return me?.isHost === true && oldHost?.connected === false;
      },
      HOST_TRANSFER_MS + 2500
    );
    console.log("PASS: host transferred after disconnect");

    const summary = await waitForMessage(
      p2,
      (m) => stateOf(m, id2)?.phase === "round-summary",
      DISCONNECT_AUTOPLAY_MS + 4000
    );
    live = stateOf(summary, id2);
    if (live.submittedCount !== 3 && live.phase !== "round-summary") {
      throw new Error("Expected round to resolve after autoplay");
    }
    console.log("PASS: disconnected seat auto-assigned; round resolved");

    // Surviving player (now host) can advance.
    p2.send(JSON.stringify({ type: "next-round" }));
    await waitForMessage(p2, (m) => {
      const s = stateOf(m, id2);
      return s?.phase === "assigning" && s.round === live.round + 1;
    });
    console.log("PASS: new host can start next round");
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
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
