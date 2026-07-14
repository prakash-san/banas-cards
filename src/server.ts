import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ALL_CARDS } from "./game/cards.js";
import {
  acknowledgeVictory,
  addAiOpponents,
  createRoom,
  createRoomVsAi,
  getRoomState,
  handleDisconnect,
  joinRoom,
  nextRound,
  playAgain,
  reconnectPlayer,
  startGame,
  submitAssignment,
  toClientState,
} from "./game/store.js";
import type { CardAssignment } from "./game/types.js";
import { MAX_PLAYERS, MIN_PLAYERS, WINNING_SCORE } from "./game/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3456;

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

app.get("/api/cards", (_req, res) => {
  res.json({ cards: ALL_CARDS });
});

app.get("/api/config", (_req, res) => {
  res.json({
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    winningScore: WINNING_SCORE,
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

interface ClientMessage {
  type: string;
  playerName?: string;
  roomCode?: string;
  playerId?: string;
  assignment?: CardAssignment;
  aiCount?: number;
}

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on("connection", (ws) => {
  let playerId: string | null = null;

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid message." });
      return;
    }

    switch (msg.type) {
      case "create-vs-ai": {
        const name = msg.playerName ?? "Player";
        const aiCount = msg.aiCount ?? 1;
        const result = createRoomVsAi(name, ws, aiCount);
        playerId = result.playerId;
        const state = getRoomState(result.roomCode);
        send(ws, {
          type: "joined",
          roomCode: result.roomCode,
          playerId: result.playerId,
          state: state ? toClientState(state, result.playerId) : null,
        });
        break;
      }

      case "add-ai": {
        if (!playerId) return;
        const err = addAiOpponents(playerId, msg.aiCount ?? 1);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      case "create": {
        const name = msg.playerName ?? "Host";
        const result = createRoom(name, ws);
        playerId = result.playerId;
        const state = getRoomState(result.roomCode);
        send(ws, {
          type: "joined",
          roomCode: result.roomCode,
          playerId: result.playerId,
          state: state ? toClientState(state, result.playerId) : null,
        });
        break;
      }

      case "join": {
        if (!msg.roomCode) {
          send(ws, { type: "error", message: "Room code required." });
          return;
        }
        const name = msg.playerName ?? "Player";
        const result = joinRoom(msg.roomCode, name, ws);
        if ("error" in result) {
          send(ws, { type: "error", message: result.error });
          return;
        }
        playerId = result.playerId;
        const state = getRoomState(msg.roomCode);
        send(ws, {
          type: "joined",
          roomCode: msg.roomCode.toUpperCase(),
          playerId: result.playerId,
          state: state ? toClientState(state, result.playerId) : null,
        });
        break;
      }

      case "reconnect": {
        if (!msg.roomCode || !msg.playerId) {
          send(ws, { type: "error", message: "Room code and player ID required." });
          return;
        }
        const ok = reconnectPlayer(msg.roomCode, msg.playerId, ws);
        if (!ok) {
          send(ws, { type: "reconnect-failed" });
          return;
        }
        playerId = msg.playerId;
        const state = getRoomState(msg.roomCode);
        send(ws, {
          type: "reconnected",
          playerId: msg.playerId,
          state: state ? toClientState(state, msg.playerId) : null,
        });
        break;
      }

      case "start": {
        if (!playerId) return;
        const err = startGame(playerId);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      case "assign": {
        if (!playerId || !msg.assignment) return;
        const err = submitAssignment(playerId, msg.assignment);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      case "next-round": {
        if (!playerId) return;
        const err = nextRound(playerId);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      case "view-victory": {
        if (!playerId) return;
        const err = acknowledgeVictory(playerId);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      case "play-again": {
        if (!playerId) return;
        const err = playAgain(playerId);
        if (err) send(ws, { type: "error", message: err });
        break;
      }

      default:
        send(ws, { type: "error", message: "Unknown message type." });
    }
  });

  ws.on("close", () => {
    if (playerId) handleDisconnect(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`Banas Cards running at http://localhost:${PORT}`);
});
