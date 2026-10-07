import {
  COASTAL_TERRITORIES, FACTIONS, GROWTH_PER_TERRITORY, LAND_RELAY_RANGE_KM, METROPOLIS_MAX_TROOPS,
  MAX_AIRPORTS_PER_FACTION, MAX_TROOPS, MILITARY_STRONGHOLDS, MULTIPLAYER_GAME_MODES,
} from "./config.js";
import { getGameDom } from "./dom.js";
import { createMultiplayerMap } from "./multiplayer-map.js";
import { createNetworkClient } from "./network.js";

const SESSION_KEY = "war_game_multiplayer_session_v1";

function readSavedSession() {
  try {
    const value = JSON.parse(window.localStorage.getItem(SESSION_KEY));
    return value?.roomCode && value?.playerId && value?.reconnectToken ? value : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch { /* 浏览器禁用本地存储时仍可继续本次连接 */ }
}

function clearSavedSession() {
  try { window.localStorage.removeItem(SESSION_KEY); } catch { /* no-op */ }
}

export async function startMultiplayerApp({ entryDialog, lobbyDialog }) {
  const dom = getGameDom();
  const ui = {
    title: document.querySelector("#lobby-title"),
    connection: document.querySelector("#connection-status"),
    entry: document.querySelector("#lobby-entry"),
    roomPanel: document.querySelector("#room-panel"),
    playerName: document.querySelector("#player-name"),
    maxPlayers: document.querySelector("#max-players"),
    gameMode: document.querySelector("#multiplayer-game-mode"),
    strategicTerrain: document.querySelector("#strategic-terrain"),
    roomCodeInput: document.querySelector("#room-code-input"),
    createRoom: document.querySelector("#create-room"),
    joinRoom: document.querySelector("#join-room"),
    roomCode: document.querySelector("#room-code"),
    roomCapacity: document.querySelector("#room-capacity"),
    roomSettings: document.querySelector("#room-settings-summary"),
    roomPlayers: document.querySelector("#room-players"),
    lobbyFactions: document.querySelector("#lobby-factions"),
    ready: document.querySelector("#ready-button"),
    start: document.querySelector("#start-room-game"),
    error: document.querySelector("#lobby-error"),
    back: document.querySelector("#lobby-back"),
  };
  let roomState = null;
  let gameState = null;
  let mapController = null;
  let mapPromise = null;
  let network = null;
  let orderMode = "land";
  let selectedTerritoryId = null;
  let selectedOrderId = null;
  let selectedSourceIds = [];
  let lastAnimatedRound = 0;
  let startingGame = false;
  let resumeInFlight = false;
  let latencyTimer = null;
  let smoothedLatency = null;

  const context = () => ({ roomState, gameState, orderMode });

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function showError(error) {
    ui.error.textContent = error?.message ?? String(error);
    ui.error.hidden = false;
  }

  function clearError() {
    ui.error.hidden = true;
    ui.error.textContent = "";
  }

  async function action(task) {
    clearError();
    try {
      return await task();
    } catch (error) {
      showError(error);
      return null;
    }
  }

  async function claimSession(event, payload) {
    const credentials = await network.request(event, payload);
    saveSession(credentials);
    return credentials;
  }

  async function attemptResume() {
    const saved = readSavedSession();
    if (!saved || resumeInFlight || !network?.socket.connected) return false;
    resumeInFlight = true;
    ui.connection.textContent = `正在恢复房间 ${saved.roomCode}…`;
    try {
      await network.request("resumeSession", saved);
      ui.connection.innerHTML = `<span class="connection-pill">已恢复权威服务器存档</span>`;
      clearError();
      return true;
    } catch (error) {
      if (["ROOM_NOT_FOUND", "INVALID_RECONNECT"].includes(error.code)) {
        clearSavedSession();
        ui.connection.innerHTML = `<span class="connection-pill">已连接权威服务器</span>`;
        clearError();
      } else showError(error);
      return false;
    } finally {
      resumeInFlight = false;
    }
  }

  function showLatency(value = null) {
    if (!dom.latency) return;
    dom.latency.hidden = false;
    dom.latency.classList.toggle("is-medium", value !== null && value >= 100 && value < 220);
    dom.latency.classList.toggle("is-high", value !== null && value >= 220);
    dom.latency.classList.toggle("is-offline", value === null);
    dom.latency.querySelector("strong").textContent = value === null ? "离线" : `${Math.round(value)} ms`;
  }

  async function measureLatency() {
    if (!network?.socket.connected) {
      showLatency(null);
      return;
    }
    const startedAt = performance.now();
    try {
      await network.request("latencyPing");
      const roundTrip = performance.now() - startedAt;
      smoothedLatency = smoothedLatency === null ? roundTrip : smoothedLatency * .65 + roundTrip * .35;
      showLatency(smoothedLatency);
    } catch {
      showLatency(null);
    }
  }

  function startLatencyMonitor() {
    if (latencyTimer) window.clearInterval(latencyTimer);
    void measureLatency();
    latencyTimer = window.setInterval(() => { void measureLatency(); }, 2500);
  }

  function resetLobby() {
    roomState = null;
    gameState = null;
    ui.title.textContent = "创建或加入房间";
    ui.entry.hidden = false;
    ui.roomPanel.hidden = true;
  }

  function renderLobby() {
    if (!roomState) return resetLobby();
    const viewer = roomState.players.find((player) => player.id === roomState.viewerPlayerId);
    ui.title.textContent = roomState.status === "playing" ? "游戏已开始" : "等待玩家准备";
    ui.entry.hidden = true;
    ui.roomPanel.hidden = false;
    ui.roomCode.textContent = roomState.code;
    ui.roomCapacity.textContent = `${roomState.players.length} / ${roomState.maxPlayers} 人 · 至少 ${roomState.minPlayers} 人`;
    const mode = MULTIPLAYER_GAME_MODES[roomState.settings?.gameMode] ?? MULTIPLAYER_GAME_MODES.expansion;
    ui.roomSettings.innerHTML = `<span>${mode.name}</span><span>${roomState.settings?.strategicTerrain ? "天险与重镇：开启" : "天险与重镇：关闭"}</span>`;
    ui.roomPlayers.innerHTML = roomState.players.map((player) => {
      const faction = player.factionId ? FACTIONS[player.factionId] : null;
      return `<div class="room-player" style="--player-color:${faction?.color ?? "#53635e"}"><i></i><div><b>${escapeHtml(player.name)}${player.host ? " · 房主" : ""}</b><small>${faction ? escapeHtml(faction.name) : "未选择势力"}</small></div><span class="${player.ready && player.connected ? "is-ready" : ""}">${player.connected ? (player.ready ? "已准备" : "未准备") : "已离线"}</span></div>`;
    }).join("");
    const taken = new Set(roomState.players.filter((player) => player.id !== viewer?.id).map((player) => player.factionId).filter(Boolean));
    const partition = roomState.settings?.gameMode === "partition";
    ui.lobbyFactions.innerHTML = roomState.availableFactions.map((faction) => {
      const unavailable = taken.has(faction.id);
      return `<button type="button" class="lobby-faction ${viewer?.factionId === faction.id ? "is-selected" : ""}" data-lobby-faction="${faction.id}" style="--faction-color:${faction.color}" title="${faction.description}" ${unavailable ? "disabled" : ""}>${escapeHtml(faction.name)}${partition ? `<small>八方固定版图</small>` : ""}</button>`;
    }).join("");
    ui.ready.textContent = viewer?.ready ? "取消准备" : "准备";
    ui.ready.disabled = !viewer?.factionId || roomState.status !== "lobby";
    ui.start.hidden = viewer?.id !== roomState.hostPlayerId;
    ui.start.disabled = roomState.players.length < roomState.minPlayers || !roomState.players.every((player) => player.connected && player.ready && player.factionId);
  }

  function viewer() {
    return gameState?.players.find((player) => player.id === roomState?.viewerPlayerId) ?? null;
  }

  function canAct() {
    const player = viewer();
    return Boolean(player && !player.isNpc && gameState?.phase === "planning" && !gameState.submittedPlayerIds.includes(player.id) && !player.eliminated);
  }

  function renderGame() {
    if (!gameState || !roomState || !mapController) return;
    const player = viewer();
    dom.round.textContent = String(gameState.round).padStart(2, "0");
    const paused = gameState.phase === "paused";
    const submitted = Boolean(player && gameState.submittedPlayerIds.includes(player.id));
    const livingHumans = gameState.players.filter((candidate) => !candidate.isNpc && !candidate.eliminated);
    const waitingHumans = livingHumans.filter((candidate) => !gameState.submittedPlayerIds.includes(candidate.id));
    dom.phase.textContent = gameState.phase === "finished" ? "战局结束" : paused ? "战局暂停" : gameState.phase === "resolving" ? "同步结算" : canAct() ? "同时部署中" : submitted ? "部署已提交" : "观战中";
    const mode = MULTIPLAYER_GAME_MODES[gameState.settings?.gameMode] ?? MULTIPLAYER_GAME_MODES.expansion;
    dom.instruction.textContent = `局域网联机 · ${mode.name} · 房间 ${roomState.code}`;
    const pauseCopy = gameState.pauseReason === "manual" ? "房主已暂停战局。" : gameState.pauseReason === "server_restart" ? "服务器已恢复存档，等待所有玩家重连。" : "有玩家断线，战局已自动暂停并保留当前部署。";
    dom.syncNote.textContent = paused ? pauseCopy : gameState.phase === "finished" ? "本局已经结束。" : canAct()
      ? `你的命令只对自己可见；${waitingHumans.length} 名玩家尚未提交。`
      : submitted ? `已提交部署，等待其余 ${waitingHumans.length} 名玩家；随后 NPC 将依据回合初始局面行动。` : "当前势力已被消灭，可以继续观看战局。";
    dom.endTurn.disabled = !canAct();
    dom.endTurn.textContent = canAct() ? "提交部署" : submitted ? "已提交" : "无法部署";
    dom.rollback.disabled = false;
    dom.rollback.textContent = "保存战局";
    const isHost = roomState.viewerPlayerId === roomState.hostPlayerId;
    const allConnected = gameState.players.filter((candidate) => !candidate.eliminated).every((candidate) => candidate.connected);
    dom.pauseGame.hidden = !isHost || gameState.phase === "finished";
    dom.pauseGame.disabled = paused && (gameState.pauseReason !== "manual" || !allConnected);
    dom.pauseGame.textContent = paused ? (gameState.pauseReason === "manual" ? "继续游戏" : "等待重连") : "暂停游戏";
    const ranking = gameState.players.map((candidate) => {
      const holdings = Object.values(gameState.territories).filter((territory) => territory.owner === candidate.factionId);
      const fleet = gameState.fleets.filter((item) => item.owner === candidate.factionId).reduce((sum, item) => sum + item.ships, 0);
      const currentStrength = holdings.reduce((sum, territory) => sum + territory.troops, 0) + fleet;
      const future = holdings.reduce((sum, territory) => sum + Math.min(territory.metropolis ? METROPOLIS_MAX_TROOPS : MAX_TROOPS, territory.troops + (territory.construction ? 0 : GROWTH_PER_TERRITORY)), fleet);
      return { player: candidate, holdings: holdings.length, currentStrength, future };
    }).sort((a, b) => b.future - a.future || b.currentStrength - a.currentStrength || b.holdings - a.holdings);
    dom.scoreboard.innerHTML = ranking.map((entry, index) => {
      const faction = FACTIONS[entry.player.factionId];
      const controller = entry.player.isNpc ? "NPC" : faction.name;
      const displayName = entry.player.isNpc ? faction.name : entry.player.name;
      return `<article class="faction-card ${entry.player.id === player?.id ? "is-player" : ""} ${entry.player.eliminated ? "is-eliminated" : ""}" style="--faction-color:${faction.color}"><span class="rank-number">${index + 1}</span><span class="faction-sigil">${faction.short}</span><div><b>${escapeHtml(displayName)}</b><small>${entry.player.eliminated ? "已被消灭" : controller}${entry.player.isNpc || entry.player.connected ? "" : " · 已离线"}</small></div><strong><span>${entry.currentStrength}</span><small>现</small><span>${entry.future}</span><small>下回合</small></strong></article>`;
    }).join("");
    const hasNeutral = Object.values(gameState.territories).some((territory) => territory.owner === "neutral");
    dom.legend.innerHTML = gameState.players.map((candidate) => `<span><i style="--legend-color:${FACTIONS[candidate.factionId].color}"></i>${escapeHtml(candidate.isNpc ? FACTIONS[candidate.factionId].name : candidate.name)}${candidate.isNpc ? "·NPC" : ""}</span>`).join("")
      + (hasNeutral ? `<span><i style="--legend-color:${FACTIONS.neutral.color}"></i>中立</span>` : "")
      + `<span><i class="terrain-key mountain-key"></i>${gameState.settings?.strategicTerrain ? "山脉阻隔线" : "地形"}</span><span><i class="terrain-key river-key"></i>水系</span>`
      + (gameState.settings?.strategicTerrain ? `<span><b class="map-symbol">♜</b>军事重镇</span>` : "");
    dom.orderModeSwitch.querySelectorAll("[data-order-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.orderMode === orderMode);
      button.disabled = !canAct();
    });
    mapController.render(gameState, roomState);
    renderOrders();
    renderSummary();
  }

  function renderOrders() {
    const orders = gameState?.pendingOrders ?? [];
    dom.orderCount.textContent = `${orders.length} 项`;
    if (!orders.length) {
      dom.orderList.innerHTML = `<div class="empty-orders">${canAct() ? "从己方兵力圆标拖动划线来部署" : "当前没有可见命令"}</div>`;
      return;
    }
    const faction = FACTIONS[viewer().factionId];
    dom.orderList.innerHTML = orders.map((order) => `<div class="order-item" style="--order-color:${faction.color}" data-order-id="${order.id}"><span class="order-icon">${order.mode === "air" ? "✈" : order.mode === "sea" ? "⚓" : "⚔"}</span><div><b>${mapController.definitions[order.source].shortName} → ${mapController.definitions[order.target].shortName}</b><small>${order.mode === "air" ? "空降" : order.mode === "sea" ? "登陆" : "陆路"} · ${order.amount} 兵</small></div><button type="button" class="cancel-order" data-cancel-order="${order.id}" ${canAct() ? "" : "disabled"}>×</button></div>`).join("");
  }

  function renderSummary() {
    if (!gameState) return;
    const player = viewer();
    const selectedOrder = gameState.pendingOrders.find((order) => order.id === selectedOrderId);
    if (selectedOrder) {
      const otherCommitted = gameState.pendingOrders.filter((order) => order.source === selectedOrder.source && order.id !== selectedOrder.id).reduce((sum, order) => sum + order.amount, 0);
      const max = Math.max(1, gameState.territories[selectedOrder.source].troops - 1 - otherCommitted);
      dom.summary.innerHTML = `<span class="eyebrow">调整联机命令</span><h2>${mapController.definitions[selectedOrder.source].name} → ${mapController.definitions[selectedOrder.target].name}</h2><div class="territory-meta"><span>${selectedOrder.mode === "land" ? "陆路" : selectedOrder.mode === "air" ? "空降" : "登陆"}</span><span>服务端最终判定</span></div><div class="amount-row"><label for="order-amount">出动兵力</label><output id="amount-output">${selectedOrder.amount}</output><input id="order-amount" type="range" min="1" max="${max}" value="${Math.min(max, selectedOrder.amount)}" /></div>`;
      const slider = dom.summary.querySelector("#order-amount");
      slider.addEventListener("input", () => { dom.summary.querySelector("#amount-output").textContent = slider.value; });
      slider.addEventListener("change", () => action(() => network.request("stageOrder", { ...selectedOrder, amount: Number(slider.value) })));
      return;
    }
    const territory = selectedTerritoryId ? gameState.territories[selectedTerritoryId] : null;
    if (!territory) {
      dom.summary.innerHTML = `<span class="eyebrow">联机部署</span><h2>${canAct() ? "选择己方城市" : "等待同步结算"}</h2><p>${canAct() ? "按住兵力圆标自由划线，服务端会验证路径、兵力和目标。" : "其他玩家的部署命令在同步结算前不可见。"}</p>`;
      return;
    }
    const isOwn = territory.owner === player.factionId;
    const stronghold = gameState.settings?.strategicTerrain ? MILITARY_STRONGHOLDS[selectedTerritoryId] : null;
    const queuedConstruction = gameState.pendingConstructions?.find((order) => order.territoryId === selectedTerritoryId);
    const canBuild = isOwn && canAct() && !territory.construction && !queuedConstruction;
    const coastal = COASTAL_TERRITORIES.has(selectedTerritoryId);
    const airportCount = Object.values(gameState.territories).filter((item) => item.owner === player.factionId && (item.airport || item.construction?.type === "airport")).length
      + (gameState.pendingConstructions ?? []).filter((order) => order.owner === player.factionId && order.type === "airport").length;
    const canBuildAirport = canBuild && !territory.airport && airportCount < MAX_AIRPORTS_PER_FACTION;
    const selectedSources = selectedSourceIds.filter((id) => gameState.territories[id]?.owner === player.factionId);
    const multiSelectNotice = selectedSources.length
      ? `<p class="command-notice">已多选 ${selectedSources.length} 座城市。拖动任一已选圆圈，将从每城派出全部可用兵力；超过 ${LAND_RELAY_RANGE_KM} 公里的跨城路线会跳过。</p>`
      : "";
    dom.summary.innerHTML = `<span class="eyebrow">城市状态</span><h2>${mapController.definitions[selectedTerritoryId].name} · ${territory.troops}/${territory.metropolis ? METROPOLIS_MAX_TROOPS : MAX_TROOPS} 兵</h2><div class="territory-meta"><span>${FACTIONS[territory.owner]?.name ?? "中立"}</span>${territory.capitalOf ? "<span>首都</span>" : ""}${stronghold ? `<span>军事重镇 · ${stronghold.role}</span>` : ""}${territory.airport ? "<span>机场</span>" : ""}${territory.port ? "<span>港口</span>" : ""}${territory.construction ? `<span>建设剩余 ${territory.construction.remaining} 回合</span>` : ""}${queuedConstruction ? `<span>${queuedConstruction.type === "airport" ? "机场" : "港口"}待提交</span>` : ""}</div><p>${stronghold ? "军事重镇防御提高 25%；山脉阻隔线只能经指定关口通行。" : isOwn ? `拖动兵力圆标下达命令；本势力机场 ${airportCount}/${MAX_AIRPORTS_PER_FACTION}。` : "敌方或中立城市，只能作为合法进攻目标。"}</p>${multiSelectNotice}${queuedConstruction ? `<div class="build-actions"><button type="button" data-cancel-construction="${queuedConstruction.id}" ${canAct() ? "" : "disabled"}>取消待提交建设</button></div>` : isOwn ? `<div class="build-actions"><button type="button" data-build="airport" ${canBuildAirport ? "" : "disabled"}>${territory.airport ? "机场已建成" : airportCount >= MAX_AIRPORTS_PER_FACTION ? `机场已达上限 ${MAX_AIRPORTS_PER_FACTION}` : "修建机场 · 8回合"}</button><button type="button" data-build="port" ${canBuild && coastal && !territory.port ? "" : "disabled"}>${territory.port ? "港口已建成" : coastal ? "修建港口 · 8回合" : "非沿海城市"}</button></div>` : ""}`;
  }

  async function showResolution(resolution) {
    if (!resolution || resolution.round <= lastAnimatedRound) return;
    lastAnimatedRound = resolution.round;
    await mapController.playResolution(resolution);
    dom.reportTitle.textContent = `第 ${resolution.round} 回合战报`;
    dom.reportList.innerHTML = resolution.report.map((entry) => `<div class="report-entry ${entry.type === "battle" ? "is-battle" : entry.type === "growth" ? "is-growth" : entry.type === "terrain" ? "is-terrain" : entry.type === "strategy" ? "is-strategy" : ""}">${escapeHtml(entry.text)}</div>`).join("");
    if (!dom.reportDialog.open) dom.reportDialog.showModal();
  }

  async function ensureMap() {
    if (mapController) return;
    if (!mapPromise) {
      mapPromise = createMultiplayerMap({
        dom,
        getContext: context,
        onSelectTerritory(id, selection = {}) {
          selectedTerritoryId = id;
          selectedOrderId = null;
          selectedSourceIds = selection.selectedIds ?? [];
          renderGame();
        },
        async onDrawOrder(payloads, metadata = {}) {
          if (!payloads.length) {
            showError(new Error(`所选城市均无法到达目标；跨越己方城市的陆路最远 ${LAND_RELAY_RANGE_KM} 公里。`));
            return;
          }
          selectedTerritoryId = payloads[0].source;
          selectedOrderId = metadata.batch ? null : `${payloads[0].source}:${payloads[0].target}:${payloads[0].mode}`;
          await action(async () => {
            for (const payload of payloads) await network.request("stageOrder", payload);
            if (metadata.batch && metadata.skipped) showError(new Error(`已部署 ${payloads.length} 座城市；另有 ${metadata.skipped} 座因距离、路线或兵力限制被跳过。`));
          });
        },
      }).then((controller) => {
        mapController = controller;
        return controller;
      }).catch((error) => {
        mapPromise = null;
        throw error;
      });
    }
    await mapPromise;
  }

  lobbyDialog.addEventListener("cancel", (event) => event.preventDefault());
  ui.back.addEventListener("click", async () => {
    if (network?.socket.connected && roomState?.status === "lobby") {
      const left = await action(() => network.request("leaveRoom"));
      if (left) clearSavedSession();
    }
    network?.socket.disconnect();
    lobbyDialog.close();
    resetLobby();
    entryDialog.showModal();
  });
  ui.createRoom.addEventListener("click", () => action(() => claimSession("createRoom", {
    playerName: ui.playerName.value,
    maxPlayers: Number(ui.maxPlayers.value),
    gameMode: ui.gameMode.value,
    strategicTerrain: ui.strategicTerrain.checked,
  })));
  ui.joinRoom.addEventListener("click", () => action(() => claimSession("joinRoom", { playerName: ui.playerName.value, roomCode: ui.roomCodeInput.value })));
  ui.lobbyFactions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-lobby-faction]");
    if (button) action(() => network.request("selectFaction", { factionId: button.dataset.lobbyFaction }));
  });
  ui.ready.addEventListener("click", () => {
    const player = roomState?.players.find((candidate) => candidate.id === roomState.viewerPlayerId);
    if (player) action(() => network.request("setReady", { ready: !player.ready }));
  });
  ui.start.addEventListener("click", () => action(async () => {
    startingGame = true;
    try { return await network.request("startGame"); } finally { startingGame = false; }
  }));
  dom.orderModeSwitch.querySelectorAll("[data-order-mode]").forEach((button) => button.addEventListener("click", () => {
    if (!canAct()) return;
    orderMode = button.dataset.orderMode;
    selectedOrderId = null;
    renderGame();
  }));
  dom.orderList.addEventListener("click", (event) => {
    const cancel = event.target.closest("[data-cancel-order]");
    if (cancel) {
      action(() => network.request("cancelOrder", { orderId: cancel.dataset.cancelOrder }));
      return;
    }
    const item = event.target.closest("[data-order-id]");
    if (item) { selectedOrderId = item.dataset.orderId; renderSummary(); }
  });
  dom.summary.addEventListener("click", (event) => {
    const cancel = event.target.closest("[data-cancel-construction]");
    if (cancel) {
      action(() => network.request("cancelConstruction", { constructionId: cancel.dataset.cancelConstruction }));
      return;
    }
    const button = event.target.closest("[data-build]");
    if (button && selectedTerritoryId) action(() => network.request("startConstruction", { territoryId: selectedTerritoryId, type: button.dataset.build }));
  });
  dom.endTurn.addEventListener("click", () => action(() => network.request("endTurn")));
  dom.rollback.addEventListener("click", () => action(async () => {
    const result = await network.request("saveGame");
    dom.rollback.textContent = "已保存";
    window.setTimeout(() => { if (gameState) dom.rollback.textContent = "保存战局"; }, 1200);
    return result;
  }));
  dom.pauseGame.addEventListener("click", () => action(() => network.request("setGamePaused", { paused: gameState?.phase !== "paused" })));
  dom.rulesButton.addEventListener("click", () => dom.rulesDialog.showModal());
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  dom.restart.addEventListener("click", () => window.location.reload());
  dom.resultRollback.style.display = "none";

  lobbyDialog.showModal();
  try {
    network = await createNetworkClient();
    network.socket.on("connect", () => {
      ui.connection.innerHTML = `<span class="connection-pill">已连接权威服务器</span>`;
      clearError();
      startLatencyMonitor();
      attemptResume();
    });
    network.socket.on("disconnect", () => {
      showLatency(null);
      ui.connection.textContent = "连接中断；服务器已暂停战局，正在等待自动重连。";
      showError(new Error("连接中断，当前席位与未提交部署已保留。"));
    });
    network.socket.on("connect_error", (error) => showError(new Error(`连接失败：${error.message}`)));
    network.socket.on("errorMessage", (payload) => showError(new Error(payload.message)));
    network.socket.on("roomState", (next) => { roomState = next; renderLobby(); });
    network.socket.on("gameStarted", async () => {
      startingGame = false;
      lobbyDialog.close();
      await ensureMap();
      renderGame();
    });
    network.socket.on("gameState", async (next) => {
      const resolution = next.lastResolution;
      gameState = next;
      if (lobbyDialog.open && roomState?.status === "playing") lobbyDialog.close();
      await ensureMap();
      renderGame();
      if (resolution?.round > lastAnimatedRound) await showResolution(resolution);
      if (next.phase === "finished") {
        const won = next.winnerId === roomState.viewerPlayerId;
        dom.resultSeal.textContent = won ? "胜" : "败";
        dom.resultTitle.textContent = next.winnerId ? (won ? "全境统一" : "势力覆灭") : "战局平局";
        const winner = next.players.find((candidate) => candidate.id === next.winnerId);
        dom.resultCopy.textContent = winner ? `${winner.name}（${FACTIONS[winner.factionId].name}）成为最后存活势力。` : "所有势力同时覆灭。";
        if (!dom.resultDialog.open) dom.resultDialog.showModal();
      }
    });
    if (!network.socket.connected) await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("连接服务器超时。")), 6000);
      network.socket.once("connect", () => { window.clearTimeout(timer); resolve(); });
    });
    ui.connection.innerHTML = `<span class="connection-pill">已连接权威服务器</span>`;
    startLatencyMonitor();
    await attemptResume();
  } catch (error) {
    ui.connection.textContent = "无法启用局域网模式。";
    showError(error);
  }
}
