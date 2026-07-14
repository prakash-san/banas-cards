# Banas Cards

Multiplayer online version of **Banas Cards** — a strategy card game for 2–4 players. First to 11 points wins!

Created by Aditya Prakash. [Game rules](https://docs.google.com/document/d/1yB57wDSmzrSs7YQGW2bw1TqE4wvxY6GLYf1xPrsnVvs/edit?usp=sharing)

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:3456** in your browser.

### Multiplayer
Create a game, share the 4-letter room code with friends, and play!

### Solo vs AI
Click **Start vs AI** and pick 1–3 bots. The game starts automatically — bots play their turns for you.

### Mobile
On phones/tablets, **tap a card** to select it, then **tap a stat slot** to assign. Drag-and-drop still works on desktop.

## How it works

1. **Create or join** a room (2–4 players)
2. Each round, you receive **3 random cards** from the 13-card deck
3. **Assign** each card to Power, Speed, or Intelligence
4. Three challenges resolve each round:
   - **Family trump** (Fire → Metal → Earth → Water → Fire)
   - Special cards (Frostpaw Banas) skip trump
   - Highest stat wins if trump doesn't decide
5. First player to **11 points** wins

## Cards

| Card | Family | Power | Speed | Intelligence |
|------|--------|-------|-------|--------------|
| Fire Banas | Fire | 80 | 25 | 15 |
| Lava Banas | Fire | 60 | 10 | 40 |
| Volcano Banas | Fire | 70 | 20 | 25 |
| Dolphin Banas | Water | 25 | 65 | 40 |
| Aqua Banas | Water | 10 | 80 | 25 |
| Whale Banas | Water | 35 | 50 | 35 |
| Gold Banas | Metal | 75 | 15 | 50 |
| Silver Banas | Metal | 65 | 20 | 35 |
| Bronze Banas | Metal | 55 | 25 | 30 |
| Tree Banas | Earth | 30 | 10 | 80 |
| Mud Banas | Earth | 40 | 20 | 50 |
| Grass Banas | Earth | 35 | 25 | 65 |
| Frostpaw Banas | Special | 90 | 50 | 60 |

## Tech

- Node.js + Express + WebSockets (`ws`)
- Vanilla HTML/CSS/JS client
- TypeScript game engine with full trump & multi-player logic
