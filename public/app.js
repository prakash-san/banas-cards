const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const STORAGE_KEY = "banas-session";
const IS_TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;

/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let playerId = null;
/** @type {string | null} */
let roomCode = null;
/** @type {object | null} */
let state = null;
/** @type {boolean} */
let isHost = false;
/** @type {number} */
let selectedAiCount = 1;
/** @type {string | null} */
let selectedCardId = null;

/** @type {Record<string, string | null>} */
let assignments = { power: null, speed: null, intelligence: null };

/** @type {boolean} */
let isDragging = false;
/** @type {boolean} */
let pendingAssignRender = false;
/** @type {boolean} */
let assignBoardReady = false;
/** @type {boolean} */
let attemptingReconnect = false;

function handsChanged(prev, next) {
  const a = prev?.myHand;
  const b = next?.myHand;
  if (!a || !b) return true;
  if (a.length !== b.length) return true;
  return a.some((card, i) => card.id !== b[i]?.id);
}

function needsAssignDomRefresh(prev, next) {
  if (!prev || prev.phase !== "assigning") return true;
  if (prev.round !== next.round) return true;
  if (handsChanged(prev, next)) return true;
  if (!prev.myAssignment && next.myAssignment) return true;
  return false;
}

function updateAssignStatusOnly() {
  document.getElementById("round-num").textContent = state.round;
  document.getElementById("submit-status").textContent =
    `${state.submittedCount}/${state.totalPlayers} players ready`;
  renderScoreboard("scoreboard");
}

function scheduleRenderAssign(force = false) {
  if (!force && isDragging) {
    pendingAssignRender = true;
    return;
  }
  pendingAssignRender = false;
  renderAssign();
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const map = {
    lobby: "screen-lobby",
    waiting: "screen-waiting",
    assign: "screen-assign",
    results: "screen-results",
    finished: "screen-finished",
  };
  document.getElementById(map[name])?.classList.add("active");
}

function toast(msg, type = "error") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function saveSession() {
  if (playerId && roomCode) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ playerId, roomCode }));
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Connection failed"));
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (attemptingReconnect) return;
      toast("Disconnected. Refresh to reconnect.", "info");
    };
  });
}

function clearSavedSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function failReconnectSilently() {
  attemptingReconnect = false;
  clearSavedSession();
  playerId = null;
  roomCode = null;
  state = null;
  showScreen("lobby");
}

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function handleMessage(msg) {
  switch (msg.type) {
    case "joined":
    case "reconnected":
      attemptingReconnect = false;
      playerId = msg.playerId;
      roomCode = msg.roomCode;
      if (msg.state) applyState(msg.state);
      saveSession();
      break;
    case "reconnect-failed":
      failReconnectSilently();
      break;
    case "state":
      if (playerId && msg.states?.[playerId]) applyState(msg.states[playerId]);
      break;
    case "error":
      if (attemptingReconnect) {
        failReconnectSilently();
        break;
      }
      toast(msg.message);
      break;
  }
}

function applyState(s) {
  const prevPhase = state?.phase;
  const prevState = state;
  state = s;
  isHost = s.players?.find((p) => p.id === playerId)?.isHost ?? false;

  switch (s.phase) {
    case "lobby":
      renderWaiting();
      showScreen("waiting");
      break;
    case "assigning":
      if (prevPhase !== "assigning" || needsAssignDomRefresh(prevState, s)) {
        assignments = s.myAssignment
          ? { ...s.myAssignment }
          : { power: null, speed: null, intelligence: null };
        selectedCardId = null;
        const btn = document.getElementById("btn-submit");
        btn.textContent = s.myAssignment ? "Locked In ✓" : "Lock In Choices";
        btn.disabled = !!s.myAssignment;
        scheduleRenderAssign(true);
      } else {
        updateAssignStatusOnly();
      }
      showScreen("assign");
      break;
    case "resolving":
      selectedCardId = null;
      isDragging = false;
      pendingAssignRender = false;
      scheduleRenderAssign(true);
      showScreen("assign");
      document.getElementById("submit-status").textContent = "Resolving challenges…";
      break;
    case "round-summary":
      selectedCardId = null;
      renderResults();
      showScreen("results");
      break;
    case "finished":
      selectedCardId = null;
      renderFinished();
      showScreen("finished");
      break;
  }
}

function renderScoreboard(containerId) {
  const el = document.getElementById(containerId);
  if (!el || !state) return;
  el.innerHTML = state.players
    .map(
      (p) => `
    <div class="score-pill ${p.id === playerId ? "me" : ""}">
      ${escapeHtml(p.name)}${p.isHost ? " 👑" : ""}${p.isAi ? " 🤖" : ""}
      <span class="pts">${p.score}</span>
    </div>`
    )
    .join("");
}

function renderWaiting() {
  document.getElementById("display-room-code").textContent = state.roomCode;
  document.getElementById("player-list").innerHTML = state.players
    .map(
      (p) => `
    <li class="${p.connected || p.isAi ? "" : "offline"}">
      <span>${escapeHtml(p.name)}${p.isAi ? " 🤖" : ""}</span>
      <span>
        ${p.isHost ? '<span class="host-badge">Host</span>' : ""}
        ${p.isAi ? '<span class="ai-badge">AI</span>' : ""}
      </span>
    </li>`
    )
    .join("");

  const aiCount = state.players.filter((p) => p.isAi).length;
  const humanCount = state.players.filter((p) => !p.isAi).length;
  document.getElementById("waiting-hint").textContent =
  aiCount > 0
    ? `${state.players.length}/4 players (${aiCount} AI) · Share code ${state.roomCode}`
    : `${state.players.length}/4 players · Share code ${state.roomCode}`;

  const hostControls = document.getElementById("host-controls");
  const hostWait = document.getElementById("host-wait-msg");
  const startBtn = document.getElementById("btn-start");
  const addAiBtn = document.getElementById("btn-add-ai");

  if (isHost) {
    hostControls.hidden = false;
    hostWait.hidden = true;
    startBtn.disabled = state.players.length < 2;
    startBtn.textContent = state.players.length < 2 ? "Need 2+ players" : "Start Game";
    addAiBtn.hidden = state.players.length >= 4;
  } else {
    hostControls.hidden = true;
    hostWait.hidden = false;
  }
}

function updateSelectedHint() {
  const hint = document.getElementById("selected-hint");
  const nameEl = document.getElementById("selected-card-name");
  if (!selectedCardId) {
    hint.hidden = true;
    return;
  }
  const card = state?.myHand?.find((c) => c.id === selectedCardId);
  if (!card) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  nameEl.textContent = card.name;
}

function cardEl(card, { inHand = false, inSlot = false } = {}) {
  const div = document.createElement("div");
  div.className = `banas-card family-${card.family}`;
  if (selectedCardId === card.id) div.classList.add("selected");
  div.dataset.cardId = card.id;
  if (inHand) div.dataset.inHand = "true";
  if (inSlot) div.dataset.inSlot = "true";
  div.innerHTML = `
    <img src="${card.image}" alt="${escapeHtml(card.name)}" loading="lazy" draggable="false" />
    <div class="card-meta">
      <div class="card-name">${escapeHtml(card.name)}</div>
      <div class="card-stats">P${card.power} · S${card.speed} · I${card.intelligence}</div>
    </div>`;

  if (inHand && !IS_TOUCH) {
    div.draggable = true;
  }

  return div;
}

function onDragStart(e) {
  const card = e.target.closest(".banas-card[data-in-hand]");
  if (!card || state?.myAssignment) return;
  const cardId = card.dataset.cardId;
  if (!cardId) return;
  isDragging = true;
  e.dataTransfer.setData("text/plain", cardId);
  e.dataTransfer.effectAllowed = "move";
  card.classList.add("dragging");
}

function onDragEnd(e) {
  isDragging = false;
  e.target.closest(".banas-card")?.classList.remove("dragging");
  document.querySelectorAll(".slot-drop").forEach((z) => z.classList.remove("drag-over"));
  if (pendingAssignRender) scheduleRenderAssign(true);
}

function updateSlotHighlights() {
  document.querySelectorAll(".slot-drop").forEach((zone) => {
    const stat = zone.dataset.stat;
    zone.classList.toggle("slot-highlight", !!selectedCardId && !assignments[stat]);
  });
}

function initAssignBoard() {
  if (assignBoardReady) return;
  assignBoardReady = true;

  const board = document.querySelector(".assign-layout");
  if (!board) return;

  board.addEventListener("click", (e) => {
    if (state?.myAssignment) return;

    const zone = e.target.closest(".slot-drop");
    if (zone) {
      const stat = zone.dataset.stat;
      if (selectedCardId) {
        assignCardToStat(selectedCardId, stat);
        selectedCardId = null;
      } else if (assignments[stat]) {
        selectedCardId = assignments[stat];
        assignments[stat] = null;
        scheduleRenderAssign();
      }
      return;
    }

    const card = e.target.closest(".banas-card[data-in-hand]");
    if (card) {
      const cardId = card.dataset.cardId;
      selectedCardId = selectedCardId === cardId ? null : cardId;
      scheduleRenderAssign();
      return;
    }

    const slotCard = e.target.closest(".banas-card[data-in-slot]");
    if (slotCard) {
      const cardId = slotCard.dataset.cardId;
      const stat = Object.entries(assignments).find(([, id]) => id === cardId)?.[0];
      if (stat) {
        assignments[stat] = null;
        selectedCardId = cardId;
        scheduleRenderAssign();
      }
    }
  });

  if (!IS_TOUCH) {
    board.addEventListener("dragstart", onDragStart);
    board.addEventListener("dragend", onDragEnd);

    board.addEventListener("dragover", (e) => {
      const zone = e.target.closest(".slot-drop");
      if (!zone || state?.myAssignment) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      document.querySelectorAll(".slot-drop").forEach((z) => z.classList.remove("drag-over"));
      zone.classList.add("drag-over");
    });

    board.addEventListener("dragleave", (e) => {
      const zone = e.target.closest(".slot-drop");
      if (zone && !zone.contains(e.relatedTarget)) {
        zone.classList.remove("drag-over");
      }
    });

    board.addEventListener("drop", (e) => {
      const zone = e.target.closest(".slot-drop");
      if (!zone || state?.myAssignment) return;
      e.preventDefault();
      zone.classList.remove("drag-over");
      const cardId = e.dataTransfer.getData("text/plain");
      if (cardId) {
        assignCardToStat(cardId, zone.dataset.stat);
        selectedCardId = null;
      }
      isDragging = false;
    });
  }
}

function assignCardToStat(cardId, stat) {
  for (const [s, id] of Object.entries(assignments)) {
    if (id === cardId) assignments[s] = null;
  }
  assignments[stat] = cardId;
  scheduleRenderAssign();
}

function renderAssign() {
  renderScoreboard("scoreboard");
  document.getElementById("round-num").textContent = state.round;
  document.getElementById("submit-status").textContent =
    `${state.submittedCount}/${state.totalPlayers} players ready`;

  const instruction = document.getElementById("assign-instruction");
  const locked = !!state.myAssignment;
  instruction.textContent = locked
    ? "Waiting for other players to lock in…"
    : IS_TOUCH
      ? "Tap a card, then tap a stat slot to assign it."
      : "Tap or drag each card to a stat slot, then lock in.";

  updateSelectedHint();

  const handEl = document.getElementById("hand-cards");
  handEl.innerHTML = "";
  const assignedIds = new Set(Object.values(assignments).filter(Boolean));
  const unassigned = (state.myHand ?? []).filter((c) => !assignedIds.has(c.id));

  if (!locked) {
    for (const card of unassigned) {
      handEl.appendChild(cardEl(card, { inHand: true }));
    }
  }
  if (unassigned.length === 0 || locked) {
    if (locked) {
      handEl.innerHTML = '<p class="hint" style="margin:auto">Choices locked — waiting for opponents…</p>';
    } else {
      handEl.innerHTML = '<p class="hint" style="margin:auto">All cards assigned!</p>';
    }
  }

  for (const stat of ["power", "speed", "intelligence"]) {
    const zone = document.querySelector(`.slot-drop[data-stat="${stat}"]`);
    zone.innerHTML = "";
    zone.classList.toggle("filled", !!assignments[stat]);
    if (assignments[stat]) {
      const card = state.myHand.find((c) => c.id === assignments[stat]);
      if (card) zone.appendChild(cardEl(card, { inSlot: !locked }));
    } else if (!locked && !assignments[stat] && selectedCardId) {
      zone.innerHTML = '<span class="slot-placeholder">Tap to place here</span>';
    } else if (!assignments[stat]) {
      zone.innerHTML = '<span class="slot-placeholder">Drop card here</span>';
    }
  }

  if (!locked) updateSlotHighlights();

  const allAssigned = ["power", "speed", "intelligence"].every((s) => assignments[s]);
  const submitBtn = document.getElementById("btn-submit");
  const alreadySubmitted = !!state.myAssignment;

  if (alreadySubmitted) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Locked In ✓";
  } else if (submitBtn.textContent === "Lock In Choices") {
    submitBtn.disabled = !allAssigned;
  }
}

function renderResults() {
  renderScoreboard("scoreboard-results");
  const result = state.lastRoundResult;
  if (!result) return;

  const gameWinner = state.winnerId
    ? state.players.find((p) => p.id === state.winnerId)
    : null;
  const isMe = state.winnerId === playerId;

  document.getElementById("results-title").textContent =
    gameWinner ? "Final Round Results" : "Round Results";

  const banner = document.getElementById("game-won-banner");
  if (gameWinner) {
    banner.hidden = false;
    banner.textContent = isMe
      ? "🎉 You reached 11 points — you win the game!"
      : `🎉 ${gameWinner.name} reached 11 points and wins the game!`;
  } else {
    banner.hidden = true;
  }

  const statIcons = { power: "⚡", speed: "💨", intelligence: "🧠" };
  const statLabels = { power: "Power", speed: "Speed", intelligence: "Intelligence" };

  document.getElementById("challenge-results").innerHTML = result.challenges
    .map((ch) => {
      const winnerName = ch.winnerId
        ? state.players.find((p) => p.id === ch.winnerId)?.name ?? "?"
        : null;
      const reasonClass = ch.reason === "tie" ? "tie" : ch.reason;
      return `
      <div class="challenge-card">
        <h3>${statIcons[ch.stat] ?? ""} ${statLabels[ch.stat] ?? ch.stat} Challenge</h3>
        <div class="challenge-plays">
          ${ch.plays.map((p) => `
            <div class="challenge-play ${p.playerId === ch.winnerId ? "challenge-play-winner" : ""}">
              <div class="player-name">${escapeHtml(p.playerName)}${state.players.find(pl => pl.id === p.playerId)?.isAi ? " 🤖" : ""}</div>
              ${cardHtmlSmall(p.card)}
              <div class="play-stat">${statLabels[ch.stat]}: <strong>${p.card[ch.stat]}</strong></div>
            </div>`).join("")}
        </div>
        <div class="challenge-outcome ${ch.winnerId ? "win" : ""}">
          <span class="reason-badge ${reasonClass}">${escapeHtml(ch.reasonLabel ?? ch.reason)}</span>
          ${ch.winnerId
            ? `<div class="outcome-winner">🏆 ${escapeHtml(winnerName)} wins!</div>`
            : `<div class="outcome-winner">🤝 Tie — no point</div>`}
          <div class="outcome-detail">${escapeHtml(ch.detail)}</div>
        </div>
      </div>`;
    })
    .join("");

  const nextBtn = document.getElementById("btn-next");
  const waitMsg = document.getElementById("results-wait");

  if (state.winnerId) {
    nextBtn.textContent = "See Victory 🎉";
    nextBtn.hidden = !isHost;
    waitMsg.hidden = isHost;
    waitMsg.textContent = "Waiting for host to continue…";
  } else {
    nextBtn.textContent = "Next Round →";
    nextBtn.hidden = !isHost;
    waitMsg.hidden = isHost;
    waitMsg.textContent = "Waiting for host to start the next round…";
  }
}

function cardHtmlSmall(card) {
  return `
    <div class="banas-card family-${card.family}">
      <img src="${card.image}" alt="${escapeHtml(card.name)}" draggable="false" />
      <div class="card-meta"><div class="card-name">${escapeHtml(card.name)}</div></div>
    </div>`;
}

function renderFinished() {
  const winner = state.players.find((p) => p.id === state.winnerId);
  const isMe = state.winnerId === playerId;
  document.getElementById("winner-text").textContent =
    isMe ? "🎉 You win!" : winner ? `🎉 ${winner.name} wins!` : "Game Over!";
  renderScoreboard("scoreboard-final");
  document.getElementById("btn-play-again").hidden = !isHost;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function ensureConnected() {
  if (!ws || ws.readyState !== WebSocket.OPEN) await connect();
}

document.querySelectorAll(".ai-count-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ai-count-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedAiCount = Number(btn.dataset.count);
  });
});

document.getElementById("btn-create").addEventListener("click", async () => {
  const name = document.getElementById("player-name").value.trim();
  if (!name) return toast("Enter your name");
  try {
    await ensureConnected();
    send({ type: "create", playerName: name });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("btn-vs-ai").addEventListener("click", async () => {
  const name = document.getElementById("player-name").value.trim();
  if (!name) return toast("Enter your name");
  try {
    await ensureConnected();
    send({ type: "create-vs-ai", playerName: name, aiCount: selectedAiCount });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("btn-join").addEventListener("click", async () => {
  const name = document.getElementById("player-name").value.trim();
  const code = document.getElementById("room-code").value.trim().toUpperCase();
  if (!name) return toast("Enter your name");
  if (!code || code.length !== 4) return toast("Enter a 4-letter room code");
  try {
    await ensureConnected();
    send({ type: "join", playerName: name, roomCode: code });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("btn-copy-code").addEventListener("click", () => {
  if (roomCode) {
    navigator.clipboard.writeText(roomCode);
    toast("Room code copied!", "info");
  }
});

document.getElementById("btn-add-ai").addEventListener("click", () => {
  send({ type: "add-ai", aiCount: 1 });
});

document.getElementById("btn-start").addEventListener("click", () => send({ type: "start" }));

document.getElementById("btn-submit").addEventListener("click", () => {
  send({ type: "assign", assignment: { ...assignments } });
  document.getElementById("btn-submit").disabled = true;
  document.getElementById("btn-submit").textContent = "Locked In ✓";
  selectedCardId = null;
});

document.getElementById("btn-next").addEventListener("click", () => {
  if (state?.winnerId) {
    send({ type: "view-victory" });
  } else {
    send({ type: "next-round" });
  }
});
document.getElementById("btn-play-again").addEventListener("click", () => send({ type: "play-again" }));

(async () => {
  initAssignBoard();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  let session;
  try {
    session = JSON.parse(saved);
  } catch {
    clearSavedSession();
    return;
  }

  const { playerId: pid, roomCode: code } = session;
  if (!pid || !code) {
    clearSavedSession();
    return;
  }

  attemptingReconnect = true;
  try {
    await connect();
    send({ type: "reconnect", playerId: pid, roomCode: code });
    // If the server doesn't respond within 3s, treat session as expired
    setTimeout(() => {
      if (attemptingReconnect) failReconnectSilently();
    }, 3000);
  } catch {
    failReconnectSilently();
  }
})();
