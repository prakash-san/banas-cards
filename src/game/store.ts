import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { computeAssignment, nextAiName } from "./ai.js";
import {
  checkWinner,
  createInitialGameState,
  resolveRound,
  startNewRound,
  validateAssignment,
} from "./engine.js";
import type {
  CardAssignment,
  ClientGameState,
  GameState,
  Player,
} from "./types.js";
import { MAX_PLAYERS, MIN_PLAYERS } from "./types.js";

interface Room {
  state: GameState;
  sockets: Map<string, WebSocket>;
  playerOrder: string[];
  aiTimers: ReturnType<typeof setTimeout>[];
}

const rooms = new Map<string, Room>();

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function generatePlayerId(): string {
  return randomBytes(8).toString("hex");
}

function createAiPlayer(): Player {
  return {
    id: generatePlayerId(),
    name: nextAiName(),
    score: 0,
    connected: true,
    isHost: false,
    isAi: true,
  };
}

function clearAiTimers(room: Room): void {
  for (const t of room.aiTimers) clearTimeout(t);
  room.aiTimers = [];
}

function canStartGame(state: GameState): boolean {
  return state.players.length >= MIN_PLAYERS;
}

export function toClientState(
  state: GameState,
  playerId: string
): ClientGameState {
  const hand = state.hands.find((h) => h.playerId === playerId);
  const submittedCount = state.hands.filter((h) => h.assignment !== null).length;

  return {
    roomCode: state.roomCode,
    phase: state.phase,
    players: state.players,
    myHand: hand?.cards ?? null,
    myAssignment: hand?.assignment ?? null,
    round: state.round,
    lastRoundResult: state.lastRoundResult,
    winnerId: state.winnerId,
    submittedCount,
    totalPlayers: state.players.length,
  };
}

function broadcast(room: Room): void {
  const payload = JSON.stringify({
    type: "state",
    states: Object.fromEntries(
      [...room.sockets.entries()].map(([pid, ws]) => {
        if (ws.readyState === ws.OPEN) {
          return [pid, toClientState(room.state, pid)];
        }
        return [pid, null];
      })
    ),
  });

  for (const ws of room.sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function getRoomByPlayer(playerId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.sockets.has(playerId)) return room;
  }
  return undefined;
}

function resolveRoundIfReady(room: Room): void {
  const allSubmitted = room.state.hands.every((h) => h.assignment !== null);
  if (!allSubmitted) return;

  room.state.phase = "resolving";
  broadcast(room);

  const result = resolveRound(
    room.state.hands,
    room.state.players,
    room.playerOrder
  );

  for (const p of room.state.players) {
    p.score = result.scoresAfter[p.id] ?? p.score;
  }

  room.state.lastRoundResult = result;
  room.state.phase = "round-summary";

  const winnerId = checkWinner(result.scoresAfter);
  if (winnerId) {
    room.state.winnerId = winnerId;
    // Stay on round-summary so players can review the final round
  }

  broadcast(room);
}

function applyAssignment(
  room: Room,
  playerId: string,
  assignment: CardAssignment
): string | null {
  if (room.state.phase !== "assigning") return "Not in assignment phase.";

  const hand = room.state.hands.find((h) => h.playerId === playerId);
  if (!hand) return "No hand dealt.";

  const err = validateAssignment(hand.cards, assignment);
  if (err) return err;

  hand.assignment = assignment;
  resolveRoundIfReady(room);

  if (room.state.phase === "assigning") {
    broadcast(room);
  }

  return null;
}

function scheduleAiAssignments(room: Room): void {
  clearAiTimers(room);
  if (room.state.phase !== "assigning") return;

  const aiHands = room.state.hands.filter((h) => {
    const player = room.state.players.find((p) => p.id === h.playerId);
    return player?.isAi && h.assignment === null;
  });

  aiHands.forEach((hand, index) => {
    const delay = 700 + index * 1100 + Math.random() * 400;
    const timer = setTimeout(() => {
      if (room.state.phase !== "assigning") return;
      const currentHand = room.state.hands.find((h) => h.playerId === hand.playerId);
      if (!currentHand || currentHand.assignment) return;
      const assignment = computeAssignment(currentHand.cards);
      applyAssignment(room, hand.playerId, assignment);
    }, delay);
    room.aiTimers.push(timer);
  });
}

function setupRoom(
  roomCode: string,
  players: Player[],
  hostWs: WebSocket,
  hostId: string
): Room {
  const state = createInitialGameState(roomCode, players);
  const room: Room = {
    state,
    sockets: new Map([[hostId, hostWs]]),
    playerOrder: players.map((p) => p.id),
    aiTimers: [],
  };
  rooms.set(roomCode, room);
  return room;
}

export function createRoom(
  playerName: string,
  ws: WebSocket
): { roomCode: string; playerId: string } {
  const roomCode = generateRoomCode();
  const playerId = generatePlayerId();
  const host: Player = {
    id: playerId,
    name: playerName.trim() || "Host",
    score: 0,
    connected: true,
    isHost: true,
    isAi: false,
  };

  setupRoom(roomCode, [host], ws, playerId);
  return { roomCode, playerId };
}

export function createRoomVsAi(
  playerName: string,
  ws: WebSocket,
  aiCount: number
): { roomCode: string; playerId: string } {
  const count = Math.max(1, Math.min(3, aiCount));
  const roomCode = generateRoomCode();
  const playerId = generatePlayerId();
  const host: Player = {
    id: playerId,
    name: playerName.trim() || "Player",
    score: 0,
    connected: true,
    isHost: true,
    isAi: false,
  };

  const aiPlayers = Array.from({ length: count }, () => createAiPlayer());
  const room = setupRoom(roomCode, [host, ...aiPlayers], ws, playerId);

  // Auto-start solo game after a brief moment
  const timer = setTimeout(() => {
    if (room.state.phase !== "lobby") return;
    room.state = startNewRound(room.state);
    broadcast(room);
    scheduleAiAssignments(room);
  }, 600);
  room.aiTimers.push(timer);

  return { roomCode, playerId };
}

export function addAiOpponents(
  playerId: string,
  count: number
): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  const player = room.state.players.find((p) => p.id === playerId);
  if (!player?.isHost) return "Only the host can add AI opponents.";
  if (room.state.phase !== "lobby") return "Game already in progress.";

  const toAdd = Math.max(1, Math.min(count, MAX_PLAYERS - room.state.players.length));
  if (toAdd <= 0) return "Room is full.";

  for (let i = 0; i < toAdd; i++) {
    const ai = createAiPlayer();
    room.state.players.push(ai);
    room.playerOrder.push(ai.id);
  }

  broadcast(room);
  return null;
}

export function joinRoom(
  roomCode: string,
  playerName: string,
  ws: WebSocket
): { playerId: string } | { error: string } {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return { error: "Room not found." };
  if (room.state.phase !== "lobby") return { error: "Game already in progress." };
  if (room.state.players.length >= MAX_PLAYERS) return { error: "Room is full (max 4 players)." };

  const playerId = generatePlayerId();
  const player: Player = {
    id: playerId,
    name: playerName.trim() || `Player ${room.state.players.length + 1}`,
    score: 0,
    connected: true,
    isHost: false,
    isAi: false,
  };

  room.state.players.push(player);
  room.sockets.set(playerId, ws);
  room.playerOrder.push(playerId);

  broadcast(room);
  return { playerId };
}

export function reconnectPlayer(
  roomCode: string,
  playerId: string,
  ws: WebSocket
): boolean {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return false;

  const player = room.state.players.find((p) => p.id === playerId);
  if (!player || player.isAi) return false;

  player.connected = true;
  room.sockets.set(playerId, ws);
  broadcast(room);
  return true;
}

export function handleDisconnect(playerId: string): void {
  const room = getRoomByPlayer(playerId);
  if (!room) return;

  const player = room.state.players.find((p) => p.id === playerId);
  if (player) player.connected = false;
  room.sockets.delete(playerId);

  if (room.sockets.size === 0) {
    clearAiTimers(room);
    rooms.delete(room.state.roomCode);
    return;
  }

  broadcast(room);
}

export function startGame(playerId: string): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  const player = room.state.players.find((p) => p.id === playerId);
  if (!player?.isHost) return "Only the host can start the game.";
  if (!canStartGame(room.state)) {
    return `Need at least ${MIN_PLAYERS} players.`;
  }
  if (room.state.phase !== "lobby") return "Game already started.";

  room.state = startNewRound(room.state);
  broadcast(room);
  scheduleAiAssignments(room);
  return null;
}

export function submitAssignment(
  playerId: string,
  assignment: CardAssignment
): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  return applyAssignment(room, playerId, assignment);
}

export function nextRound(playerId: string): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  const player = room.state.players.find((p) => p.id === playerId);
  if (!player?.isHost) return "Only the host can continue.";
  if (room.state.phase !== "round-summary") return "Not ready for next round.";

  clearAiTimers(room);
  room.state = startNewRound(room.state);
  broadcast(room);
  scheduleAiAssignments(room);
  return null;
}

export function playAgain(playerId: string): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  const player = room.state.players.find((p) => p.id === playerId);
  if (!player?.isHost) return "Only the host can reset.";

  clearAiTimers(room);
  room.state.players = room.state.players.map((p) => ({
    ...p,
    score: 0,
  }));
  room.state = {
    ...createInitialGameState(room.state.roomCode, room.state.players),
    players: room.state.players,
  };
  room.state = startNewRound(room.state);
  broadcast(room);
  scheduleAiAssignments(room);
  return null;
}

export function acknowledgeVictory(playerId: string): string | null {
  const room = getRoomByPlayer(playerId);
  if (!room) return "Not in a room.";
  if (room.state.phase !== "round-summary" || !room.state.winnerId) {
    return "No victory to show yet.";
  }

  room.state.phase = "finished";
  broadcast(room);
  return null;
}

export function getRoomState(roomCode: string): GameState | undefined {
  return rooms.get(roomCode.toUpperCase())?.state;
}
