import type { Card } from "./types.js";

export const ALL_CARDS: Card[] = [
  {
    id: "fire-banas",
    name: "Fire Banas",
    family: "fire",
    power: 80,
    speed: 25,
    intelligence: 15,
    flavor: "Glows at Sunrise and loves warm pancakes",
    image: "/cards/fire-banas.jpg",
  },
  {
    id: "lava-banas",
    name: "Lava Banas",
    family: "fire",
    power: 60,
    speed: 10,
    intelligence: 40,
    flavor: "Melting trouble and solid fun in every step",
    image: "/cards/lava-banas.jpg",
  },
  {
    id: "volcano-banas",
    name: "Volcano Banas",
    family: "fire",
    power: 70,
    speed: 20,
    intelligence: 25,
    flavor: "Erupting with chaos long before the mountain does",
    image: "/cards/volcano-banas.jpg",
  },
  {
    id: "dolphin-banas",
    name: "Dolphin Banas",
    family: "water",
    power: 25,
    speed: 65,
    intelligence: 40,
    flavor: "The only sea creature who surfs the waves and snacks on imaginary honey",
    image: "/cards/dolphin-banas.jpg",
  },
  {
    id: "aqua-banas",
    name: "Aqua Banas",
    family: "water",
    power: 10,
    speed: 80,
    intelligence: 25,
    flavor: "Makes a splash even before the water knows what's happening",
    image: "/cards/aqua-banas.jpg",
  },
  {
    id: "whale-banas",
    name: "Whale Banas",
    family: "water",
    power: 35,
    speed: 50,
    intelligence: 35,
    flavor: "Makes waves big enough to shock the ocean",
    image: "/cards/whale-banas.jpg",
  },
  {
    id: "gold-banas",
    name: "Gold Banas",
    family: "metal",
    power: 75,
    speed: 15,
    intelligence: 50,
    flavor: "Shining so bright it blinds its own sparkle",
    image: "/cards/gold-banas.jpg",
  },
  {
    id: "silver-banas",
    name: "Silver Banas",
    family: "metal",
    power: 65,
    speed: 20,
    intelligence: 35,
    flavor: "Polished, proud and always ready to outshine second place",
    image: "/cards/silver-banas.jpg",
  },
  {
    id: "bronze-banas",
    name: "Bronze Banas",
    family: "metal",
    power: 55,
    speed: 25,
    intelligence: 30,
    flavor: "Brings warm glow to every wild adventure",
    image: "/cards/bronze-banas.jpg",
  },
  {
    id: "tree-banas",
    name: "Tree Banas",
    family: "earth",
    power: 30,
    speed: 10,
    intelligence: 80,
    flavor: "Rooting for fun and branching into mischief",
    image: "/cards/tree-banas.jpg",
  },
  {
    id: "mud-banas",
    name: "Mud Banas",
    family: "earth",
    power: 40,
    speed: 20,
    intelligence: 50,
    flavor: "Turning puddles into playgrounds one splash at a time",
    image: "/cards/mud-banas.jpg",
  },
  {
    id: "grass-banas",
    name: "Grass Banas",
    family: "earth",
    power: 35,
    speed: 25,
    intelligence: 65,
    flavor: "Turns a lawn into a five-star salad bar",
    image: "/cards/grass-banas.jpg",
  },
  {
    id: "frostpaw-banas",
    name: "Frostpaw Banas",
    family: "special",
    power: 90,
    speed: 50,
    intelligence: 60,
    flavor: "Lives in snowy trees and makes tiny ice sculptures",
    image: "/cards/frostpaw-banas.jpg",
  },
];

const cardById = new Map(ALL_CARDS.map((c) => [c.id, c]));

export function getCard(id: string): Card | undefined {
  return cardById.get(id);
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
