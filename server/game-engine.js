import {
  AIRDROP_ATTRITION_RATE, AIR_RANGE_KM, CAPITAL_DEFENSE_MULTIPLIER, COASTAL_TERRITORIES,
  CONSTRUCTION_TURNS, DESERT_ATTRITION_RATE, EIGHT_FACTION_IDS, EIGHT_TERRITORY_GROUPS,
  ENCIRCLED_DEFENSE_MULTIPLIER, FACTIONS, FACTION_IDS,
  GROWTH_PER_TERRITORY, LANDING_ATTRITION_RATE, MAX_TROOPS, METROPOLIS_DEFENSE_MULTIPLIER,
  METROPOLIS_MAX_TROOPS, MILITARY_STRONGHOLDS, MOUNTAIN_ATTRITION_RATE, MAX_AIRPORTS_PER_FACTION,
  LAND_RELAY_RANGE_KM,
  MOUNTAIN_DEFENSE_MULTIPLIER, mountainBarrierForEdge, NEUTRAL, RIVER_ATTRITION_RATE,
  STRONGHOLD_DEFENSE_MULTIPLIER,
} from "../dist/modules/config.js";
import { haversineKm, lineIntersectsGeometry, pointInGeometry, segmentsIntersect } from "./rule-geometry.js";
import {
  MAP_BOUNDS, RIVER_SEGMENTS, TERRAIN_FEATURES, TERRITORY_ADJACENCY,
  TERRITORY_DEFINITIONS, TERRITORY_IDS,
} from "./game-data.js";

export class GameRuleError extends Error {
  constructor(message, code = "INVALID_ACTION") {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

function requireRule(condition, message, code) {
  if (!condition) throw new GameRuleError(message, code);
}

function territoryCap(territory) {
  return territory.metropolis ? METROPOLIS_MAX_TROOPS : MAX_TROOPS;
}

function livingPlayers(game) {
  return game.players.filter((player) => !player.eliminated);
}

function livingHumanPlayers(game) {
  return game.players.filter((player) => !player.isNpc && !player.eliminated);
}

function playerFor(game, playerId) {
  const player = game.players.find((candidate) => candidate.id === playerId);
  requireRule(player, "玩家不在当前游戏中。", "PLAYER_NOT_FOUND");
  return player;
}

function assertTurn(game, playerId) {
  requireRule(game.phase !== "paused", "战局已暂停，请等待所有玩家重连或由房主继续。", "GAME_PAUSED");
  requireRule(game.phase === "planning" && !game.winnerId, "当前战局不能继续下达命令。", "GAME_NOT_ACTIVE");
  const player = playerFor(game, playerId);
  requireRule(!player.isNpc, "NPC 不能由客户端操作。", "NPC_CONTROLLED");
  requireRule(!player.eliminated, "该势力已被消灭。", "PLAYER_ELIMINATED");
  requireRule(!game.submittedPlayerIds.includes(playerId), "本轮部署已经提交。", "TURN_ALREADY_ENDED");
  return player;
}

export function createGameState(room) {
  const settings = {
    gameMode: room.settings?.gameMode === "partition" ? "partition" : "expansion",
    strategicTerrain: Boolean(room.settings?.strategicTerrain),
  };
  const factionIds = settings.gameMode === "partition" ? EIGHT_FACTION_IDS : FACTION_IDS;
  const humanPlayers = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    factionId: player.factionId,
    connected: player.connected,
    eliminated: false,
    host: player.id === room.hostPlayerId,
    isNpc: false,
  }));
  const chosenFactions = new Set(humanPlayers.map((player) => player.factionId));
  const npcPlayers = factionIds.filter((factionId) => !chosenFactions.has(factionId)).map((factionId) => ({
    id: `npc:${factionId}`,
    name: `${FACTIONS[factionId].name} NPC`,
    factionId,
    connected: true,
    eliminated: false,
    host: false,
    isNpc: true,
  }));
  const players = [...humanPlayers, ...npcPlayers];
  const territories = Object.fromEntries(TERRITORY_IDS.map((id) => [id, {
    owner: NEUTRAL,
    troops: 6,
    airport: false,
    port: false,
    metropolis: false,
    construction: null,
    capitalOf: null,
  }]));
  if (settings.gameMode === "partition") {
    const assignments = Object.fromEntries(Object.entries(EIGHT_TERRITORY_GROUPS).flatMap(([owner, ids]) => ids.map((id) => [id, owner])));
    for (const id of TERRITORY_IDS) {
      const owner = assignments[id];
      const capital = FACTIONS[owner].start === id;
      territories[id] = { ...territories[id], owner, troops: capital ? 15 : 8, capitalOf: capital ? owner : null };
    }
  } else for (const factionId of factionIds) {
    const start = FACTIONS[factionId].start;
    territories[start] = { ...territories[start], owner: factionId, troops: 15, capitalOf: factionId };
  }
  return {
    roomCode: room.code,
    settings,
    phase: "planning",
    round: 1,
    currentPlayerIndex: null,
    currentPlayerId: null,
    players,
    territories,
    fleets: [],
    pendingOrders: Object.fromEntries(players.map((player) => [player.id, []])),
    pendingConstructions: Object.fromEntries(players.map((player) => [player.id, []])),
    submittedPlayerIds: [],
    roundStartTerritories: structuredClone(territories),
    phaseBeforePause: null,
    pauseReason: null,
    pausedPlayerIds: [],
    winnerId: null,
    winnerFactionId: null,
    lastResolution: null,
    logs: [{ type: "info", text: `第 1 回合开始，${humanPlayers.length} 名玩家同时部署。` }],
  };
}

function partitionTerritories(factionIds) {
  const quotas = Object.fromEntries(factionIds.map((id, index) => [id, Math.floor(TERRITORY_IDS.length / factionIds.length) + (index < TERRITORY_IDS.length % factionIds.length ? 1 : 0)]));
  const assignments = {};
  const counts = Object.fromEntries(factionIds.map((id) => [id, 1]));
  for (const factionId of factionIds) assignments[FACTIONS[factionId].start] = factionId;
  while (Object.keys(assignments).length < TERRITORY_IDS.length) {
    const candidates = [];
    for (const factionId of factionIds) {
      const owned = Object.keys(assignments).filter((id) => assignments[id] === factionId);
      for (const source of owned) for (const target of TERRITORY_ADJACENCY[source] ?? []) if (!assignments[target]) {
        candidates.push({ factionId, target, score: counts[factionId] / quotas[factionId] + haversineKm(TERRITORY_DEFINITIONS[target].label, TERRITORY_DEFINITIONS[FACTIONS[factionId].start].label) / 5000 });
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.score - b.score || a.target.localeCompare(b.target));
    const chosen = candidates[0];
    assignments[chosen.target] = chosen.factionId;
    counts[chosen.factionId] += 1;
  }

  const connectedAfterRemoval = (factionId, removedId) => {
    const owned = TERRITORY_IDS.filter((id) => id !== removedId && assignments[id] === factionId);
    if (!owned.length) return false;
    const visited = new Set([owned[0]]);
    const queue = [owned[0]];
    while (queue.length) for (const next of TERRITORY_ADJACENCY[queue.shift()] ?? []) if (next !== removedId && assignments[next] === factionId && !visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
    return visited.size === owned.length;
  };

  const rebalanceDirect = () => {
    let movedAny = false;
    for (let pass = 0; pass < 500; pass += 1) {
      let moved = false;
      const recipients = factionIds.filter((id) => counts[id] < quotas[id]).sort((a, b) => (quotas[b] - counts[b]) - (quotas[a] - counts[a]));
      for (const recipient of recipients) {
        const candidates = TERRITORY_IDS.filter((id) => {
          const donor = assignments[id];
          return donor !== recipient && counts[donor] > quotas[donor] && id !== FACTIONS[donor].start
            && (TERRITORY_ADJACENCY[id] ?? []).some((next) => assignments[next] === recipient)
            && connectedAfterRemoval(donor, id);
        }).sort((a, b) => haversineKm(TERRITORY_DEFINITIONS[a].label, TERRITORY_DEFINITIONS[FACTIONS[recipient].start].label) - haversineKm(TERRITORY_DEFINITIONS[b].label, TERRITORY_DEFINITIONS[FACTIONS[recipient].start].label));
        if (!candidates.length) continue;
        const territoryId = candidates[0];
        const donor = assignments[territoryId];
        assignments[territoryId] = recipient;
        counts[donor] -= 1;
        counts[recipient] += 1;
        moved = true;
        movedAny = true;
      }
      if (!moved) break;
    }
    return movedAny;
  };

  rebalanceDirect();
  for (let pass = 0; pass < 50 && factionIds.some((id) => counts[id] !== quotas[id]); pass += 1) {
    const over = factionIds.find((id) => counts[id] > quotas[id]);
    const under = factionIds.find((id) => counts[id] < quotas[id]);
    if (!over || !under) break;
    const regionGraph = Object.fromEntries(factionIds.map((id) => [id, new Set()]));
    for (const id of TERRITORY_IDS) for (const next of TERRITORY_ADJACENCY[id] ?? []) if (assignments[id] !== assignments[next]) regionGraph[assignments[id]].add(assignments[next]);
    const queue = [over];
    const previous = new Map([[over, null]]);
    while (queue.length && !previous.has(under)) {
      const current = queue.shift();
      for (const next of regionGraph[current] ?? []) if (!previous.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
    if (!previous.has(under)) break;
    const ownerPath = [];
    for (let current = under; current !== null; current = previous.get(current)) ownerPath.unshift(current);
    const donor = ownerPath[0];
    const recipient = ownerPath[1];
    const candidates = TERRITORY_IDS.filter((id) => assignments[id] === donor && id !== FACTIONS[donor].start
      && (TERRITORY_ADJACENCY[id] ?? []).some((next) => assignments[next] === recipient)
      && connectedAfterRemoval(donor, id));
    if (!candidates.length) break;
    const territoryId = candidates.sort((a, b) => haversineKm(TERRITORY_DEFINITIONS[a].label, TERRITORY_DEFINITIONS[FACTIONS[recipient].start].label) - haversineKm(TERRITORY_DEFINITIONS[b].label, TERRITORY_DEFINITIONS[FACTIONS[recipient].start].label))[0];
    assignments[territoryId] = recipient;
    counts[donor] -= 1;
    counts[recipient] += 1;
    rebalanceDirect();
  }

  const imbalance = () => factionIds.reduce((sum, id) => sum + Math.abs(counts[id] - quotas[id]), 0);
  let bestScore = imbalance();
  let bestAssignments = { ...assignments };
  let randomState = factionIds.join(":").split("").reduce((value, character) => Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const visited = new Set();
  for (let step = 0; bestScore > 0 && step < 12000; step += 1) {
    const currentScore = imbalance();
    const candidates = [];
    for (const territoryId of TERRITORY_IDS) {
      const donor = assignments[territoryId];
      if (territoryId === FACTIONS[donor].start || !connectedAfterRemoval(donor, territoryId)) continue;
      const recipients = new Set((TERRITORY_ADJACENCY[territoryId] ?? []).map((next) => assignments[next]).filter((owner) => owner !== donor));
      for (const recipient of recipients) {
        const before = Math.abs(counts[donor] - quotas[donor]) + Math.abs(counts[recipient] - quotas[recipient]);
        const after = Math.abs(counts[donor] - 1 - quotas[donor]) + Math.abs(counts[recipient] + 1 - quotas[recipient]);
        candidates.push({ territoryId, donor, recipient, delta: after - before });
      }
    }
    if (!candidates.length) break;
    const improving = candidates.filter((candidate) => candidate.delta < 0);
    const neutral = candidates.filter((candidate) => candidate.delta === 0);
    const worsening = candidates.filter((candidate) => candidate.delta > 0);
    const pool = improving.length ? improving : neutral.length && (step % 7 !== 0 || !worsening.length) ? neutral : worsening;
    let moved = false;
    for (let attempt = 0; attempt < Math.min(pool.length, 30); attempt += 1) {
      const candidate = pool[Math.floor(random() * pool.length)];
      assignments[candidate.territoryId] = candidate.recipient;
      const stateKey = TERRITORY_IDS.map((id) => factionIds.indexOf(assignments[id])).join("");
      if (candidate.delta <= 0 && visited.has(stateKey)) {
        assignments[candidate.territoryId] = candidate.donor;
        continue;
      }
      visited.add(stateKey);
      counts[candidate.donor] -= 1;
      counts[candidate.recipient] += 1;
      moved = true;
      break;
    }
    if (!moved) continue;
    const score = imbalance();
    if (score < bestScore) {
      bestScore = score;
      bestAssignments = { ...assignments };
    }
    if (score === 0) break;
    if (score > currentScore + 2 && random() > 0.08) step += 2;
  }
  if (bestScore < imbalance()) {
    Object.assign(assignments, bestAssignments);
  }
  return assignments;
}

function defaultLandPath(game, source, target) {
  const passable = (a, b) => !game.settings?.strategicTerrain || !mountainBarrierForEdge(a, b);
  if (TERRITORY_ADJACENCY[source]?.includes(target) && passable(source, target)) return [source, target];
  if (haversineKm(TERRITORY_DEFINITIONS[source].label, TERRITORY_DEFINITIONS[target].label) > LAND_RELAY_RANGE_KM) return null;
  const middle = TERRITORY_ADJACENCY[source]?.find((id) => game.territories[id].owner === game.territories[source].owner && TERRITORY_ADJACENCY[id]?.includes(target) && passable(source, id) && passable(id, target));
  return middle ? [source, middle, target] : null;
}

function validateLandPath(game, source, target, proposedPath) {
  const path = Array.isArray(proposedPath) ? proposedPath.map(String) : defaultLandPath(game, source, target);
  requireRule(path && (path.length === 2 || path.length === 3), "陆路最多跨越一座己方中间城市。", "INVALID_ROUTE");
  requireRule(path[0] === source && path.at(-1) === target, "陆路起点或终点不匹配。", "INVALID_ROUTE");
  for (let index = 1; index < path.length; index += 1) {
    requireRule(TERRITORY_ADJACENCY[path[index - 1]]?.includes(path[index]), "陆路存在不相邻的城市。", "INVALID_ROUTE");
    const barrier = game.settings?.strategicTerrain ? mountainBarrierForEdge(path[index - 1], path[index]) : null;
    requireRule(!barrier, `${barrier}阻断该陆路，请改走军事重镇或使用空降。`, "MOUNTAIN_BLOCKED");
  }
  if (path.length === 3) {
    requireRule(game.territories[path[1]]?.owner === game.territories[source].owner, "中间城市必须属于同一势力。", "INVALID_ROUTE");
    requireRule(haversineKm(TERRITORY_DEFINITIONS[source].label, TERRITORY_DEFINITIONS[target].label) <= LAND_RELAY_RANGE_KM, `跨城陆路调遣最远 ${LAND_RELAY_RANGE_KM} 公里；相邻城市不受此限制。`, "OUT_OF_RANGE");
  }
  return path;
}

function sanitizeRouteGeo(source, target, routeGeo) {
  const sourcePoint = TERRITORY_DEFINITIONS[source].label;
  const targetPoint = TERRITORY_DEFINITIONS[target].label;
  if (!Array.isArray(routeGeo) || routeGeo.length < 2) return [sourcePoint, targetPoint];
  requireRule(routeGeo.length <= 32, "划线路径采样点过多。", "INVALID_ROUTE");
  const clean = routeGeo.map((point) => {
    requireRule(Array.isArray(point) && point.length === 2 && point.every(Number.isFinite), "划线路径坐标无效。", "INVALID_ROUTE");
    const [lon, lat] = point;
    requireRule(lon >= MAP_BOUNDS.minLon - 1 && lon <= MAP_BOUNDS.maxLon + 1 && lat >= MAP_BOUNDS.minLat - 1 && lat <= MAP_BOUNDS.maxLat + 1, "划线路径超出战区范围。", "INVALID_ROUTE");
    return [lon, lat];
  });
  clean[0] = [...sourcePoint];
  clean[clean.length - 1] = [...targetPoint];
  return clean;
}

function analyzeOrder(game, order) {
  if (order.mode === "air") return { rate: AIRDROP_ATTRITION_RATE, rivers: [], terrain: [], label: "空降损耗" };
  if (order.mode === "sea") return { rate: LANDING_ATTRITION_RATE, rivers: [], terrain: [], label: "登陆损耗" };
  if (game.territories[order.target].owner === order.owner) return { rate: 0, rivers: [], terrain: [], label: "己方调动" };
  const sourcePoint = TERRITORY_DEFINITIONS[order.source].label;
  const targetPoint = TERRITORY_DEFINITIONS[order.target].label;
  const route = order.routeGeo?.length > 1 ? order.routeGeo : order.path.map((id) => TERRITORY_DEFINITIONS[id].label);
  const rivers = new Set();
  const mountains = new Set();
  const deserts = new Set();
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    for (const river of RIVER_SEGMENTS) if (segmentsIntersect(start, end, river.a, river.b)) rivers.add(river.name);
    for (const feature of TERRAIN_FEATURES) {
      if (pointInGeometry(sourcePoint, feature.geometry) || pointInGeometry(targetPoint, feature.geometry)) continue;
      if (!lineIntersectsGeometry(start, end, feature.geometry)) continue;
      if (game.settings?.strategicTerrain && feature.properties.kind !== "desert") continue;
      const collection = feature.properties.kind === "desert" ? deserts : mountains;
      collection.add(feature.properties.nameZh || feature.properties.name);
    }
  }
  const rate = Math.min(0.6, (rivers.size ? RIVER_ATTRITION_RATE : 0) + (mountains.size ? MOUNTAIN_ATTRITION_RATE : 0) + (deserts.size ? DESERT_ATTRITION_RATE : 0));
  return { rate, rivers: [...rivers].slice(0, 3), terrain: [...mountains, ...deserts].slice(0, 3), label: "路线地形损耗" };
}

export function stageOrder(game, playerId, payload = {}) {
  const player = assertTurn(game, playerId);
  const source = String(payload.source ?? "");
  const target = String(payload.target ?? "");
  const mode = payload.mode ?? "land";
  const amount = Number(payload.amount);
  requireRule(TERRITORY_DEFINITIONS[source] && TERRITORY_DEFINITIONS[target] && source !== target, "起点或目标城市无效。", "INVALID_TERRITORY");
  requireRule(game.territories[source].owner === player.factionId, "只能从自己的领地派兵。", "NOT_OWNER");
  requireRule(Number.isInteger(amount) && amount >= 1, "出征兵力必须是正整数。", "INVALID_AMOUNT");
  requireRule(["land", "air", "sea"].includes(mode), "未知的命令类型。", "INVALID_MODE");
  let path;
  if (mode === "land") path = validateLandPath(game, source, target, payload.path);
  if (mode === "air") {
    requireRule(game.territories[source].airport, "起点城市没有机场。", "AIRPORT_REQUIRED");
    requireRule(haversineKm(TERRITORY_DEFINITIONS[source].label, TERRITORY_DEFINITIONS[target].label) <= AIR_RANGE_KM, `目标超出 ${AIR_RANGE_KM} 公里空降范围。`, "OUT_OF_RANGE");
    path = [source, target];
  }
  if (mode === "sea") {
    requireRule(game.territories[source].port && COASTAL_TERRITORIES.has(source), "只能从己方沿海港口发起登陆。", "PORT_REQUIRED");
    requireRule(COASTAL_TERRITORIES.has(target) && game.territories[target].owner !== player.factionId, "登陆目标必须是敌方沿海城市。", "INVALID_TARGET");
    path = [source, target];
  }
  const orders = game.pendingOrders[playerId];
  const orderId = `${source}:${target}:${mode}`;
  const current = orders.find((order) => order.id === orderId);
  const fromSource = orders.filter((order) => order.source === source && order.id !== orderId);
  requireRule(current || fromSource.length < 2, "每个据点每回合最多派出两路部队。", "TOO_MANY_ROUTES");
  const committed = fromSource.reduce((sum, order) => sum + order.amount, 0);
  requireRule(amount <= game.territories[source].troops - 1 - committed, "出征后必须至少留下 1 名守军。", "INSUFFICIENT_TROOPS");
  const order = {
    id: orderId,
    playerId,
    owner: player.factionId,
    source,
    target,
    mode,
    amount,
    path,
    routeGeo: sanitizeRouteGeo(source, target, payload.routeGeo),
  };
  if (current) orders.splice(orders.indexOf(current), 1, order);
  else orders.push(order);
  return order;
}

export function cancelOrder(game, playerId, orderId) {
  assertTurn(game, playerId);
  const orders = game.pendingOrders[playerId];
  const index = orders.findIndex((order) => order.id === orderId);
  requireRule(index >= 0, "命令不存在或不属于你。", "ORDER_NOT_FOUND");
  orders.splice(index, 1);
}

export function startConstruction(game, playerId, payload = {}) {
  const player = assertTurn(game, playerId);
  const territoryId = String(payload.territoryId ?? payload.territory ?? "");
  const type = payload.type;
  const territory = game.territories[territoryId];
  requireRule(territory && territory.owner === player.factionId, "只能在自己的城市建设。", "NOT_OWNER");
  requireRule(["airport", "port"].includes(type), "未知的建设类型。", "INVALID_CONSTRUCTION");
  const pending = game.pendingConstructions[playerId] ??= [];
  requireRule(!territory.construction && !pending.some((order) => order.territoryId === territoryId), "城市已有建设项目。", "CONSTRUCTION_EXISTS");
  requireRule(type !== "airport" || !territory.airport, "机场已经建成。", "FACILITY_EXISTS");
  if (type === "airport") {
    const existing = Object.values(game.territories).filter((item) => item.owner === player.factionId && (item.airport || item.construction?.type === "airport")).length;
    const queued = Object.values(game.pendingConstructions ?? {}).flat().filter((order) => order.owner === player.factionId && order.type === "airport").length;
    requireRule(existing + queued < MAX_AIRPORTS_PER_FACTION, `每个势力最多拥有 ${MAX_AIRPORTS_PER_FACTION} 个机场（含在建和待提交）。`, "AIRPORT_LIMIT");
  }
  requireRule(type !== "port" || (!territory.port && COASTAL_TERRITORIES.has(territoryId)), "只有未建港的沿海城市可以修建港口。", "INVALID_PORT");
  const order = { id: `${territoryId}:${type}`, playerId, owner: player.factionId, territoryId, type };
  pending.push(order);
  return order;
}

export function cancelConstruction(game, playerId, constructionId) {
  assertTurn(game, playerId);
  const pending = game.pendingConstructions[playerId] ?? [];
  const index = pending.findIndex((order) => order.id === constructionId);
  requireRule(index >= 0, "建设命令不存在或不属于你。", "CONSTRUCTION_NOT_FOUND");
  pending.splice(index, 1);
}

function getSupplyReachable(game, factionId) {
  const owned = TERRITORY_IDS.filter((id) => game.territories[id].owner === factionId);
  const capital = owned.find((id) => game.territories[id].capitalOf === factionId);
  if (!capital) return new Set();
  const ownedSet = new Set(owned);
  const visited = new Set([capital]);
  const queue = [capital];
  while (queue.length) {
    const current = queue.shift();
    const links = TERRITORY_ADJACENCY[current].filter((id) => ownedSet.has(id));
    if (game.territories[current].airport) links.push(...owned.filter((id) => id !== current && game.territories[id].airport && haversineKm(TERRITORY_DEFINITIONS[current].label, TERRITORY_DEFINITIONS[id].label) <= AIR_RANGE_KM));
    if (game.territories[current].port) links.push(...owned.filter((id) => id !== current && COASTAL_TERRITORIES.has(id)));
    else if (COASTAL_TERRITORIES.has(current)) links.push(...owned.filter((id) => game.territories[id].port));
    for (const next of links) if (!visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

function getEncircled(game) {
  const result = new Set();
  for (const player of game.players) {
    const supplied = getSupplyReachable(game, player.factionId);
    for (const id of TERRITORY_IDS) if (game.territories[id].owner === player.factionId && !supplied.has(id)) result.add(id);
  }
  return result;
}

function ensureCapitals(game, report) {
  for (const territory of Object.values(game.territories)) if (territory.capitalOf && territory.owner !== territory.capitalOf) territory.capitalOf = null;
  for (const player of game.players) {
    const holdings = TERRITORY_IDS.filter((id) => game.territories[id].owner === player.factionId);
    if (!holdings.length || holdings.some((id) => game.territories[id].capitalOf === player.factionId)) continue;
    const next = holdings.sort((a, b) => game.territories[b].troops - game.territories[a].troops)[0];
    game.territories[next].capitalOf = player.factionId;
    report.push({ type: "strategy", text: `${FACTIONS[player.factionId].name}迁都${TERRITORY_DEFINITIONS[next].name}。` });
  }
}

function hashRoll(...values) {
  let hash = 2166136261;
  for (const character of values.join(":")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function npcTargetScore(snapshot, targetId, faction) {
  const target = snapshot[targetId];
  const neutralBonus = target.owner === NEUTRAL ? (faction.style === "expander" ? -7 : -3) : 0;
  return target.troops + neutralBonus;
}

function queueNpcOrder(game, npc, { source, target, amount, mode = "land", path = null }) {
  const territory = game.territories[source];
  if (!territory || territory.owner !== npc.factionId || source === target) return false;
  const orders = game.pendingOrders[npc.id] ??= [];
  const fromSource = orders.filter((order) => order.source === source);
  if (fromSource.length >= 2) return false;
  const committed = fromSource.reduce((sum, order) => sum + order.amount, 0);
  const safeAmount = Math.min(Math.trunc(amount), territory.troops - 1 - committed);
  if (safeAmount < 1) return false;
  let resolvedPath = path;
  if (mode === "land") resolvedPath = path ?? defaultLandPath(game, source, target);
  if (!resolvedPath) return false;
  if (mode === "air" && (!territory.airport || haversineKm(TERRITORY_DEFINITIONS[source].label, TERRITORY_DEFINITIONS[target].label) > AIR_RANGE_KM)) return false;
  if (mode === "sea" && (!territory.port || !COASTAL_TERRITORIES.has(source) || !COASTAL_TERRITORIES.has(target) || game.territories[target].owner === npc.factionId)) return false;
  orders.push({
    id: `${source}:${target}:${mode}`,
    playerId: npc.id,
    owner: npc.factionId,
    source,
    target,
    mode,
    amount: safeAmount,
    path: resolvedPath,
    routeGeo: resolvedPath.map((id) => [...TERRITORY_DEFINITIONS[id].label]),
  });
  return true;
}

function maybeQueueNpcConstruction(game, npc, snapshot) {
  const holdings = TERRITORY_IDS.filter((id) => snapshot[id].owner === npc.factionId);
  if (holdings.length < 2 || holdings.some((id) => snapshot[id].construction)) return;
  const airports = holdings.filter((id) => snapshot[id].airport || snapshot[id].construction?.type === "airport").length;
  const hasPort = holdings.some((id) => snapshot[id].port || snapshot[id].construction?.type === "port");
  let type = null;
  if (airports < 1 && game.round >= 2) type = "airport";
  else if (!hasPort && game.round >= 4 && holdings.some((id) => COASTAL_TERRITORIES.has(id))) type = "port";
  if (!type || hashRoll(game.round, npc.factionId, "construction") < .45) return;
  const candidates = holdings.filter((id) => type === "airport"
    ? !snapshot[id].airport && snapshot[id].construction?.type !== "airport" && airports < MAX_AIRPORTS_PER_FACTION
    : COASTAL_TERRITORIES.has(id) && !snapshot[id].port && snapshot[id].construction?.type !== "port")
    .sort((a, b) => snapshot[b].troops - snapshot[a].troops || a.localeCompare(b));
  if (!candidates[0]) return;
  game.pendingConstructions[npc.id] = [{ id: `${candidates[0]}:${type}`, playerId: npc.id, owner: npc.factionId, territoryId: candidates[0], type }];
}

function generateNpcPlans(game) {
  const snapshot = structuredClone(game.roundStartTerritories ?? game.territories);
  for (const npc of game.players.filter((player) => player.isNpc && !player.eliminated)) {
    game.pendingOrders[npc.id] = [];
    game.pendingConstructions[npc.id] = [];
    const holdings = TERRITORY_IDS.filter((id) => snapshot[id].owner === npc.factionId);
    for (const source of holdings) {
      let remaining = snapshot[source].troops - 1;
      if (remaining < 3) continue;
      const candidates = TERRITORY_IDS.filter((target) => snapshot[target].owner !== npc.factionId)
        .map((target) => ({ target, path: defaultLandPath(game, source, target) }))
        .filter((candidate) => candidate.path)
        .sort((a, b) => npcTargetScore(snapshot, a.target, FACTIONS[npc.factionId]) - npcTargetScore(snapshot, b.target, FACTIONS[npc.factionId]) || a.target.localeCompare(b.target));
      let routes = 0;
      for (const candidate of candidates) {
        if (routes >= 2 || remaining < 3) break;
        const target = snapshot[candidate.target];
        const roll = hashRoll(game.round, npc.factionId, source, candidate.target);
        const margin = FACTIONS[npc.factionId].style === "steady" ? 3 : FACTIONS[npc.factionId].style === "aggressive" ? 0 : 1;
        const neutralDrive = FACTIONS[npc.factionId].style === "expander" && target.owner === NEUTRAL;
        if (!(remaining >= target.troops + margin || (neutralDrive && remaining >= target.troops) || roll > (routes === 0 ? .78 : .9))) continue;
        if (routes === 1 && roll < .38) continue;
        const preserve = routes === 0 && candidates.length > 1 && remaining >= 10;
        const routeCap = preserve ? Math.max(3, Math.ceil(remaining * .62)) : remaining;
        const amount = Math.max(3, Math.min(routeCap, remaining, target.troops + 2 + Math.floor(roll * 3)));
        if (queueNpcOrder(game, npc, { source, target: candidate.target, amount, path: candidate.path })) {
          remaining -= amount;
          routes += 1;
        }
      }
      if (routes > 0) continue;
      const roll = hashRoll(game.round, npc.factionId, source, "remote");
      const remoteMode = snapshot[source].airport ? "air" : snapshot[source].port && COASTAL_TERRITORIES.has(source) ? "sea" : null;
      if (remoteMode && roll > .72) {
        const remoteTarget = TERRITORY_IDS.filter((id) => snapshot[id].owner !== npc.factionId
          && (remoteMode === "air" ? haversineKm(TERRITORY_DEFINITIONS[source].label, TERRITORY_DEFINITIONS[id].label) <= AIR_RANGE_KM : COASTAL_TERRITORIES.has(id)))
          .sort((a, b) => npcTargetScore(snapshot, a, FACTIONS[npc.factionId]) - npcTargetScore(snapshot, b, FACTIONS[npc.factionId]))[0];
        if (remoteTarget) queueNpcOrder(game, npc, { source, target: remoteTarget, amount: Math.max(3, Math.min(remaining, snapshot[remoteTarget].troops + 4)), mode: remoteMode, path: [source, remoteTarget] });
      }
    }
    maybeQueueNpcConstruction(game, npc, snapshot);
  }
}

function resolveRound(game) {
  const orders = Object.values(game.pendingOrders).flat().map((order) => structuredClone(order));
  const constructions = Object.values(game.pendingConstructions ?? {}).flat().map((order) => structuredClone(order));
  const forces = {};
  const attackModes = {};
  const budgets = {};
  const report = [];
  const contested = new Set();
  const encircledBefore = getEncircled(game);
  for (const construction of constructions) {
    const territory = game.territories[construction.territoryId];
    if (!territory || territory.owner !== construction.owner || territory.construction) continue;
    territory.construction = { type: construction.type, remaining: CONSTRUCTION_TURNS };
    report.push({ type: "strategy", text: `${FACTIONS[construction.owner].name}在${TERRITORY_DEFINITIONS[construction.territoryId].name}开始修建${construction.type === "airport" ? "机场" : "港口"}。` });
  }
  for (const [id, territory] of Object.entries(game.territories)) {
    forces[id] = { [territory.owner]: territory.troops };
    attackModes[id] = {};
    budgets[`${territory.owner}:${id}`] = Math.max(0, territory.troops - 1);
  }
  const movements = [];
  for (const order of orders) {
    const key = `${order.owner}:${order.source}`;
    const amount = Math.max(0, Math.min(order.amount, budgets[key] ?? 0));
    if (!amount) continue;
    budgets[key] -= amount;
    forces[order.source][order.owner] -= amount;
    const analysis = analyzeOrder(game, order);
    const attrition = analysis.rate > 0 && amount >= 4 ? Math.max(1, Math.floor(amount * analysis.rate)) : 0;
    movements.push({ ...order, sent: amount, troops: amount - attrition, attrition });
    if (attrition) report.push({ type: "terrain", text: `${FACTIONS[order.owner].name}从${TERRITORY_DEFINITIONS[order.source].shortName}出征，${[...analysis.rivers, ...analysis.terrain].join("、") || analysis.label}造成 ${attrition} 兵损耗。` });
  }
  const encounterEdges = new Set();
  for (const movement of movements) {
    if (movement.troops <= 0 || movement.mode === "sea") continue;
    const edge = [movement.source, movement.target].sort().join(":");
    if (encounterEdges.has(edge)) continue;
    encounterEdges.add(edge);
    const forward = movements.filter((candidate) => candidate.troops > 0 && candidate.mode !== "sea" && candidate.source === movement.source && candidate.target === movement.target);
    const reverse = movements.filter((candidate) => candidate.troops > 0 && candidate.mode !== "sea" && candidate.source === movement.target && candidate.target === movement.source && candidate.owner !== movement.owner);
    if (!forward.length || !reverse.length) continue;
    const forwardTotal = forward.reduce((sum, candidate) => sum + candidate.troops, 0);
    const reverseTotal = reverse.reduce((sum, candidate) => sum + candidate.troops, 0);
    const winningGroup = forwardTotal > reverseTotal ? forward : reverseTotal > forwardTotal ? reverse : null;
    const losingGroup = winningGroup === forward ? reverse : forward;
    for (const candidate of losingGroup) candidate.troops = 0;
    if (!winningGroup) {
      for (const candidate of [...forward, ...reverse]) candidate.troops = 0;
      report.push({ type: "battle", text: `${TERRITORY_DEFINITIONS[movement.source].shortName}—${TERRITORY_DEFINITIONS[movement.target].shortName}遭遇战，双方出征部队同归于尽。` });
      continue;
    }
    let survivors = Math.abs(forwardTotal - reverseTotal);
    for (const candidate of winningGroup) {
      const remaining = Math.min(candidate.troops, survivors);
      candidate.troops = remaining;
      survivors -= remaining;
    }
    report.push({ type: "battle", text: `${TERRITORY_DEFINITIONS[movement.source].shortName}—${TERRITORY_DEFINITIONS[movement.target].shortName}遭遇战，${FACTIONS[winningGroup[0].owner].name}合计剩余 ${Math.abs(forwardTotal - reverseTotal)} 兵继续执行原任务。` });
  }
  const fleetGroups = new Map();
  for (const fleet of game.fleets) {
    if (!fleetGroups.has(fleet.target)) fleetGroups.set(fleet.target, []);
    fleetGroups.get(fleet.target).push({ ...fleet });
  }
  for (const movement of movements.filter((item) => item.mode === "sea" && item.troops > 0)) {
    if (!fleetGroups.has(movement.target)) fleetGroups.set(movement.target, []);
    fleetGroups.get(movement.target).push({ id: `fleet-${game.round}-${movement.owner}-${movement.source}-${movement.target}`, owner: movement.owner, origin: movement.source, target: movement.target, ships: movement.troops });
    contested.add(movement.target);
  }
  const fleets = [];
  for (const [target, group] of fleetGroups) {
    const totals = Object.entries(group.reduce((result, fleet) => ({ ...result, [fleet.owner]: (result[fleet.owner] ?? 0) + fleet.ships }), {}));
    const highest = Math.max(...totals.map(([, ships]) => ships));
    const leaders = totals.filter(([, ships]) => ships === highest);
    if (leaders.length > 1) {
      if (totals.length > 1) report.push({ type: "battle", text: `${TERRITORY_DEFINITIONS[target].shortName}近海舰队相互抵消。` });
      continue;
    }
    const [owner, ships] = leaders[0];
    const opposition = totals.filter(([candidate]) => candidate !== owner).reduce((sum, [, value]) => sum + value, 0);
    const representative = group.find((fleet) => fleet.owner === owner);
    fleets.push({ ...representative, owner, target, ships: Math.max(1, ships - opposition) });
  }
  game.fleets = fleets;
  for (const movement of movements) {
    if (movement.troops <= 0 || movement.mode === "sea") continue;
    forces[movement.target][movement.owner] = (forces[movement.target][movement.owner] ?? 0) + movement.troops;
    attackModes[movement.target][movement.owner] ??= new Set();
    attackModes[movement.target][movement.owner].add(movement.mode === "air" ? "air" : "land");
    if (game.territories[movement.target].owner !== movement.owner) contested.add(movement.target);
  }
  for (const fleet of game.fleets) {
    attackModes[fleet.target][fleet.owner] ??= new Set();
    attackModes[fleet.target][fleet.owner].add("sea");
  }
  for (const [id, forceMap] of Object.entries(forces)) {
    const participants = Object.entries(forceMap).filter(([, troops]) => troops > 0);
    const originalOwner = game.territories[id].owner;
    if (participants.length === 1) {
      const [owner, troops] = participants[0];
      game.territories[id].owner = owner;
      game.territories[id].troops = Math.min(territoryCap(game.territories[id]), troops);
      continue;
    }
    let defense = 1;
    if (!game.settings?.strategicTerrain && TERRITORY_DEFINITIONS[id].mountainRanges.length) defense *= MOUNTAIN_DEFENSE_MULTIPLIER;
    if (game.territories[id].capitalOf === originalOwner) defense *= CAPITAL_DEFENSE_MULTIPLIER;
    if (game.territories[id].metropolis) defense *= METROPOLIS_DEFENSE_MULTIPLIER;
    if (game.settings?.strategicTerrain && MILITARY_STRONGHOLDS[id]) defense *= STRONGHOLD_DEFENSE_MULTIPLIER;
    if (encircledBefore.has(id)) defense *= ENCIRCLED_DEFENSE_MULTIPLIER;
    const effective = participants.map(([owner, troops]) => {
      const modes = attackModes[id][owner] ?? new Set();
      const combined = owner === originalOwner ? 1 : modes.size >= 3 ? 1.45 : modes.size >= 2 ? 1.2 : 1;
      return { owner, troops, modes, combined, value: Math.ceil(troops * (owner === originalOwner ? defense : combined)) };
    });
    const highest = Math.max(...effective.map((entry) => entry.value));
    const leaders = effective.filter((entry) => entry.value === highest);
    let winner = leaders.length > 1 ? (leaders.some((entry) => entry.owner === originalOwner) ? originalOwner : NEUTRAL) : leaders[0].owner;
    let survivors = 1;
    if (leaders.length === 1) {
      const opposition = effective.filter((entry) => entry.owner !== winner).map((entry) => entry.value);
      const remainingEffective = Math.max(1, Math.ceil(highest - opposition.reduce((sum, value) => sum + value, 0) / opposition.length));
      const winnerEntry = leaders[0];
      survivors = Math.max(1, Math.ceil(remainingEffective / (winner === originalOwner ? defense : winnerEntry.combined)));
    }
    const previous = game.territories[id];
    const captured = winner !== originalOwner;
    game.territories[id] = { ...previous, owner: winner, troops: Math.min(territoryCap(previous), survivors), construction: captured ? null : previous.construction, capitalOf: captured ? null : previous.capitalOf };
    report.push({ type: "battle", text: `${TERRITORY_DEFINITIONS[id].name}发生${participants.length}方战斗，${FACTIONS[winner].name}${winner === originalOwner ? "守住" : "夺取"}领地，剩余 ${survivors} 兵。` });
  }
  ensureCapitals(game, report);
  game.fleets = game.fleets.filter((fleet) => game.players.some((player) => player.factionId === fleet.owner && Object.values(game.territories).some((territory) => territory.owner === fleet.owner)));
  applyGrowth(game, report);
  updateEliminations(game, report);
  if (!report.length) report.push({ type: "info", text: "本回合没有发生战斗。" });
  return { round: game.round, orders, constructions, contested: [...contested], report };
}

function applyGrowth(game, report) {
  const growth = Object.fromEntries(game.players.map((player) => [player.factionId, 0]));
  const encircled = getEncircled(game);
  for (const [id, territory] of Object.entries(game.territories)) {
    if (territory.owner === NEUTRAL) continue;
    if (territory.construction) {
      territory.construction.remaining -= 1;
      if (territory.construction.remaining <= 0) {
        const type = territory.construction.type;
        territory[type] = true;
        territory.construction = null;
        report.push({ type: "strategy", text: `${TERRITORY_DEFINITIONS[id].name}${type === "airport" ? "机场" : "港口"}竣工。` });
      }
      continue;
    }
    if (encircled.has(id)) {
      territory.troops = Math.max(1, territory.troops - 1);
      continue;
    }
    const before = territory.troops;
    territory.troops = Math.min(territoryCap(territory), territory.troops + GROWTH_PER_TERRITORY);
    growth[territory.owner] = (growth[territory.owner] ?? 0) + territory.troops - before;
    if (territory.airport && territory.troops >= MAX_TROOPS && !territory.metropolis) territory.metropolis = true;
  }
  const text = game.players.filter((player) => growth[player.factionId] > 0).map((player) => `${FACTIONS[player.factionId].name} +${growth[player.factionId]}`).join("，");
  report.push({ type: "growth", text: `增长阶段：${text || "没有势力增长"}。` });
}

function updateEliminations(game, report) {
  for (const player of game.players) {
    const alive = Object.values(game.territories).some((territory) => territory.owner === player.factionId);
    if (!alive && !player.eliminated) report.push({ type: "battle", text: `${player.name}（${FACTIONS[player.factionId].name}）已被消灭。` });
    player.eliminated = !alive;
  }
  const living = livingPlayers(game);
  if (living.length === 1) {
    game.phase = "finished";
    game.winnerId = living[0].id;
    game.winnerFactionId = living[0].factionId;
    report.push({ type: "victory", text: `${living[0].name}统一北方大战区。` });
  } else if (living.length === 0) {
    game.phase = "finished";
    report.push({ type: "victory", text: "所有势力同时覆灭，本局平局。" });
  }
}

export function endPlayerTurn(game, playerId) {
  assertTurn(game, playerId);
  game.submittedPlayerIds.push(playerId);
  const waitingForPlayerIds = livingHumanPlayers(game).filter((player) => !game.submittedPlayerIds.includes(player.id)).map((player) => player.id);
  if (waitingForPlayerIds.length) {
    game.logs = [{ type: "info", text: `等待其余 ${waitingForPlayerIds.length} 名玩家提交部署。` }];
    return { resolved: false, waitingForPlayerIds };
  }
  generateNpcPlans(game);
  game.phase = "resolving";
  const resolution = resolveRound(game);
  game.lastResolution = resolution;
  game.logs = resolution.report.slice(-50);
  if (game.phase === "finished") return { resolved: true, gameEnded: true, resolution };
  game.round += 1;
  game.submittedPlayerIds = [];
  game.pendingOrders = Object.fromEntries(game.players.map((player) => [player.id, []]));
  game.pendingConstructions = Object.fromEntries(game.players.map((player) => [player.id, []]));
  game.roundStartTerritories = structuredClone(game.territories);
  game.currentPlayerIndex = null;
  game.currentPlayerId = null;
  game.phase = "planning";
  return { resolved: true, gameEnded: false, resolution, waitingForPlayerIds: livingHumanPlayers(game).map((player) => player.id) };
}

export function passDisconnectedTurn(game, playerId) {
  if (game.phase !== "planning" || game.winnerId || game.submittedPlayerIds.includes(playerId)) return null;
  return endPlayerTurn(game, playerId);
}

export function pauseGame(game, playerId = null, reason = "disconnect") {
  if (!game || game.phase === "finished") return false;
  if (game.phase !== "paused") game.phaseBeforePause = game.phase;
  game.phase = "paused";
  game.pauseReason = game.pauseReason === "manual" ? "manual" : reason;
  if (playerId && !game.pausedPlayerIds.includes(playerId)) game.pausedPlayerIds.push(playerId);
  return true;
}

export function resumeGameIfReady(game, { force = false } = {}) {
  if (!game || game.phase !== "paused") return false;
  const missing = game.players.filter((player) => !player.eliminated && !player.connected).map((player) => player.id);
  game.pausedPlayerIds = missing;
  if (missing.length || (game.pauseReason === "manual" && !force)) return false;
  game.phase = game.phaseBeforePause ?? "planning";
  game.phaseBeforePause = null;
  game.pauseReason = null;
  game.logs = [{ type: "info", text: "全部玩家已连接，战局继续。" }];
  return true;
}

export function publicGameState(game, viewerPlayerId) {
  return {
    roomCode: game.roomCode,
    settings: structuredClone(game.settings ?? { gameMode: "expansion", strategicTerrain: false }),
    phase: game.phase,
    round: game.round,
    currentPlayerIndex: game.currentPlayerIndex,
    currentPlayerId: game.currentPlayerId,
    players: game.players.map((player) => ({ ...player })),
    territories: game.territories,
    fleets: game.fleets,
    pendingOrders: structuredClone(game.pendingOrders[viewerPlayerId] ?? []),
    pendingConstructions: structuredClone(game.pendingConstructions?.[viewerPlayerId] ?? []),
    submittedPlayerIds: [...game.submittedPlayerIds],
    pauseReason: game.pauseReason,
    pausedPlayerIds: [...(game.pausedPlayerIds ?? [])],
    winnerId: game.winnerId,
    winnerFactionId: game.winnerFactionId,
    lastResolution: game.lastResolution,
    logs: game.logs,
  };
}

export function factionStrength(game, factionId) {
  const holdings = TERRITORY_IDS.filter((id) => game.territories[id].owner === factionId);
  const current = holdings.reduce((sum, id) => sum + game.territories[id].troops, 0)
    + game.fleets.filter((fleet) => fleet.owner === factionId).reduce((sum, fleet) => sum + fleet.ships, 0);
  return { holdings: holdings.length, current };
}
