import type { Card, CardAssignment, Stat } from "./types.js";

const AI_NAMES = [
  "Blaze Bot",
  "Wave Bot",
  "Terra Bot",
  "Spark Bot",
  "Pebble Bot",
  "Splash Bot",
];

let aiNameIndex = 0;

export function nextAiName(): string {
  const name = AI_NAMES[aiNameIndex % AI_NAMES.length];
  aiNameIndex++;
  return name;
}

/** Score an assignment — higher is better for the AI. */
function scoreAssignment(cards: Card[], assignment: CardAssignment): number {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const powerCard = byId.get(assignment.power)!;
  const speedCard = byId.get(assignment.speed)!;
  const intelCard = byId.get(assignment.intelligence)!;

  let score = powerCard.power + speedCard.speed + intelCard.intelligence;

  // Prefer special cards on Power (highest trump-free stat pressure)
  if (powerCard.family === "special") score += 15;
  // Slight bonus for spreading high stats to matching slots
  const stats: Stat[] = ["power", "speed", "intelligence"];
  for (const card of cards) {
    const bestStat = stats.reduce((a, b) => (card[a] >= card[b] ? a : b));
    const assignedStat = stats.find(
      (s) => assignment[s] === card.id
    ) as Stat;
    if (assignedStat === bestStat) score += 5;
  }

  return score;
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

/** Pick the best card-to-stat assignment from the 6 possible permutations. */
export function computeAssignment(cards: Card[]): CardAssignment {
  const perms = permutations(cards);
  let best = perms[0];
  let bestScore = -1;

  for (const [power, speed, intelligence] of perms) {
    const assignment: CardAssignment = {
      power: power.id,
      speed: speed.id,
      intelligence: intelligence.id,
    };
    const score = scoreAssignment(cards, assignment);
    if (score > bestScore) {
      bestScore = score;
      best = [power, speed, intelligence];
    }
  }

  const [power, speed, intelligence] = best;
  return {
    power: power.id,
    speed: speed.id,
    intelligence: intelligence.id,
  };
}
