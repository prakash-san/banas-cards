export type Family = "fire" | "water" | "metal" | "earth" | "special";

export type Stat = "power" | "speed" | "intelligence";

export const STATS: Stat[] = ["power", "speed", "intelligence"];

export const WINNING_SCORE = 11;
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const CARDS_PER_ROUND = 3;

export interface Card {
  id: string;
  name: string;
  family: Family;
  power: number;
  speed: number;
  intelligence: number;
  flavor: string;
  image: string;
}

export interface CardAssignment {
  power: string;
  speed: string;
  intelligence: string;
}

export interface ChallengeResult {
  stat: Stat;
  plays: { playerId: string; playerName: string; card: Card }[];
  eliminated: string[];
  winnerId: string | null;
  reason: "trump" | "stat" | "tie";
  reasonLabel: string;
  detail: string;
}

export interface RoundResult {
  challenges: ChallengeResult[];
  scoresAfter: Record<string, number>;
}

export type GamePhase =
  | "lobby"
  | "dealing"
  | "assigning"
  | "resolving"
  | "round-summary"
  | "finished";

export interface Player {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  isHost: boolean;
  isAi: boolean;
}

export interface PlayerHand {
  playerId: string;
  cards: Card[];
  assignment: CardAssignment | null;
}

export interface GameState {
  roomCode: string;
  phase: GamePhase;
  players: Player[];
  hands: PlayerHand[];
  round: number;
  lastRoundResult: RoundResult | null;
  winnerId: string | null;
  deck: string[];
}

export interface ClientGameState {
  roomCode: string;
  phase: GamePhase;
  players: Player[];
  myHand: Card[] | null;
  myAssignment: CardAssignment | null;
  round: number;
  lastRoundResult: RoundResult | null;
  winnerId: string | null;
  submittedCount: number;
  totalPlayers: number;
}
