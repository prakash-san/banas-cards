import { ALL_CARDS, getCard, shuffle } from "./cards.js";
import type {
  Card,
  CardAssignment,
  ChallengeResult,
  Family,
  GameState,
  Player,
  PlayerHand,
  RoundResult,
  Stat,
} from "./types.js";
import { CARDS_PER_ROUND, STATS, WINNING_SCORE } from "./types.js";

/** Fire > Metal > Earth > Water > Fire */
const TRUMP_BEATS: Record<Family, Family | null> = {
  fire: "metal",
  metal: "earth",
  earth: "water",
  water: "fire",
  special: null,
};

const FAMILY_NAMES: Record<Family, string> = {
  fire: "Fire",
  water: "Water",
  metal: "Metal",
  earth: "Earth",
  special: "Special",
};

const STAT_NAMES: Record<Stat, string> = {
  power: "Power",
  speed: "Speed",
  intelligence: "Intelligence",
};

function familyBeats(attacker: Family, defender: Family): boolean {
  if (attacker === "special" || defender === "special") return false;
  return TRUMP_BEATS[attacker] === defender;
}

function hasTrumpRelation(a: Family, b: Family): boolean {
  return familyBeats(a, b) || familyBeats(b, a);
}

function trumpPhrase(winnerFamily: Family, loserFamily: Family): string {
  return `${FAMILY_NAMES[winnerFamily]} beats ${FAMILY_NAMES[loserFamily]}`;
}

function statComparePhrase(
  stat: Stat,
  winnerName: string,
  winnerVal: number,
  loserName: string,
  loserVal: number
): { reasonLabel: string; detail: string } {
  const statName = STAT_NAMES[stat];
  return {
    reasonLabel: `Higher ${statName}`,
    detail: `${winnerName}'s ${statName} (${winnerVal}) beat ${loserName}'s ${statName} (${loserVal})`,
  };
}

function resolveTrumpPair(
  cardA: Card,
  cardB: Card
): { winner: "a" | "b" | null; reasonLabel: string; detail: string } {
  if (cardA.family === "special" || cardB.family === "special") {
    return {
      winner: null,
      reasonLabel: "Special card",
      detail: "A Special card was played — family trump is skipped",
    };
  }
  if (cardA.family === cardB.family) {
    return {
      winner: null,
      reasonLabel: "Same family",
      detail: `Both played ${FAMILY_NAMES[cardA.family]} — compare ${STAT_NAMES.power.toLowerCase()}, speed & intelligence`,
    };
  }
  if (familyBeats(cardA.family, cardB.family)) {
    return {
      winner: "a",
      reasonLabel: trumpPhrase(cardA.family, cardB.family),
      detail: `${trumpPhrase(cardA.family, cardB.family)} — ${cardA.name} wins over ${cardB.name}`,
    };
  }
  if (familyBeats(cardB.family, cardA.family)) {
    return {
      winner: "b",
      reasonLabel: trumpPhrase(cardB.family, cardA.family),
      detail: `${trumpPhrase(cardB.family, cardA.family)} — ${cardB.name} wins over ${cardA.name}`,
    };
  }
  return {
    winner: null,
    reasonLabel: "No family trump",
    detail: "No family beats the other — compare stat points",
  };
}

function getStatValue(card: Card, stat: Stat): number {
  return card[stat];
}

interface PlayEntry {
  playerId: string;
  playerName: string;
  card: Card;
}

function resolveTwoPlayerChallenge(
  stat: Stat,
  plays: PlayEntry[]
): ChallengeResult {
  const [a, b] = plays;
  const trump = resolveTrumpPair(a.card, b.card);

  if (trump.winner === "a") {
    return {
      stat,
      plays,
      eliminated: [b.playerId],
      winnerId: a.playerId,
      reason: "trump",
      reasonLabel: trump.reasonLabel,
      detail: `${trump.detail} — ${a.playerName} wins the ${STAT_NAMES[stat]} challenge!`,
    };
  }
  if (trump.winner === "b") {
    return {
      stat,
      plays,
      eliminated: [a.playerId],
      winnerId: b.playerId,
      reason: "trump",
      reasonLabel: trump.reasonLabel,
      detail: `${trump.detail} — ${b.playerName} wins the ${STAT_NAMES[stat]} challenge!`,
    };
  }

  const valA = getStatValue(a.card, stat);
  const valB = getStatValue(b.card, stat);
  if (valA > valB) {
    const msg = statComparePhrase(stat, a.playerName, valA, b.playerName, valB);
    return {
      stat,
      plays,
      eliminated: [],
      winnerId: a.playerId,
      reason: "stat",
      reasonLabel: msg.reasonLabel,
      detail: `${msg.detail} — ${a.playerName} wins the ${STAT_NAMES[stat]} challenge!`,
    };
  }
  if (valB > valA) {
    const msg = statComparePhrase(stat, b.playerName, valB, a.playerName, valA);
    return {
      stat,
      plays,
      eliminated: [],
      winnerId: b.playerId,
      reason: "stat",
      reasonLabel: msg.reasonLabel,
      detail: `${msg.detail} — ${b.playerName} wins the ${STAT_NAMES[stat]} challenge!`,
    };
  }
  return {
    stat,
    plays,
    eliminated: [],
    winnerId: null,
    reason: "tie",
    reasonLabel: "Tie",
    detail: `Both tied on ${STAT_NAMES[stat]} at ${valA} — no point awarded`,
  };
}

function resolveMultiPlayerChallenge(
  stat: Stat,
  plays: PlayEntry[],
  playerOrder: string[]
): ChallengeResult {
  const orderIndex = new Map(playerOrder.map((id, i) => [id, i]));
  const sorted = [...plays].sort(
    (x, y) => (orderIndex.get(x.playerId) ?? 0) - (orderIndex.get(y.playerId) ?? 0)
  );

  const eliminated = new Set<string>();
  const eliminationReasons: string[] = [];

  // Step 1: each player challenges clockwise neighbor
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const neighbor = sorted[(i + 1) % sorted.length];

    if (current.card.family === "special" || neighbor.card.family === "special") {
      continue;
    }

    const trump = resolveTrumpPair(neighbor.card, current.card);
    if (trump.winner === "a") {
      eliminated.add(current.playerId);
      eliminationReasons.push(
        `${current.playerName} trumped by ${neighbor.playerName} (${trump.reasonLabel})`
      );
    }
  }

  const survivors = sorted.filter((p) => !eliminated.has(p.playerId));

  if (survivors.length === 1) {
    return {
      stat,
      plays,
      eliminated: [...eliminated],
      winnerId: survivors[0].playerId,
      reason: "trump",
      reasonLabel: "Family trump",
      detail: `${survivors[0].playerName} was the only survivor after family trump${
        eliminationReasons.length ? ` — ${eliminationReasons.join("; ")}` : ""
      } — wins the ${STAT_NAMES[stat]} challenge!`,
    };
  }

  if (survivors.length === 0) {
    return {
      stat,
      plays,
      eliminated: [...eliminated],
      winnerId: null,
      reason: "tie",
      reasonLabel: "All trumped",
      detail: "Everyone was eliminated by family trump — no point awarded",
    };
  }

  // Step 2: highest stat among survivors
  let best = survivors[0];
  let bestVal = getStatValue(best.card, stat);
  let tied = false;

  for (const p of survivors.slice(1)) {
    const val = getStatValue(p.card, stat);
    if (val > bestVal) {
      best = p;
      bestVal = val;
      tied = false;
    } else if (val === bestVal) {
      tied = true;
    }
  }

  if (tied) {
    const topVal = bestVal;
    const topPlayers = survivors.filter((p) => getStatValue(p.card, stat) === topVal);
    if (topPlayers.length > 1) {
      return {
        stat,
        plays,
        eliminated: [...eliminated],
        winnerId: null,
        reason: "tie",
        reasonLabel: "Tie",
        detail: `Survivors tied on ${STAT_NAMES[stat]} at ${topVal} — no point awarded`,
      };
    }
  }

  const runnerUp = survivors
    .filter((p) => p.playerId !== best.playerId)
    .sort((x, y) => getStatValue(y.card, stat) - getStatValue(x.card, stat))[0];
  const runnerUpVal = runnerUp ? getStatValue(runnerUp.card, stat) : bestVal;

  const msg = statComparePhrase(
    stat,
    best.playerName,
    bestVal,
    runnerUp?.playerName ?? "others",
    runnerUpVal
  );

  return {
    stat,
    plays,
    eliminated: [...eliminated],
    winnerId: best.playerId,
    reason: "stat",
    reasonLabel: msg.reasonLabel,
    detail: `${msg.detail}${
      eliminationReasons.length ? ` (after trump: ${eliminationReasons.join("; ")})` : ""
    } — ${best.playerName} wins the ${STAT_NAMES[stat]} challenge!`,
  };
}

export function resolveRound(
  hands: PlayerHand[],
  players: Player[],
  playerOrder: string[]
): RoundResult {
  const nameById = new Map(players.map((p) => [p.id, p.name]));
  const challenges: ChallengeResult[] = [];
  const scores: Record<string, number> = {};
  for (const p of players) scores[p.id] = p.score;

  for (const stat of STATS) {
    const plays: PlayEntry[] = [];
    for (const hand of hands) {
      const assignment = hand.assignment!;
      const cardId = assignment[stat];
      const card = getCard(cardId)!;
      plays.push({
        playerId: hand.playerId,
        playerName: nameById.get(hand.playerId) ?? "Player",
        card,
      });
    }

    const result =
      plays.length === 2
        ? resolveTwoPlayerChallenge(stat, plays)
        : resolveMultiPlayerChallenge(stat, plays, playerOrder);

    challenges.push(result);

    if (result.winnerId) {
      scores[result.winnerId] = (scores[result.winnerId] ?? 0) + 1;
    }

    if (checkWinner(scores)) break;
  }

  return { challenges, scoresAfter: scores };
}

export function createShuffledDeck(): string[] {
  return shuffle(ALL_CARDS.map((c) => c.id));
}

export function dealCards(
  deck: string[],
  playerIds: string[]
): { hands: PlayerHand[]; remainingDeck: string[] } {
  let remaining = [...deck];
  if (remaining.length < playerIds.length * CARDS_PER_ROUND) {
    remaining = createShuffledDeck();
  }

  const hands: PlayerHand[] = playerIds.map((playerId) => {
    const cards: Card[] = [];
    for (let i = 0; i < CARDS_PER_ROUND; i++) {
      const id = remaining.shift()!;
      cards.push(getCard(id)!);
    }
    return { playerId, cards, assignment: null };
  });

  return { hands, remainingDeck: remaining };
}

export function validateAssignment(
  hand: Card[],
  assignment: CardAssignment
): string | null {
  const handIds = new Set(hand.map((c) => c.id));
  const assigned = [assignment.power, assignment.speed, assignment.intelligence];
  const assignedSet = new Set(assigned);

  if (assignedSet.size !== CARDS_PER_ROUND) {
    return "Each card must be assigned to a different stat.";
  }
  for (const id of assigned) {
    if (!handIds.has(id)) return "Invalid card in assignment.";
  }
  return null;
}

export function checkWinner(scores: Record<string, number>): string | null {
  for (const [id, score] of Object.entries(scores)) {
    if (score >= WINNING_SCORE) return id;
  }
  return null;
}

export function createInitialGameState(
  roomCode: string,
  players: Player[]
): GameState {
  return {
    roomCode,
    phase: "lobby",
    players,
    hands: [],
    round: 0,
    lastRoundResult: null,
    winnerId: null,
    deck: createShuffledDeck(),
  };
}

export function startNewRound(state: GameState): GameState {
  const playerIds = state.players.map((p) => p.id);
  const { hands, remainingDeck } = dealCards(state.deck, playerIds);

  return {
    ...state,
    phase: "assigning",
    hands,
    deck: remainingDeck,
    round: state.round + 1,
    lastRoundResult: null,
  };
}

export { hasTrumpRelation, familyBeats };
