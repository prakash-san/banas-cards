const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const STORAGE_KEY = "banas-session";
const THEME_KEY = "banas-theme";
const NAME_KEY = "banas-player-name";
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
/** @type {boolean} */
let intentionalClose = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
/** @type {number} */
let reconnectAttempts = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
const MAX_RECONNECT_ATTEMPTS = 12;
const HEARTBEAT_MS = 20_000;

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
  document.body.dataset.screen = name;
  const exitBtn = document.getElementById("btn-exit");
  if (exitBtn) exitBtn.hidden = name === "lobby";
}

function getTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  return current === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // ignore storage failures
  }
  syncThemeToggle();
}

function syncThemeToggle() {
  const theme = getTheme();
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeChoice === theme);
  });
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  if (id === "name-modal" && !getPlayerName()) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
  const anyOpen = [...document.querySelectorAll(".modal-backdrop")].some((m) => !m.hidden);
  if (!anyOpen) document.body.style.overflow = "";
}

function closeAllModals() {
  document.querySelectorAll(".modal-backdrop").forEach((m) => {
    if (m.id === "name-modal" && !getPlayerName()) return;
    m.hidden = true;
  });
  const anyOpen = [...document.querySelectorAll(".modal-backdrop")].some((m) => !m.hidden);
  if (!anyOpen) document.body.style.overflow = "";
}

function getPlayerName() {
  try {
    return (localStorage.getItem(NAME_KEY) || "").trim();
  } catch {
    return "";
  }
}

function setPlayerName(name) {
  const cleaned = String(name || "").trim().slice(0, 20);
  if (!cleaned) return false;
  try {
    localStorage.setItem(NAME_KEY, cleaned);
  } catch {
    // ignore storage failures
  }
  const settingsInput = document.getElementById("settings-name");
  if (settingsInput) settingsInput.value = cleaned;
  const welcomeInput = document.getElementById("welcome-name");
  if (welcomeInput) welcomeInput.value = cleaned;
  return true;
}

function syncSettingsNameField() {
  const settingsInput = document.getElementById("settings-name");
  if (settingsInput) settingsInput.value = getPlayerName();
}

function requirePlayerName() {
  const name = getPlayerName();
  if (name) return name;
  toast("Enter your name first");
  openModal("name-modal");
  document.getElementById("welcome-name")?.focus();
  return null;
}

function promptNameIfNeeded() {
  if (getPlayerName()) {
    syncSettingsNameField();
    return;
  }
  openModal("name-modal");
  requestAnimationFrame(() => document.getElementById("welcome-name")?.focus());
}

function toast(msg, type = "error") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function resetLocalGame() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  intentionalClose = true;
  clearSavedSession();
  playerId = null;
  roomCode = null;
  state = null;
  isHost = false;
  selectedCardId = null;
  assignments = { power: null, speed: null, intelligence: null };
  isDragging = false;
  pendingAssignRender = false;
  attemptingReconnect = false;
  reconnectAttempts = 0;
  showScreen("lobby");
  queueMicrotask(() => {
    intentionalClose = false;
    if (ws?.readyState === WebSocket.OPEN) startHeartbeat();
  });
}

function exitToLobby() {
  if (!playerId && !roomCode) {
    showScreen("lobby");
    return;
  }
  if (!confirm("Leave this game and return to the lobby?")) return;
  intentionalClose = true;
  send({ type: "leave" });
  resetLocalGame();
}

function saveSession() {
  if (playerId && roomCode) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ playerId, roomCode }));
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_MS);
}

function syncSubmitButton() {
  const submitBtn = document.getElementById("btn-submit");
  if (!submitBtn || !state) return;

  const alreadySubmitted = !!state.myAssignment;
  const allAssigned = ["power", "speed", "intelligence"].every((s) => assignments[s]);

  if (alreadySubmitted) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Locked In ✓";
  } else {
    submitBtn.disabled = !allAssigned;
    submitBtn.textContent = "Lock In Choices";
  }
}

function resetDragState() {
  isDragging = false;
  document.querySelectorAll(".banas-card.dragging").forEach((el) => {
    el.classList.remove("dragging");
  });
  document.querySelectorAll(".slot-drop").forEach((z) => z.classList.remove("drag-over"));
}

function connect() {
  return new Promise((resolve, reject) => {
    if (ws) {
      intentionalClose = true;
      stopHeartbeat();
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      intentionalClose = false;
    }

    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      reconnectAttempts = 0;
      startHeartbeat();
      resolve();
    };
    ws.onerror = () => reject(new Error("Connection failed"));
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      stopHeartbeat();
      if (intentionalClose || attemptingReconnect) return;
      if (playerId && roomCode) {
        toast("Connection lost — reconnecting…", "info");
        scheduleReconnect();
        return;
      }
      toast("Disconnected. Reconnecting when possible…", "info");
    };
  });
}

function scheduleReconnect() {
  if (reconnectTimer || intentionalClose) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    failReconnectSilently();
    toast("Could not reconnect. Start a new game.", "error");
    return;
  }

  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (intentionalClose) return;
    if (!playerId || !roomCode) {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const session = JSON.parse(saved);
          playerId = session.playerId || null;
          roomCode = session.roomCode || null;
        } catch {
          // ignore
        }
      }
    }
    if (!playerId || !roomCode) return;
    attemptingReconnect = true;
    try {
      await connect();
      send({ type: "reconnect", playerId, roomCode });
      setTimeout(() => {
        if (attemptingReconnect) {
          attemptingReconnect = false;
          scheduleReconnect();
        }
      }, 4000);
    } catch {
      attemptingReconnect = false;
      scheduleReconnect();
    }
  }, delay);
}

function clearSavedSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function failReconnectSilently() {
  attemptingReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearSavedSession();
  playerId = null;
  roomCode = null;
  state = null;
  showScreen("lobby");
}

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  if (playerId && roomCode) {
    toast("Not connected — trying to reconnect…", "info");
    scheduleReconnect();
  } else {
    toast("Not connected to server");
  }
  return false;
}

function handleMessage(msg) {
  switch (msg.type) {
    case "pong":
      break;
    case "joined":
    case "reconnected":
      attemptingReconnect = false;
      reconnectAttempts = 0;
      playerId = msg.playerId;
      if (msg.roomCode) roomCode = msg.roomCode;
      else if (msg.state?.roomCode) roomCode = msg.state.roomCode;
      if (msg.state) applyState(msg.state);
      saveSession();
      if (msg.type === "reconnected") toast("Reconnected — game resumed.", "info");
      break;
    case "reconnect-failed":
      failReconnectSilently();
      toast("Could not resume — room is gone. Start a new game.", "error");
      break;
    case "state":
      if (playerId && msg.states?.[playerId]) applyState(msg.states[playerId]);
      break;
    case "error":
      if (attemptingReconnect) {
        attemptingReconnect = false;
        scheduleReconnect();
        break;
      }
      toast(msg.message);
      // Restore submit / next controls if the server rejected an action
      if (state?.phase === "assigning" && !state.myAssignment) {
        syncSubmitButton();
        scheduleRenderAssign(true);
      }
      if (state?.phase === "round-summary") {
        const nextBtn = document.getElementById("btn-next");
        if (nextBtn) nextBtn.disabled = false;
      }
      break;
    case "left":
      resetLocalGame();
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
      resetDragState();
      if (prevPhase !== "assigning" || needsAssignDomRefresh(prevState, s)) {
        assignments = s.myAssignment
          ? { ...s.myAssignment }
          : { power: null, speed: null, intelligence: null };
        selectedCardId = null;
        syncSubmitButton();
        scheduleRenderAssign(true);
      } else {
        updateAssignStatusOnly();
        syncSubmitButton();
      }
      showScreen("assign");
      break;
    case "resolving":
      selectedCardId = null;
      resetDragState();
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
    ? `${state.players.length}/4 players (${aiCount} AI) · max 4 including bots · Share code ${state.roomCode}`
    : `${state.players.length}/4 players · max 4 including bots · Share code ${state.roomCode}`;

  const hostControls = document.getElementById("host-controls");
  const hostWait = document.getElementById("host-wait-msg");
  const startBtn = document.getElementById("btn-start");
  const addAiBtn = document.getElementById("btn-add-ai");
  const seatsLeft = 4 - state.players.length;

  if (isHost) {
    hostControls.hidden = false;
    hostWait.hidden = true;
    startBtn.disabled = state.players.length < 2;
    startBtn.textContent = state.players.length < 2 ? "Need 2+ players" : "Start Game";
    addAiBtn.hidden = seatsLeft <= 0;
    addAiBtn.textContent =
      seatsLeft <= 0
        ? "Room full (4 max)"
        : seatsLeft === 1
          ? "+ Add AI Opponent (1 seat left)"
          : `+ Add AI Opponent (${seatsLeft} seats left)`;
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
  nameEl.textContent = `${card.name} — ${card.flavor}`;
}

function cardEl(card, { inHand = false, inSlot = false } = {}) {
  const div = document.createElement("div");
  div.className = `banas-card family-${card.family}`;
  if (selectedCardId === card.id) div.classList.add("selected");
  div.dataset.cardId = card.id;
  div.title = `${card.name} — P${card.power} · S${card.speed} · I${card.intelligence}`;
  if (inHand) div.dataset.inHand = "true";
  if (inSlot) div.dataset.inSlot = "true";
  div.innerHTML = `
    <img src="${card.image}" alt="${escapeHtml(card.name)}: ${escapeHtml(card.flavor)}" loading="lazy" draggable="false" />`;

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
  resetDragState();
  e.target.closest(".banas-card")?.classList.remove("dragging");
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
      resetDragState();
    });
  }

  // Safety net: HTML5 drag can skip dragend if the node is removed mid-drag.
  document.addEventListener("dragend", () => {
    if (!isDragging) return;
    resetDragState();
    if (pendingAssignRender) scheduleRenderAssign(true);
  });
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

  syncSubmitButton();
}

/** Fire > Metal > Earth > Water > Fire — mirrors server trump rules. */
const TRUMP_BEATS = {
  fire: "metal",
  metal: "earth",
  earth: "water",
  water: "fire",
  special: null,
};

function familyBeats(attacker, defender) {
  if (attacker === "special" || defender === "special") return false;
  return TRUMP_BEATS[attacker] === defender;
}

function sortPlaysBySeat(plays) {
  const order = new Map((state?.players ?? []).map((p, i) => [p.id, i]));
  return [...plays].sort(
    (a, b) => (order.get(a.playerId) ?? 0) - (order.get(b.playerId) ?? 0)
  );
}

/** Clockwise neighbor edges — always drawn; `trumped` when family trump applies. */
function getClockwiseEdges(plays) {
  const sorted = sortPlaysBySeat(plays);
  const edges = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const neighbor = sorted[(i + 1) % sorted.length];
    // Same direction as the engine: clockwise neighbor challenges current.
    edges.push({
      fromId: neighbor.playerId,
      toId: current.playerId,
      trumped: familyBeats(neighbor.card.family, current.card.family),
    });
  }
  return edges;
}

function playNodeHtml(play, ch, seat) {
  const isWinner = play.playerId === ch.winnerId;
  const isEliminated = ch.eliminated?.includes(play.playerId);
  const isAi = state.players.find((pl) => pl.id === play.playerId)?.isAi;
  const statLabels = { power: "Power", speed: "Speed", intelligence: "Intelligence" };
  return `
    <div class="trump-node seat-${seat} ${isWinner ? "is-winner" : ""} ${isEliminated ? "is-eliminated" : ""}"
         data-player-id="${play.playerId}">
      <div class="player-name">${escapeHtml(play.playerName)}${isAi ? " 🤖" : ""}</div>
      ${cardHtmlSmall(play.card)}
      <div class="play-stat">${statLabels[ch.stat]}: <strong>${play.card[ch.stat]}</strong></div>
    </div>`;
}

function renderTrumpDiagram(ch) {
  const sorted = sortPlaysBySeat(ch.plays);
  const n = sorted.length;
  const shape = n === 3 ? "triangle" : n === 4 ? "diamond" : "row";
  const edges = n >= 3 ? getClockwiseEdges(ch.plays) : [];
  const nodes = sorted.map((p, i) => playNodeHtml(p, ch, i)).join("");
  const anyTrump = edges.some((e) => e.trumped);

  const legend = anyTrump
    ? `<p class="trump-legend"><span class="legend-swatch legend-trump"></span> Red = family trump &nbsp;&nbsp; <span class="legend-swatch legend-check"></span> Curve = clockwise challenge</p>`
    : `<p class="trump-legend"><span class="legend-swatch legend-check"></span> Curved arrows follow clockwise challenges — no family trump this round</p>`;

  return `
    <div class="trump-diagram trump-diagram-${shape}"
         data-trump-edges='${JSON.stringify(edges)}'
         aria-label="${shape} trump layout">
      <svg class="trump-arrows" aria-hidden="true">
        <defs>
          <marker id="trump-arrowhead-check-${shape}" class="trump-arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#8ecae6" />
          </marker>
          <marker id="trump-arrowhead-hit-${shape}" class="trump-arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#e63946" />
          </marker>
        </defs>
      </svg>
      ${nodes}
    </div>
    ${legend}`;
}

function curvedArrowPath(x1, y1, x2, y2, cx, cy) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;

  // Push the control point outward from the diagram center for a circular feel.
  let ox = mx - cx;
  let oy = my - cy;
  const fromCenter = Math.hypot(ox, oy);
  if (fromCenter < 4) {
    // Nearly through center — bend perpendicular to the chord.
    ox = -dy;
    oy = dx;
  }
  const olen = Math.hypot(ox, oy) || 1;
  const bulge = Math.min(56, Math.max(28, len * 0.32));
  const qx = mx + (ox / olen) * bulge;
  const qy = my + (oy / olen) * bulge;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

function layoutTrumpArrows() {
  document.querySelectorAll(".trump-diagram").forEach((diagram, idx) => {
    const svg = diagram.querySelector(".trump-arrows");
    if (!svg) return;

    const w = diagram.clientWidth;
    const h = diagram.clientHeight;
    if (w < 8 || h < 8) return;

    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));

    svg.querySelectorAll("path.trump-arrow-path").forEach((el) => el.remove());

    let edges = [];
    try {
      edges = JSON.parse(diagram.dataset.trumpEdges || "[]");
    } catch {
      edges = [];
    }

    const diagramRect = diagram.getBoundingClientRect();
    const cx = w / 2;
    const cy = h / 2;
    const nodeById = new Map(
      [...diagram.querySelectorAll(".trump-node")].map((node) => [node.dataset.playerId, node])
    );

    const checkId = `trump-arrowhead-check-${idx}`;
    const hitId = `trump-arrowhead-hit-${idx}`;
    const markers = svg.querySelectorAll("marker");
    if (markers[0]) markers[0].id = checkId;
    if (markers[1]) markers[1].id = hitId;

    for (const edge of edges) {
      const fromEl = nodeById.get(edge.fromId);
      const toEl = nodeById.get(edge.toId);
      if (!fromEl || !toEl) continue;

      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      let x1 = a.left + a.width / 2 - diagramRect.left;
      let y1 = a.top + a.height / 2 - diagramRect.top;
      let x2 = b.left + b.width / 2 - diagramRect.left;
      let y2 = b.top + b.height / 2 - diagramRect.top;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const pull = Math.min(42, len * 0.26);
      x1 += (dx / len) * pull;
      y1 += (dy / len) * pull;
      x2 -= (dx / len) * pull;
      y2 -= (dy / len) * pull;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `trump-arrow-path ${edge.trumped ? "is-trump" : "is-check"}`);
      path.setAttribute("d", curvedArrowPath(x1, y1, x2, y2, cx, cy));
      path.setAttribute("marker-end", `url(#${edge.trumped ? hitId : checkId})`);
      path.setAttribute("fill", "none");
      svg.appendChild(path);
    }
  });
}

function renderChallengePlays(ch) {
  if (ch.plays.length >= 3) return renderTrumpDiagram(ch);

  const statLabels = { power: "Power", speed: "Speed", intelligence: "Intelligence" };
  return `
    <div class="challenge-plays">
      ${ch.plays
        .map(
          (p) => `
        <div class="challenge-play ${p.playerId === ch.winnerId ? "challenge-play-winner" : ""} ${ch.eliminated?.includes(p.playerId) ? "is-eliminated" : ""}">
          <div class="player-name">${escapeHtml(p.playerName)}${state.players.find((pl) => pl.id === p.playerId)?.isAi ? " 🤖" : ""}</div>
          ${cardHtmlSmall(p.card)}
          <div class="play-stat">${statLabels[ch.stat]}: <strong>${p.card[ch.stat]}</strong></div>
        </div>`
        )
        .join("")}
    </div>`;
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
        ${renderChallengePlays(ch)}
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

  requestAnimationFrame(() => {
    layoutTrumpArrows();
    requestAnimationFrame(layoutTrumpArrows);
  });

  const nextBtn = document.getElementById("btn-next");
  const waitMsg = document.getElementById("results-wait");

  nextBtn.disabled = false;
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
    <div class="banas-card family-${card.family}" title="${escapeHtml(card.name)} — ${escapeHtml(card.flavor)} — P${card.power} · S${card.speed} · I${card.intelligence}">
      <img src="${card.image}" alt="${escapeHtml(card.name)}: ${escapeHtml(card.flavor)}" draggable="false" />
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
  const name = requirePlayerName();
  if (!name) return;
  try {
    await ensureConnected();
    send({ type: "create", playerName: name });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("btn-vs-ai").addEventListener("click", async () => {
  const name = requirePlayerName();
  if (!name) return;
  try {
    await ensureConnected();
    send({ type: "create-vs-ai", playerName: name, aiCount: selectedAiCount });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("btn-join").addEventListener("click", async () => {
  const name = requirePlayerName();
  if (!name) return;
  const code = document.getElementById("room-code").value.trim().toUpperCase();
  if (!code || code.length !== 4) return toast("Enter the code shared with you");
  try {
    await ensureConnected();
    send({ type: "join", playerName: name, roomCode: code });
    showScreen("waiting");
  } catch {
    toast("Could not connect to server");
  }
});

document.getElementById("room-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join")?.click();
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
  const allAssigned = ["power", "speed", "intelligence"].every((s) => assignments[s]);
  if (!allAssigned || state?.myAssignment) return;

  const submitBtn = document.getElementById("btn-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Locking in…";
  selectedCardId = null;

  const ok = send({ type: "assign", assignment: { ...assignments } });
  if (!ok) {
    syncSubmitButton();
  }
});

document.getElementById("btn-next").addEventListener("click", () => {
  const nextBtn = document.getElementById("btn-next");
  if (nextBtn.disabled) return;
  nextBtn.disabled = true;

  const ok = state?.winnerId
    ? send({ type: "view-victory" })
    : send({ type: "next-round" });

  if (!ok) {
    nextBtn.disabled = false;
    return;
  }

  // Re-enable shortly so a rejected action can be retried; state updates also
  // rebuild this button via renderResults().
  setTimeout(() => {
    if (state?.phase === "round-summary") nextBtn.disabled = false;
  }, 1200);
});
document.getElementById("btn-play-again").addEventListener("click", () => send({ type: "play-again" }));

document.getElementById("btn-exit").addEventListener("click", exitToLobby);
document.querySelectorAll(".btn-leave").forEach((btn) => {
  btn.addEventListener("click", exitToLobby);
});

function tryResumeWhenOnline() {
  if (intentionalClose) return;
  if (ws?.readyState === WebSocket.OPEN) return;
  if (!(playerId && roomCode)) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.playerId || !saved?.roomCode) return;
      playerId = saved.playerId;
      roomCode = saved.roomCode;
    } catch {
      return;
    }
  }
  scheduleReconnect();
}

window.addEventListener("online", tryResumeWhenOnline);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tryResumeWhenOnline();
});
window.addEventListener("resize", () => {
  if (document.getElementById("screen-results")?.classList.contains("active")) {
    layoutTrumpArrows();
  }
});

// Theme + modals
syncThemeToggle();
syncSettingsNameField();
promptNameIfNeeded();

document.getElementById("btn-settings").addEventListener("click", () => {
  closeModal("rules-modal");
  syncSettingsNameField();
  openModal("settings-modal");
  document.getElementById("settings-name")?.focus();
});

document.getElementById("btn-rules").addEventListener("click", () => {
  closeModal("settings-modal");
  openModal("rules-modal");
});

document.getElementById("btn-rules-lobby")?.addEventListener("click", () => {
  closeModal("settings-modal");
  openModal("rules-modal");
});

document.getElementById("btn-save-welcome-name")?.addEventListener("click", () => {
  const value = document.getElementById("welcome-name")?.value ?? "";
  if (!setPlayerName(value)) return toast("Enter your name");
  closeModal("name-modal");
  toast(`Welcome, ${getPlayerName()}!`, "info");
});

document.getElementById("welcome-name")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-save-welcome-name")?.click();
});

document.getElementById("btn-save-settings-name")?.addEventListener("click", () => {
  const value = document.getElementById("settings-name")?.value ?? "";
  if (!setPlayerName(value)) return toast("Enter your name");
  toast("Name saved", "info");
});

document.getElementById("settings-name")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-save-settings-name")?.click();
});

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
});

document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
});

document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllModals();
});

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
  playerId = pid;
  roomCode = code;
  try {
    await connect();
    send({ type: "reconnect", playerId: pid, roomCode: code });
    setTimeout(() => {
      if (attemptingReconnect) {
        attemptingReconnect = false;
        scheduleReconnect();
      }
    }, 4000);
  } catch {
    attemptingReconnect = false;
    scheduleReconnect();
  }
})();
