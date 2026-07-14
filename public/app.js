const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const STORAGE_KEY = "banas-session";
const THEME_KEY = "banas-theme";
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
const MAX_RECONNECT_ATTEMPTS = 8;

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
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
  const anyOpen = [...document.querySelectorAll(".modal-backdrop")].some((m) => !m.hidden);
  if (!anyOpen) document.body.style.overflow = "";
}

function closeAllModals() {
  document.querySelectorAll(".modal-backdrop").forEach((m) => {
    m.hidden = true;
  });
  document.body.style.overflow = "";
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
      resolve();
    };
    ws.onerror = () => reject(new Error("Connection failed"));
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (intentionalClose || attemptingReconnect) return;
      if (playerId && roomCode) {
        toast("Connection lost — reconnecting…", "info");
        scheduleReconnect();
        return;
      }
      toast("Disconnected. Refresh to reconnect.", "info");
    };
  });
}

function scheduleReconnect() {
  if (reconnectTimer || attemptingReconnect) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    toast("Could not reconnect. Refresh the page.", "error");
    return;
  }

  const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
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
      }, 3000);
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
    case "joined":
    case "reconnected":
      attemptingReconnect = false;
      reconnectAttempts = 0;
      playerId = msg.playerId;
      if (msg.roomCode) roomCode = msg.roomCode;
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

// Theme + modals
syncThemeToggle();

document.getElementById("btn-settings").addEventListener("click", () => {
  closeModal("rules-modal");
  openModal("settings-modal");
});

document.getElementById("btn-rules").addEventListener("click", () => {
  closeModal("settings-modal");
  openModal("rules-modal");
});

document.getElementById("btn-rules-lobby")?.addEventListener("click", () => {
  closeModal("settings-modal");
  openModal("rules-modal");
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
