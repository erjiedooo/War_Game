import {
  AIRDROP_ATTRITION_RATE, AIR_RANGE_KM, CAPITAL_DEFENSE_MULTIPLIER, COASTAL_TERRITORIES,
  CONSTRUCTION_TURNS, DESERT_ATTRITION_RATE, EIGHT_FACTION_IDS, EIGHT_TERRITORY_GROUPS,
  ENCIRCLED_DEFENSE_MULTIPLIER, FACTIONS, FACTION_IDS, GAME_MODES, GROWTH_PER_TERRITORY,
  LANDING_ATTRITION_RATE, MAP_SIZE, MAX_AIRPORTS_PER_FACTION, MAX_TROOPS, METROPOLIS_DEFENSE_MULTIPLIER,
  METROPOLIS_MAX_TROOPS, MIN_VIEW_SIZE, MOUNTAIN_ATTRITION_RATE,
  MOUNTAIN_DEFENSE_MULTIPLIER, NEUTRAL, RIVER_ATTRITION_RATE,
} from "./config.js";
import {
  createProjection, distancePointToSegment, geometryToPath, getBounds, haversineKm,
  pointInGeometry, segmentsIntersect, simplifyRoute,
} from "./geometry.js";
import { closeAllDialogs, getGameDom } from "./dom.js";
import { loadMapData } from "./map-data.js";
let TERRITORIES = {};
let TERRITORY_IDS = [];

let RIVER_CROSSINGS = new Set();
let RIVER_SEGMENTS = [];
let MOUNTAIN_FEATURES = [];

let mapView = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };

const dom = getGameDom();

let state = null;
let mapReady = false;
let projectedCenters = {};
let mapProjection = null;
let territoryAdjacency = {};
let activeDrag = null;
let activePan = null;
let RIVER_CROSSING_NAMES = new Map();
let playbackChoiceResolver = null;

function activeFactionIds() {
  return state?.factionIds ?? FACTION_IDS;
}

function partitionTerritories(factionIds) {
  if (factionIds.length === EIGHT_FACTION_IDS.length && factionIds.every((id) => EIGHT_FACTION_IDS.includes(id))) {
    return Object.fromEntries(Object.entries(EIGHT_TERRITORY_GROUPS).flatMap(([owner, ids]) => ids.map((id) => [id, owner])));
  }
  const quotas = Object.fromEntries(factionIds.map((id, index) => [id, Math.floor(TERRITORY_IDS.length / factionIds.length) + (index < TERRITORY_IDS.length % factionIds.length ? 1 : 0)]));
  const assignments = {};
  const counts = Object.fromEntries(factionIds.map((id) => [id, 1]));
  for (const id of factionIds) assignments[FACTIONS[id].start] = id;
  while (Object.keys(assignments).length < TERRITORY_IDS.length) {
    const candidates = [];
    for (const factionId of factionIds) {
      const owned = Object.keys(assignments).filter((id) => assignments[id] === factionId);
      for (const source of owned) for (const target of territoryAdjacency[source] ?? []) if (!assignments[target]) {
        candidates.push({ factionId, target, score: counts[factionId] / quotas[factionId] + haversineKm(TERRITORIES[target].label, TERRITORIES[FACTIONS[factionId].start].label) / 5000 });
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.score - b.score);
    const chosen = candidates[0];
    assignments[chosen.target] = chosen.factionId;
    counts[chosen.factionId] += 1;
  }
  for (const id of TERRITORY_IDS.filter((id) => !assignments[id])) {
    const factionId = [...factionIds].sort((a, b) => haversineKm(TERRITORIES[id].label, TERRITORIES[FACTIONS[a].start].label) - haversineKm(TERRITORIES[id].label, TERRITORIES[FACTIONS[b].start].label))[0];
    assignments[id] = factionId;
    counts[factionId] += 1;
  }
  return assignments;
}

function createState(playerFaction, mode = "ten") {
  const factionIds = GAME_MODES[mode]?.factionIds ?? FACTION_IDS;
  const territories = Object.fromEntries(TERRITORY_IDS.map((id) => [id, {
    owner: NEUTRAL,
    troops: 6,
    airport: false,
    port: false,
    metropolis: false,
    construction: null,
    capitalOf: null,
  }]));
  if (mode === "eight") {
    const assignments = partitionTerritories(factionIds);
    for (const id of TERRITORY_IDS) {
      const owner = assignments[id];
      territories[id] = { ...territories[id], owner, troops: id === FACTIONS[owner].start ? 15 : 8, capitalOf: id === FACTIONS[owner].start ? owner : null };
    }
  } else for (const factionId of factionIds) {
    territories[FACTIONS[factionId].start] = {
      ...territories[FACTIONS[factionId].start],
      owner: factionId,
      troops: 15,
      capitalOf: factionId,
    };
  }
  return {
    round: 1,
    mode,
    factionIds: [...factionIds],
    phase: playerFaction ? "planning" : "selecting",
    playerFaction,
    territories,
    playerOrders: new Map(),
    npcOrders: [],
    fleets: [],
    selectedOrderKey: null,
    selectedTerritoryId: playerFaction ? FACTIONS[playerFaction].start : null,
    orderMode: "land",
    notice: null,
    history: [],
    flashIds: new Set(),
    gameOver: false,
  };
}

async function bootstrap() {
  try {
    const { territories: geojson, rivers: riverGeojson, mountains: mountainGeojson } = await loadMapData();
    configureTerritories(geojson);
    buildOfficialMap(geojson, riverGeojson, mountainGeojson);
    configureMountainInfluence(mountainGeojson);
    state = createState(null, "ten");
    renderFactionOptions();
    mapReady = true;
    dom.mapLoading.classList.add("is-hidden");
    render();
    dom.factionDialog.showModal();
  } catch (error) {
    dom.mapLoading.textContent = "官方地图数据载入失败，请重新启动本地服务。";
    console.error(error);
  }
  registerWebMcpTools();
}

function configureTerritories(geojson) {
  TERRITORIES = Object.fromEntries(geojson.features.map((feature) => {
    const { code, name, province, label } = feature.properties;
    return [code, {
      name,
      shortName: name.replace(/(市|盟|地区)$/, ""),
      codes: [code],
      label,
      mountainRanges: [],
      province,
    }];
  }));
  TERRITORY_IDS = Object.keys(TERRITORIES);
  territoryAdjacency = Object.fromEntries(TERRITORY_IDS.map((id) => [id, []]));
}

function configureMountainInfluence(geojson) {
  MOUNTAIN_FEATURES = geojson.features;
  for (const territory of Object.values(TERRITORIES)) {
    territory.mountainRanges = geojson.features
      .filter((feature) => feature.properties.kind !== "desert" && pointInGeometry(territory.label, feature.geometry))
      .map((feature) => feature.properties.nameZh || feature.properties.name);
  }
}

function renderFactionOptions(mode = state?.mode ?? "ten") {
  const modeDefinition = GAME_MODES[mode];
  if (state) {
    state.mode = mode;
    state.factionIds = [...modeDefinition.factionIds];
  }
  dom.modeOptions?.querySelectorAll("[data-game-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.gameMode === mode));
  if (dom.factionIntro) dom.factionIntro.textContent = `${modeDefinition.description} 选择一名历史人物，其他势力由 NPC 控制。`;
  dom.factionOptions.innerHTML = modeDefinition.factionIds.map((id) => {
    const faction = FACTIONS[id];
    return `<button class="faction-option" type="button" data-faction="${id}" style="--faction-color:${faction.color}">
      <span class="faction-sigil">${faction.short}</span>
      <span><b>${faction.name}</b><small>${faction.description}<br />初始 15 兵 · 每领地每回合 +3</small></span>
    </button>`;
  }).join("");
  dom.factionOptions.querySelectorAll("[data-faction]").forEach((button) => {
    button.addEventListener("click", () => startGame(button.dataset.faction, mode));
  });
}

function startGame(playerFaction, mode = state?.mode ?? "ten") {
  state = createState(playerFaction, mode);
  state.npcOrders = generateNpcOrders(cloneTerritories(), state.round);
  closeAllDialogs();
  render();
}

function showFactionSelection() {
  state = createState(null, state?.mode ?? "ten");
  renderFactionOptions(state.mode);
  closeAllDialogs();
  render();
  dom.factionDialog.showModal();
}

function cloneTerritories() {
  return structuredClone(state.territories);
}

function orderKey(source, target) {
  return `${source}::${target}`;
}

function routeEdgeKey(first, second) {
  return [first, second].sort().join("::");
}

function isRiverCrossing(source, target) {
  return RIVER_CROSSINGS.has(routeEdgeKey(source, target));
}

function riverNamesForRoute(source, target) {
  return RIVER_CROSSING_NAMES.get(routeEdgeKey(source, target)) ?? [];
}

function ordersFromSource(source) {
  return [...state.playerOrders.entries()].filter(([, order]) => order.source === source);
}

function committedTroops(source, excludedKey = null) {
  return ordersFromSource(source).reduce((sum, [key, order]) => sum + (key === excludedKey ? 0 : order.amount), 0);
}

function buildOfficialMap(geojson, riverGeojson, mountainGeojson) {
  const features = new Map(geojson.features.map((feature) => [feature.properties.code, feature]));
  const selectedFeatures = TERRITORY_IDS.flatMap((id) => TERRITORIES[id].codes.map((code) => features.get(code)).filter(Boolean));
  territoryAdjacency = deriveAdjacency(features);
  const bounds = getBounds(selectedFeatures);
  const project = createProjection(bounds);
  mapProjection = project;
  projectedCenters = Object.fromEntries(TERRITORY_IDS.map((id) => [id, project(TERRITORIES[id].label)]));

  dom.territoryLayer.innerHTML = TERRITORY_IDS.map((id) => {
    const definition = TERRITORIES[id];
    const paths = definition.codes.map((code) => geometryToPath(features.get(code)?.geometry, project)).join(" ");
    return `<g class="territory" data-id="${id}" tabindex="0" role="button" aria-label="${definition.name}">
      <path class="territory-shape" d="${paths}" fill-rule="evenodd" />
    </g>`;
  }).join("");
  dom.battlefieldClip.innerHTML = TERRITORY_IDS.map((id) => {
    const definition = TERRITORIES[id];
    const paths = definition.codes.map((code) => geometryToPath(features.get(code)?.geometry, project)).join(" ");
    return `<path d="${paths}" fill-rule="evenodd" />`;
  }).join("");

  dom.labelLayer.innerHTML = TERRITORY_IDS.map((id) => {
    const [x, y] = projectedCenters[id];
    return `<g class="map-label" data-id="${id}" transform="translate(${x} ${y})">
      <g class="marker-scale">
        <text class="territory-label" y="-14">${TERRITORIES[id].shortName}</text>
        <g class="army-node" data-id="${id}" tabindex="0" role="button">
          <circle r="10"></circle><text y="3.5">0</text>
        </g>
        <text class="status-icons" y="18"></text>
      </g>
    </g>`;
  }).join("");
  buildMountainLayer(mountainGeojson, project);
  buildRiverLayer(riverGeojson, project);
  deriveRiverCrossings(riverGeojson);
  dom.map.classList.add("is-large-map");
  setMapView(mapView);
}

function buildMountainLayer(geojson, project) {
  const paths = geojson.features.map((feature) => {
    const path = geometryToPath(feature.geometry, project);
    const name = feature.properties.nameZh || feature.properties.name;
    const kind = feature.properties.kind || "mountain";
    return `<path class="mountain-range terrain-${kind}" d="${path}" fill-rule="evenodd"><title>${name}</title></path>`;
  });
  const labels = geojson.features.map((feature) => {
    const bounds = getBounds([feature]);
    const [x, y] = project([(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2]);
    const name = feature.properties.nameZh || feature.properties.name;
    return `<text class="mountain-label" x="${x}" y="${y}">${name}</text>`;
  });
  dom.mountainLayer.innerHTML = paths.join("") + labels.join("");
}

function buildRiverLayer(geojson, project) {
  const labelNames = new Set(["黄河", "海河", "辽河", "滦河", "淮河"]);
  const labels = [];
  const paths = geojson.features.map((feature) => {
    const lines = feature.geometry.coordinates;
    const path = lines.map((line) => line.map((coordinate, index) => {
      const [x, y] = project(coordinate);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ")).join(" ");
    const name = feature.properties.nameZh || feature.properties.name;
    if (labelNames.has(name) && lines[0]?.length) {
      const point = lines[0][Math.floor(lines[0].length / 2)];
      const [x, y] = project(point);
      labels.push(`<text class="river-label" x="${x}" y="${y}">${name}</text>`);
      labelNames.delete(name);
    }
    const rank = Number(feature.properties.scalerank ?? 9);
    return `<path class="river-path rank-${Math.min(9, Math.max(1, rank))}" d="${path}" />`;
  });
  dom.riverLayer.innerHTML = paths.join("") + labels.join("");
}

function deriveRiverCrossings(geojson) {
  const rivers = geojson.features.flatMap((feature) => feature.geometry.coordinates.flatMap((line) => {
    const name = feature.properties.nameZh || feature.properties.name || "河道";
    return line.slice(1).map((point, index) => ({ a: line[index], b: point, name }));
  }));
  RIVER_SEGMENTS = rivers;
  RIVER_CROSSINGS = new Set();
  RIVER_CROSSING_NAMES = new Map();
  for (const source of TERRITORY_IDS) {
    for (const target of territoryAdjacency[source]) {
      const key = routeEdgeKey(source, target);
      if (RIVER_CROSSINGS.has(key) || source > target) continue;
      const routeA = TERRITORIES[source].label;
      const routeB = TERRITORIES[target].label;
      const names = new Set();
      for (const river of rivers) {
        if (segmentsIntersect(routeA, routeB, river.a, river.b)) names.add(river.name);
      }
      if (names.size > 0) {
        RIVER_CROSSINGS.add(key);
        RIVER_CROSSING_NAMES.set(key, [...names].slice(0, 2));
      }
    }
  }
}

function territoryCap(territory) {
  return territory.metropolis ? METROPOLIS_MAX_TROOPS : MAX_TROOPS;
}

function routeCandidates(source, target) {
  const candidates = [];
  if (territoryAdjacency[source]?.includes(target)) candidates.push([source, target]);
  for (const intermediate of territoryAdjacency[source] ?? []) {
    if (intermediate !== target && state.territories[intermediate].owner === state.territories[source].owner && territoryAdjacency[intermediate]?.includes(target)) candidates.push([source, intermediate, target]);
  }
  return candidates;
}

function strokeDistanceToRoute(stroke, route) {
  const routePoints = route.map((id) => projectedCenters[id]);
  return stroke.reduce((total, point) => total + Math.min(...routePoints.slice(1).map((end, index) => distancePointToSegment(point, routePoints[index], end))), 0);
}

function fitLandRoute(source, target, stroke = []) {
  const candidates = routeCandidates(source, target);
  if (candidates.length === 0) return null;
  if (stroke.length < 2) return candidates.sort((a, b) => a.length - b.length)[0];
  return candidates.sort((a, b) => strokeDistanceToRoute(stroke, a) - strokeDistanceToRoute(stroke, b))[0];
}

function fitDrawnRoute(source, target, stroke = []) {
  if (stroke.length < 2) return [projectedCenters[source], projectedCenters[target]].map((point) => [...point]);
  const fitted = simplifyRoute(stroke, Math.max(2, mapView.width / 190));
  fitted[0] = [...projectedCenters[source]];
  fitted[fitted.length - 1] = [...projectedCenters[target]];
  return fitted.length > 16 ? fitted.filter((_, index) => index === 0 || index === fitted.length - 1 || index % Math.ceil(fitted.length / 14) === 0) : fitted;
}

function lineIntersectsGeometry(start, end, geometry) {
  if (pointInGeometry(start, geometry) || pointInGeometry(end, geometry)) return true;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => polygon.some((ring) => ring.slice(1).some((point, index) => segmentsIntersect(start, end, ring[index], point))));
}

function analyzeOrder(order) {
  if (order.mode === "air") return { rate: AIRDROP_ATTRITION_RATE, rivers: [], mountains: [], label: "空降损耗" };
  if (order.mode === "sea") return { rate: LANDING_ATTRITION_RATE, rivers: [], mountains: [], label: "登陆损耗" };
  if (state.territories[order.target]?.owner === order.owner) return { rate: 0, rivers: [], mountains: [], label: "己方调动" };
  const route = order.routePoints?.length > 1 && mapProjection
    ? order.routePoints.map((point) => mapProjection.inverse(point))
    : (order.path?.length ? order.path : [order.source, order.target]).map((id) => TERRITORIES[id].label);
  const rivers = new Set();
  const mountains = new Set();
  const deserts = new Set();
  const sourcePoint = TERRITORIES[order.source].label;
  const targetPoint = TERRITORIES[order.target].label;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    for (const river of RIVER_SEGMENTS) if (segmentsIntersect(start, end, river.a, river.b)) rivers.add(river.name);
    for (const feature of MOUNTAIN_FEATURES) {
      if (pointInGeometry(sourcePoint, feature.geometry) || pointInGeometry(targetPoint, feature.geometry)) continue;
      if (lineIntersectsGeometry(start, end, feature.geometry)) {
        const collection = feature.properties.kind === "desert" ? deserts : mountains;
        collection.add(feature.properties.nameZh || feature.properties.name);
      }
    }
  }
  const rate = Math.min(.6, (rivers.size ? RIVER_ATTRITION_RATE : 0) + (mountains.size ? MOUNTAIN_ATTRITION_RATE : 0) + (deserts.size ? DESERT_ATTRITION_RATE : 0));
  return { rate, rivers: [...rivers].slice(0, 3), mountains: [...mountains, ...deserts].slice(0, 3), label: "路线地形损耗" };
}

function routeModeLabel(mode) {
  return mode === "air" ? "空降" : mode === "sea" ? "登陆" : "陆路";
}

function routePathPoints(order) {
  return order.routePoints?.length > 1 ? order.routePoints : (order.path?.length ? order.path : [order.source, order.target]).map((id) => projectedCenters[id]);
}

function routeSvgPath(order, inset = 0) {
  const points = routePathPoints(order).map((point) => [...point]);
  if (points.length < 2) return "";
  if (inset > 0) {
    const first = insetLine(points[0][0], points[0][1], points[1][0], points[1][1], inset);
    const lastIndex = points.length - 1;
    const last = insetLine(points[lastIndex - 1][0], points[lastIndex - 1][1], points[lastIndex][0], points[lastIndex][1], inset);
    points[0] = [first.x1, first.y1];
    points[lastIndex] = [last.x2, last.y2];
  }
  return points.map((point, index) => `${index ? "L" : "M"} ${point[0]} ${point[1]}`).join(" ");
}

function reachableTargets(source, mode, territories = state.territories) {
  if (mode === "air") {
    if (!territories[source].airport) return [];
    return TERRITORY_IDS.filter((id) => id !== source && haversineKm(TERRITORIES[source].label, TERRITORIES[id].label) <= AIR_RANGE_KM);
  }
  if (mode === "sea") {
    if (!territories[source].port || !COASTAL_TERRITORIES.has(source)) return [];
    return TERRITORY_IDS.filter((id) => id !== source && COASTAL_TERRITORIES.has(id) && territories[id].owner !== territories[source].owner);
  }
  const targets = new Set(territoryAdjacency[source] ?? []);
  for (const neighbor of territoryAdjacency[source] ?? []) {
    if (territories[neighbor].owner !== territories[source].owner) continue;
    for (const second of territoryAdjacency[neighbor] ?? []) if (second !== source) targets.add(second);
  }
  return [...targets];
}

function getSupplyReachable(factionId, territories) {
  const owned = TERRITORY_IDS.filter((id) => territories[id].owner === factionId);
  const capital = owned.find((id) => territories[id].capitalOf === factionId);
  if (!capital) return new Set();
  const ownedSet = new Set(owned);
  const visited = new Set([capital]);
  const queue = [capital];
  while (queue.length) {
    const current = queue.shift();
    const links = (territoryAdjacency[current] ?? []).filter((id) => ownedSet.has(id));
    if (territories[current].airport) links.push(...owned.filter((id) => id !== current && territories[id].airport && haversineKm(TERRITORIES[current].label, TERRITORIES[id].label) <= AIR_RANGE_KM));
    if (territories[current].port) links.push(...owned.filter((id) => id !== current && COASTAL_TERRITORIES.has(id)));
    else if (COASTAL_TERRITORIES.has(current)) links.push(...owned.filter((id) => territories[id].port));
    for (const next of links) if (!visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

function getEncircledTerritories(territories = state.territories) {
  const encircled = new Set();
  for (const factionId of activeFactionIds()) {
    const supplied = getSupplyReachable(factionId, territories);
    for (const id of TERRITORY_IDS) if (territories[id].owner === factionId && !supplied.has(id)) encircled.add(id);
  }
  return encircled;
}

function getFactionStrength(factionId, territories = state.territories) {
  const encircled = getEncircledTerritories(territories);
  const holdings = TERRITORY_IDS.filter((id) => territories[id].owner === factionId);
  const fleetStrength = (state?.fleets ?? []).filter((fleet) => fleet.owner === factionId).reduce((sum, fleet) => sum + fleet.ships, 0);
  const current = holdings.reduce((sum, id) => sum + territories[id].troops, 0) + fleetStrength;
  const future = holdings.reduce((sum, id) => {
    const territory = territories[id];
    if (territory.construction || encircled.has(id)) return sum + territory.troops;
    return sum + Math.min(territoryCap(territory), territory.troops + GROWTH_PER_TERRITORY);
  }, fleetStrength);
  return { holdings, current, future };
}

function deriveAdjacency(features) {
  const boundaryPoints = {};
  for (const id of TERRITORY_IDS) {
    const points = new Set();
    const visit = (coordinates) => {
      if (typeof coordinates[0] === "number") {
        points.add(`${coordinates[0].toFixed(3)},${coordinates[1].toFixed(3)}`);
        return;
      }
      coordinates.forEach(visit);
    };
    TERRITORIES[id].codes.forEach((code) => {
      const feature = features.get(code);
      if (feature) visit(feature.geometry.coordinates);
    });
    boundaryPoints[id] = points;
  }

  const adjacency = Object.fromEntries(TERRITORY_IDS.map((id) => [id, []]));
  for (let first = 0; first < TERRITORY_IDS.length; first += 1) {
    for (let second = first + 1; second < TERRITORY_IDS.length; second += 1) {
      const a = TERRITORY_IDS[first];
      const b = TERRITORY_IDS[second];
      const [smaller, larger] = boundaryPoints[a].size < boundaryPoints[b].size
        ? [boundaryPoints[a], boundaryPoints[b]]
        : [boundaryPoints[b], boundaryPoints[a]];
      let sharedPoints = 0;
      for (const point of smaller) {
        if (larger.has(point)) sharedPoints += 1;
        if (sharedPoints >= 2) break;
      }
      if (sharedPoints >= 2) {
        adjacency[a].push(b);
        adjacency[b].push(a);
      }
    }
  }
  const corrections = [
    ["110000", "130800"], ["120000", "130200"], ["130200", "130300"], ["130700", "140200"], ["140200", "140600"],
    ["130300", "211400"], ["211400", "210700"], ["210700", "211100"], ["210700", "210900"], ["210700", "211300"],
    ["211300", "150400"], ["210900", "150500"], ["150400", "150500"], ["150400", "152500"], ["150500", "152200"],
    ["152200", "150700"], ["152500", "152200"], ["150900", "152500"], ["140200", "150900"], ["210100", "210300"], ["211100", "210300"],
    ["210100", "211000"], ["210300", "211000"], ["211000", "210800"],
  ];
  for (const [a, b] of corrections) {
    if (!adjacency[a]?.includes(b)) adjacency[a]?.push(b);
    if (!adjacency[b]?.includes(a)) adjacency[b]?.push(a);
  }
  return adjacency;
}

function render() {
  dom.round.textContent = state.playerFaction ? String(state.round).padStart(2, "0") : "--";
  const phaseLabels = { planning: "部署阶段", marching: "行军演示", battle: "交战演示", growth: "增长结算", selecting: "选择势力" };
  dom.phase.textContent = phaseLabels[state.phase] ?? "结算中";
  dom.endTurn.disabled = !state.playerFaction || state.phase !== "planning" || state.gameOver;
  dom.rollback.disabled = !state.playerFaction || state.phase !== "planning" || state.history.length === 0;
  dom.instruction.textContent = state.playerFaction ? `${GAME_MODES[state.mode].name} · 自由划线，箭头与地形判定按实际笔迹拟合` : "选择模式与势力后开始部署";
  dom.syncNote.textContent = state.playerFaction
    ? state.phase === "planning" ? `${activeFactionIds().length - 1} 个 NPC 已根据本回合初始局面锁定命令。` : "正在同步演示本回合全部势力的行动。"
    : "选择势力后开始第一回合。";
  renderScoreboard();
  renderOrderModes();
  renderLegend();
  if (mapReady) updateMap();
  renderSummary();
  renderOrders();
}

function renderScoreboard() {
  const ranking = activeFactionIds().map((id) => ({ id, ...getFactionStrength(id) }))
    .sort((a, b) => b.future - a.future || b.current - a.current || b.holdings.length - a.holdings.length);
  dom.scoreboard.innerHTML = ranking.map((entry, index) => {
    const id = entry.id;
    const faction = FACTIONS[id];
    const isPlayer = id === state.playerFaction;
    return `<article class="faction-card ${isPlayer ? "is-player" : ""} ${entry.holdings.length === 0 ? "is-eliminated" : ""}" style="--faction-color:${faction.color}">
      <span class="rank-number">${index + 1}</span>
      <span class="faction-sigil">${faction.short}</span>
      <div><b>${faction.name}</b><small>${entry.holdings.length === 0 ? "已被消灭" : isPlayer ? "你的势力" : state.playerFaction ? `${faction.style === "steady" ? "稳健" : faction.style === "expander" ? "扩张" : "进攻"}型 NPC` : TERRITORIES[faction.start].shortName}</small></div>
      <strong><span>${entry.current}</span><small>现</small><span>${entry.future}</span><small>下回合</small></strong>
    </article>`;
  }).join("");
}

function renderOrderModes() {
  if (!dom.orderModeSwitch) return;
  dom.orderModeSwitch.querySelectorAll("[data-order-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.orderMode === state.orderMode);
    button.disabled = !state.playerFaction || state.phase !== "planning";
  });
}

function renderLegend() {
  dom.legend.innerHTML = activeFactionIds().map((id) => `<span><i style="--legend-color:${FACTIONS[id].color}"></i>${FACTIONS[id].short}</span>`).join("")
    + `<span><i style="--legend-color:${FACTIONS.neutral.color}"></i>中立</span>`
    + `<span><i class="terrain-key mountain-key"></i>山脉 / 丘陵 / 沙漠</span>`
    + `<span><i class="terrain-key river-key"></i>五大水系</span>`
    + `<span class="map-symbol">◆ 首都</span><span class="map-symbol">★ 特大城市</span><span class="map-symbol">✈ 机场</span><span class="map-symbol">⚓ 港口</span><span class="map-symbol danger">⊘ 包围</span>`;
}

function updateMap() {
  const encircled = getEncircledTerritories();
  document.querySelectorAll(".territory").forEach((node) => {
    const id = node.dataset.id;
    const territory = state.territories[id];
    node.style.setProperty("--owner-color", FACTIONS[territory.owner].color);
    node.classList.toggle("has-order", ordersFromSource(id).length > 0);
    node.classList.toggle("just-fought", state.flashIds.has(id));
    node.classList.toggle("is-selected", state.selectedTerritoryId === id);
    node.classList.toggle("is-encircled", encircled.has(id));
    const mountainText = TERRITORIES[id].mountainRanges.length ? `山脉影响：${TERRITORIES[id].mountainRanges.join("、")}` : "无山脉影响";
    const statusText = [territory.capitalOf ? "首都" : "", territory.metropolis ? "特大城市" : "", territory.airport ? "机场" : "", territory.port ? "港口" : "", encircled.has(id) ? "被包围" : ""].filter(Boolean).join("，");
    node.setAttribute("aria-label", `${TERRITORIES[id].name}，${mountainText}，${FACTIONS[territory.owner].name}，${territory.troops}兵${statusText ? `，${statusText}` : ""}`);
  });
  document.querySelectorAll(".map-label").forEach((label) => {
    const id = label.dataset.id;
    const territory = state.territories[id];
    label.style.setProperty("--owner-color", FACTIONS[territory.owner].color);
    const army = label.querySelector(".army-node");
    army.classList.toggle("is-player", Boolean(state.playerFaction && territory.owner === state.playerFaction));
    army.setAttribute("aria-label", `${TERRITORIES[id].name}兵力${territory.troops}${territory.owner === state.playerFaction ? "，可拖动部署" : ""}`);
    army.querySelector("text").textContent = territory.troops;
    const icons = [territory.capitalOf ? "◆" : "", territory.metropolis ? "★" : "", territory.airport ? "✈" : "", territory.port ? "⚓" : "", territory.construction ? "⌛" : "", encircled.has(id) ? "⊘" : ""].filter(Boolean).join("");
    label.querySelector(".status-icons").textContent = icons;
  });
  renderFleets();
  renderOrderLines();
}

function renderFleets() {
  if (!dom.fleetLayer) return;
  dom.fleetLayer.innerHTML = (state.fleets ?? []).map((fleet) => {
    const start = projectedCenters[fleet.origin] ?? projectedCenters[fleet.target];
    const end = projectedCenters[fleet.target];
    const x = start[0] + (end[0] - start[0]) * .72;
    const y = start[1] + (end[1] - start[1]) * .72;
    return `<g class="fleet-unit" transform="translate(${x} ${y})" style="--fleet-color:${FACTIONS[fleet.owner].color}"><circle r="11"></circle><text class="fleet-icon" y="-1">⚓</text><text class="fleet-count" y="13">${fleet.ships}</text><title>${FACTIONS[fleet.owner].name}舰队 · ${fleet.ships} 舰 · 封锁${TERRITORIES[fleet.target].shortName}</title></g>`;
  }).join("");
}

function renderOrderLines() {
  const color = state.playerFaction ? FACTIONS[state.playerFaction].color : "#e6b85c";
  dom.orderLines.innerHTML = [...state.playerOrders.values()].map((order) => {
    const path = routeSvgPath(order, Math.max(2.5, 24 * mapView.width / MAP_SIZE));
    return `<path class="order-line mode-${order.mode || "land"}" style="--order-color:${color}" d="${path}" />`;
  }).join("");
}

function insetLine(x1, y1, x2, y2, inset) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const safeInset = Math.min(inset, length * .36);
  return { x1: x1 + dx / length * safeInset, y1: y1 + dy / length * safeInset, x2: x2 - dx / length * safeInset, y2: y2 - dy / length * safeInset };
}

function renderSummary() {
  const order = state.selectedOrderKey ? state.playerOrders.get(state.selectedOrderKey) : null;
  const notice = state.notice ? `<p class="command-notice">${state.notice}</p>` : "";
  if (!state.playerFaction) {
    dom.summary.innerHTML = `<span class="eyebrow">部署方式</span><h2>先选择游戏模式与历史人物</h2><p>各势力的增长规则、建设周期与驻军上限完全相同。</p>`;
    return;
  }
  if (state.phase !== "planning") {
    dom.summary.innerHTML = `<span class="eyebrow">同步结算</span><h2>${state.phase === "marching" ? "各路部队正在行军" : state.phase === "battle" ? "各战场正在交战" : "正在进行战后整补"}</h2><p>本回合命令已经锁定，演示结束后将显示完整战报。</p>`;
    return;
  }
  if (!order) {
    const id = state.selectedTerritoryId;
    const selected = id ? state.territories[id] : null;
    if (!selected || selected.owner !== state.playerFaction) {
      dom.summary.innerHTML = `<span class="eyebrow">${routeModeLabel(state.orderMode)}部署</span><h2>选择一座己方城市</h2><p>点击兵力圆标查看城市状态；按住圆标自由划线，下达调动或进攻命令。</p>${notice}`;
      return;
    }
    const encircled = getEncircledTerritories().has(id);
    const status = [selected.capitalOf ? "首都" : "", selected.metropolis ? "特大城市" : "", selected.airport ? "机场" : "", selected.port ? "港口" : "", encircled ? "被包围" : "补给畅通"].filter(Boolean);
    const construction = selected.construction ? `${selected.construction.type === "airport" ? "机场" : "港口"}建设中 · 剩余 ${selected.construction.remaining} 回合` : "";
    const airportCount = TERRITORY_IDS.filter((territoryId) => state.territories[territoryId].owner === state.playerFaction
      && (state.territories[territoryId].airport || state.territories[territoryId].construction?.type === "airport")).length;
    const canBuildAirport = !selected.airport && !selected.construction && airportCount < MAX_AIRPORTS_PER_FACTION;
    const canBuildPort = COASTAL_TERRITORIES.has(id) && !selected.port && !selected.construction;
    dom.summary.innerHTML = `<span class="eyebrow">城市与建设</span><h2>${TERRITORIES[id].name} · ${selected.troops}/${territoryCap(selected)} 兵</h2>
      <div class="territory-meta">${status.map((item) => `<span>${item}</span>`).join("")}</div>
      <p>${construction || `${routeModeLabel(state.orderMode)}模式已启用；每个据点最多两路，合计至少留下 1 名守军。`}</p>
      <div class="build-actions">
        <button type="button" data-build="airport" ${canBuildAirport ? "" : "disabled"}>${selected.airport ? "机场已建成" : airportCount >= MAX_AIRPORTS_PER_FACTION ? `机场已达上限 ${MAX_AIRPORTS_PER_FACTION}` : "修建机场 · 8回合"}</button>
        <button type="button" data-build="port" ${canBuildPort ? "" : "disabled"}>${selected.port ? "港口已建成" : COASTAL_TERRITORIES.has(id) ? "修建港口 · 8回合" : "非沿海城市"}</button>
      </div>${notice}`;
    dom.summary.querySelectorAll("[data-build]").forEach((button) => button.addEventListener("click", () => startConstruction(id, button.dataset.build)));
    return;
  }
  const source = state.territories[order.source];
  const target = state.territories[order.target];
  const maxAmount = Math.max(1, source.troops - 1 - committedTroops(order.source, state.selectedOrderKey));
  order.amount = Math.min(order.amount, maxAmount);
  const analysis = analyzeOrder(order);
  const routeNames = (order.path ?? [order.source, order.target]).map((id) => TERRITORIES[id].shortName).join(" → ");
  const debuff = analysis.rate ? `<span>${analysis.label} ${Math.round(analysis.rate * 100)}%</span>` : `<span>路线无损耗</span>`;
  const terrainNames = [...analysis.rivers, ...analysis.mountains];
  dom.summary.innerHTML = `<span class="eyebrow">调整${routeModeLabel(order.mode)}</span><h2>${routeNames}</h2>
    <div class="territory-meta"><span>${target.owner === state.playerFaction ? "调动" : "进攻"}</span>${debuff}${terrainNames.length ? `<span>${terrainNames.join("、")}</span>` : ""}<span>目标驻军 ${target.troops}</span></div>
    <div class="amount-row"><label for="order-amount">出动兵力</label><output id="amount-output">${order.amount}</output>
      <input id="order-amount" type="range" min="1" max="${maxAmount}" value="${order.amount}" aria-label="出动兵力" /></div>${notice}`;
  const slider = document.querySelector("#order-amount");
  slider.addEventListener("input", () => {
    order.amount = Number(slider.value);
    document.querySelector("#amount-output").textContent = slider.value;
    renderOrders();
    renderOrderLines();
  });
}

function startConstruction(id, type) {
  if (!state.playerFaction || state.phase !== "planning") return;
  const territory = state.territories[id];
  if (!territory || territory.owner !== state.playerFaction || territory.construction) return;
  if (type === "airport" && territory.airport) return;
  if (type === "airport" && TERRITORY_IDS.filter((territoryId) => state.territories[territoryId].owner === state.playerFaction
    && (state.territories[territoryId].airport || state.territories[territoryId].construction?.type === "airport")).length >= MAX_AIRPORTS_PER_FACTION) {
    state.notice = `每个势力最多拥有 ${MAX_AIRPORTS_PER_FACTION} 个机场（含在建）。`;
    render();
    return;
  }
  if (type === "port" && (territory.port || !COASTAL_TERRITORIES.has(id))) return;
  territory.construction = { type, remaining: CONSTRUCTION_TURNS };
  state.notice = `${TERRITORIES[id].shortName}开始修建${type === "airport" ? "机场" : "港口"}；未来 ${CONSTRUCTION_TURNS} 个增长阶段不增加兵力。`;
  render();
}

function renderOrders() {
  const orders = [...state.playerOrders.entries()];
  dom.orderCount.textContent = `${orders.length} 项`;
  if (orders.length === 0) {
    dom.orderList.innerHTML = `<div class="empty-orders">${state.playerFaction ? "拖动兵力标记来部署" : "尚未选择势力"}</div>`;
    return;
  }
  const color = FACTIONS[state.playerFaction].color;
  dom.orderList.innerHTML = orders.map(([key, order]) => {
    const target = state.territories[order.target];
    const type = target.owner === state.playerFaction ? "调动" : "进攻";
    const analysis = analyzeOrder(order);
    const routeNote = analysis.rate ? ` · 损耗 ${Math.round(analysis.rate * 100)}%` : "";
    const routeNames = (order.path ?? [order.source, order.target]).map((id) => TERRITORIES[id].shortName).join(" → ");
    return `<div class="order-item" style="--order-color:${color}" data-order-key="${key}">
      <span class="order-icon">${order.mode === "air" ? "✈" : order.mode === "sea" ? "⚓" : type === "调动" ? "⇄" : "⚔"}</span>
      <div><b>${routeNames}</b><small>${routeModeLabel(order.mode)}${type} · ${order.amount} 兵${routeNote}</small></div>
      <button class="cancel-order" type="button" data-cancel-order="${key}" aria-label="取消命令" ${state.phase !== "planning" ? "disabled" : ""}>×</button>
    </div>`;
  }).join("");
  dom.orderList.querySelectorAll("[data-order-key]").forEach((item) => item.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    state.selectedOrderKey = item.dataset.orderKey;
    state.notice = null;
    renderSummary();
  }));
  dom.orderList.querySelectorAll("[data-cancel-order]").forEach((button) => button.addEventListener("click", () => {
    if (state.phase !== "planning") return;
    state.playerOrders.delete(button.dataset.cancelOrder);
    if (state.selectedOrderKey === button.dataset.cancelOrder) state.selectedOrderKey = null;
    state.notice = null;
    render();
  }));
}

function beginDrag(event) {
  if (!state?.playerFaction || state.phase !== "planning" || state.gameOver) return;
  const army = event.target.closest?.(".army-node.is-player");
  if (!army) return;
  const source = army.dataset.id;
  const point = clientToSvg(event.clientX, event.clientY);
  activeDrag = { source, pointerId: event.pointerId, start: projectedCenters[source], current: point, points: [projectedCenters[source], point], moved: false };
  dom.map.setPointerCapture(event.pointerId);
  if (state.territories[source].troops > 1) reachableTargets(source, state.orderMode).forEach((id) => document.querySelector(`.territory[data-id="${id}"]`)?.classList.add("is-valid-target"));
  drawDragLine();
  event.preventDefault();
}

function moveDrag(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  activeDrag.current = clientToSvg(event.clientX, event.clientY);
  const previous = activeDrag.points[activeDrag.points.length - 1];
  if (Math.hypot(activeDrag.current[0] - previous[0], activeDrag.current[1] - previous[1]) > 3) activeDrag.points.push(activeDrag.current);
  if (Math.hypot(activeDrag.current[0] - activeDrag.start[0], activeDrag.current[1] - activeDrag.start[1]) > 6) activeDrag.moved = true;
  drawDragLine();
}

function finishDrag(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  const source = activeDrag.source;
  const elements = document.elementsFromPoint(event.clientX, event.clientY);
  const targetNode = elements.map((element) => element.closest?.(".territory, .army-node")).find(Boolean);
  const target = targetNode?.dataset.id;
  clearDragHighlights();
  state.selectedTerritoryId = source;
  if (!activeDrag.moved || !target || target === source) {
    state.selectedOrderKey = null;
    state.notice = null;
    render();
  } else {
    const path = state.orderMode === "land" ? fitLandRoute(source, target, activeDrag.points) : [source, target];
    const routePoints = fitDrawnRoute(source, target, activeDrag.points);
    stageOrder(source, target, state.orderMode, path, null, routePoints);
  }
  activeDrag = null;
  dom.dragLayer.innerHTML = "";
}

function stageOrder(source, target, mode = "land", path = null, requestedAmount = null, routePoints = null) {
  if (!reachableTargets(source, mode).includes(target) || (mode === "land" && !path)) {
    state.notice = mode === "land" ? "陆路只能经过一座己方中间城市，且终点必须与路线相连。" : mode === "air" ? `该目标超出 ${AIR_RANGE_KM} 公里空降范围，或起点没有机场。` : "登陆必须从己方港口出发，目标必须是敌方沿海城市。";
    state.selectedOrderKey = null;
    render();
    return false;
  }
  const key = orderKey(source, target);
  const current = state.playerOrders.get(key);
  const existingRoutes = ordersFromSource(source);
  if (!current && existingRoutes.length >= 2) {
    state.notice = "每个据点最多同时派出两路部队，请先取消一条命令。";
    state.selectedOrderKey = existingRoutes[0]?.[0] ?? null;
    render();
    return false;
  }
  const remaining = state.territories[source].troops - 1 - committedTroops(source, key);
  if (remaining < 1) {
    state.notice = "该据点的可用兵力已全部分配，两路合计必须留下 1 名守军。";
    state.selectedOrderKey = existingRoutes[0]?.[0] ?? null;
    render();
    return false;
  }
  const amount = requestedAmount ?? current?.amount ?? Math.max(1, Math.floor(remaining / 2));
  state.playerOrders.set(key, { source, target, amount: Math.min(amount, remaining), owner: state.playerFaction, mode, path: path ?? [source, target], routePoints: routePoints ?? current?.routePoints ?? [projectedCenters[source], projectedCenters[target]] });
  state.selectedOrderKey = key;
  state.selectedTerritoryId = source;
  state.notice = null;
  render();
  return true;
}

function cancelDrag() {
  if (!activeDrag) return;
  clearDragHighlights();
  activeDrag = null;
  dom.dragLayer.innerHTML = "";
}

function clearDragHighlights() {
  document.querySelectorAll(".territory.is-valid-target").forEach((node) => node.classList.remove("is-valid-target"));
}

function drawDragLine() {
  if (!activeDrag) return;
  const points = [...activeDrag.points, activeDrag.current];
  const path = points.map((point, index) => `${index ? "L" : "M"} ${point[0]} ${point[1]}`).join(" ");
  dom.dragLayer.innerHTML = `<path class="drag-line" d="${path}" />`;
}

function clientToSvg(clientX, clientY) {
  const point = dom.map.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const transformed = point.matrixTransform(dom.map.getScreenCTM().inverse());
  return [transformed.x, transformed.y];
}

function setMapView(nextView) {
  const width = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, nextView.width));
  const height = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, nextView.height));
  const x = Math.max(0, Math.min(MAP_SIZE - width, nextView.x));
  const y = Math.max(0, Math.min(MAP_SIZE - height, nextView.y));
  mapView = { x, y, width, height };
  dom.map.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  const viewRatio = width / MAP_SIZE;
  const symbolScale = Math.max(0.14, Math.min(1, viewRatio));
  document.querySelectorAll(".marker-scale").forEach((node) => node.setAttribute("transform", `scale(${symbolScale.toFixed(3)})`));
  document.querySelectorAll(".river-label, .mountain-label").forEach((node) => { node.style.fontSize = `${(7 * symbolScale).toFixed(2)}px`; });
  if (mapReady && state) renderOrderLines();
}

function zoomMap(factor, anchor = [mapView.x + mapView.width / 2, mapView.y + mapView.height / 2]) {
  const nextWidth = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, mapView.width * factor));
  const nextHeight = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, mapView.height * factor));
  const xRatio = (anchor[0] - mapView.x) / mapView.width;
  const yRatio = (anchor[1] - mapView.y) / mapView.height;
  setMapView({
    x: anchor[0] - nextWidth * xRatio,
    y: anchor[1] - nextHeight * yRatio,
    width: nextWidth,
    height: nextHeight,
  });
}

function handleMapWheel(event) {
  event.preventDefault();
  zoomMap(event.deltaY < 0 ? 0.82 : 1.22, clientToSvg(event.clientX, event.clientY));
}

function beginPan(event) {
  if (event.button !== 0 || event.target.closest?.(".army-node")) return;
  activePan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, view: { ...mapView }, moved: false, territoryId: event.target.closest?.(".territory")?.dataset.id ?? null };
  dom.map.classList.add("is-panning");
  dom.map.setPointerCapture(event.pointerId);
}

function movePan(event) {
  if (!activePan || event.pointerId !== activePan.pointerId) return;
  const bounds = dom.map.getBoundingClientRect();
  const dx = (event.clientX - activePan.clientX) * activePan.view.width / bounds.width;
  const dy = (event.clientY - activePan.clientY) * activePan.view.height / bounds.height;
  if (Math.hypot(event.clientX - activePan.clientX, event.clientY - activePan.clientY) > 5) activePan.moved = true;
  setMapView({ ...activePan.view, x: activePan.view.x - dx, y: activePan.view.y - dy });
}

function finishPan(event) {
  if (!activePan || event.pointerId !== activePan.pointerId) return;
  const clickedTerritory = !activePan.moved ? activePan.territoryId : null;
  activePan = null;
  dom.map.classList.remove("is-panning");
  if (clickedTerritory && state?.phase === "planning") {
    state.selectedTerritoryId = clickedTerritory;
    state.selectedOrderKey = null;
    state.notice = state.territories[clickedTerritory].owner === state.playerFaction ? null : `${TERRITORIES[clickedTerritory].name}由${FACTIONS[state.territories[clickedTerritory].owner].name}控制。`;
    render();
  }
}

function hashRoll(...parts) {
  const text = parts.join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function generateNpcOrders(snapshot, round) {
  const orders = [];
  for (const factionId of activeFactionIds().filter((id) => id !== state.playerFaction)) {
    const faction = FACTIONS[factionId];
    const holdings = TERRITORY_IDS.filter((id) => snapshot[id].owner === factionId);
    for (const sourceId of holdings) {
      const source = snapshot[sourceId];
      let remaining = source.troops - 1;
      if (remaining < 3) continue;
      const landOptions = new Map();
      for (const targetId of territoryAdjacency[sourceId]) {
        if (snapshot[targetId].owner !== factionId) landOptions.set(targetId, [sourceId, targetId]);
        if (snapshot[targetId].owner === factionId) {
          for (const second of territoryAdjacency[targetId]) if (second !== sourceId && snapshot[second].owner !== factionId && !landOptions.has(second)) landOptions.set(second, [sourceId, targetId, second]);
        }
      }
      const hostile = [...landOptions.entries()]
        .map(([id, path]) => ({ id, path }))
        .sort((a, b) => targetScore(snapshot[a.id], faction.style, a.id, sourceId) - targetScore(snapshot[b.id], faction.style, b.id, sourceId));
      const roll = hashRoll(round, factionId, sourceId);
      let routes = 0;
      for (let index = 0; index < hostile.length && routes < 2 && remaining >= 3; index += 1) {
        const targetId = hostile[index].id;
        const target = snapshot[targetId];
        const routeRoll = hashRoll(round, factionId, sourceId, targetId);
        const margin = faction.style === "steady" ? 3 : faction.style === "aggressive" ? 0 : 1;
        const neutralDrive = faction.style === "expander" && target.owner === NEUTRAL;
        const shouldAttack = remaining >= target.troops + margin
          || (neutralDrive && remaining >= target.troops)
          || routeRoll > (routes === 0 ? .78 : .9);
        if (routes === 1 && routeRoll < .38) continue;
        if (shouldAttack) {
          const preserveForSecondRoute = routes === 0 && hostile.length > 1 && remaining >= 10;
          const routeCap = preserveForSecondRoute ? Math.max(3, Math.ceil(remaining * .62)) : remaining;
          const amount = Math.max(3, Math.min(routeCap, remaining, target.troops + 2 + Math.floor(routeRoll * 3)));
          orders.push({ source: sourceId, target: targetId, amount, owner: factionId, mode: "land", path: hostile[index].path });
          remaining -= amount;
          routes += 1;
        }
      }
      if (routes > 0) continue;
      const remoteMode = source.airport ? "air" : source.port && COASTAL_TERRITORIES.has(sourceId) ? "sea" : null;
      if (remoteMode && roll > .72) {
        const remoteTargets = TERRITORY_IDS.filter((id) => snapshot[id].owner !== factionId
          && (remoteMode === "air" ? haversineKm(TERRITORIES[sourceId].label, TERRITORIES[id].label) <= AIR_RANGE_KM : COASTAL_TERRITORIES.has(id)))
          .sort((a, b) => targetScore(snapshot[a], faction.style, a, sourceId) - targetScore(snapshot[b], faction.style, b, sourceId));
        const remoteTarget = remoteTargets[0];
        if (remoteTarget) {
          orders.push({ source: sourceId, target: remoteTarget, amount: Math.max(3, Math.min(remaining, snapshot[remoteTarget].troops + 4)), owner: factionId, mode: remoteMode, path: [sourceId, remoteTarget] });
          continue;
        }
      }
      const friendly = territoryAdjacency[sourceId]
        .filter((id) => snapshot[id].owner === factionId && snapshot[id].troops + 3 < source.troops)
        .sort((a, b) => snapshot[a].troops - snapshot[b].troops)[0];
      if (friendly && roll > .35) orders.push({ source: sourceId, target: friendly, amount: Math.max(2, Math.floor(remaining / 3)), owner: factionId, mode: "land", path: [sourceId, friendly] });
    }
  }
  return orders;
}

function targetScore(territory, style, targetId, sourceId) {
  const neutralBonus = territory.owner === NEUTRAL ? (style === "expander" ? -7 : -3) : 0;
  const playerBonus = territory.owner === state.playerFaction && style === "aggressive" ? -2 : 0;
  const mountainPenalty = TERRITORIES[targetId].mountainRanges.length > 0 ? 2 : 0;
  const riverPenalty = isRiverCrossing(sourceId, targetId) ? 1.5 : 0;
  return territory.troops + neutralBonus + playerBonus + mountainPenalty + riverPenalty;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setPlaybackStatus(text) {
  dom.playbackStatus.textContent = text;
  dom.playbackStatus.hidden = !text;
}

async function playMovementAnimation(orders, statusPrefix = "行军中") {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const totalTroops = orders.reduce((sum, order) => sum + order.amount, 0);
  setPlaybackStatus(orders.length > 0 ? `${statusPrefix} · ${orders.length} 路 / ${totalTroops} 名步兵` : "各方原地休整");
  dom.battleAnimationLayer.innerHTML = orders.map((order, routeIndex) => {
    const path = routeSvgPath(order, 25);
    const color = FACTIONS[order.owner].color;
    return Array.from({ length: order.amount }, (_, troopIndex) => {
      const delay = reducedMotion ? 0 : routeIndex * .035 + troopIndex * .026;
      const duration = reducedMotion ? .18 : .9 + (troopIndex % 4) * .045;
      return `<circle class="unit-dot" r="3.4" fill="${color}" style="color:${color}">
        <animateMotion path="${path}" begin="${delay}s" dur="${duration}s" fill="freeze" />
      </circle>`;
    }).join("");
  }).join("");
  await wait(reducedMotion ? 260 : Math.min(1850, 1050 + Math.max(0, ...orders.map((order) => order.amount)) * 28));
}

async function playBattleAnimation(contested, statusPrefix = "交战中") {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (contested.size === 0) {
    setPlaybackStatus("无交战 · 部队调动完成");
    dom.battleAnimationLayer.innerHTML = "";
    await wait(reducedMotion ? 220 : 620);
    return;
  }
  setPlaybackStatus(`${statusPrefix} · ${contested.size} 处战场`);
  dom.battleAnimationLayer.innerHTML = [...contested].map((id, index) => {
    const [x, y] = projectedCenters[id];
    return `<g style="animation-delay:${index * .08}s">
      <circle class="battle-ring" cx="${x}" cy="${y}" r="13" />
      <circle class="battle-ring" cx="${x}" cy="${y}" r="9" style="animation-delay:.16s" />
      <circle class="battle-spark" cx="${x}" cy="${y}" r="4" style="--spark-x:22px;--spark-y:-18px" />
      <circle class="battle-spark" cx="${x}" cy="${y}" r="3" style="--spark-x:-20px;--spark-y:-14px;animation-delay:.08s" />
      <circle class="battle-spark" cx="${x}" cy="${y}" r="3" style="--spark-x:16px;--spark-y:20px;animation-delay:.14s" />
    </g>`;
  }).join("");
  await wait(reducedMotion ? 260 : 820);
}

function groupByProximity(items, pointForItem, maxGroups = 4) {
  const groups = [];
  const sorted = [...items].sort((a, b) => pointForItem(a)[0] - pointForItem(b)[0]);
  const targetGroupSize = Math.max(1, Math.ceil(sorted.length / maxGroups));
  for (const item of sorted) {
    const point = pointForItem(item);
    const candidates = groups.map((group, index) => {
      const center = group.reduce((sum, entry) => {
        const [x, y] = pointForItem(entry);
        return [sum[0] + x, sum[1] + y];
      }, [0, 0]).map((value) => value / group.length);
      return { index, distance: Math.hypot(point[0] - center[0], point[1] - center[1]) };
    }).sort((a, b) => a.distance - b.distance);
    const nearest = candidates[0];
    const nearestIsFull = nearest && groups[nearest.index].length >= targetGroupSize;
    if (groups.length < maxGroups && (!nearest || nearest.distance > 145 || nearestIsFull)) groups.push([item]);
    else groups[nearest?.index ?? 0].push(item);
  }
  return groups;
}

function focusMapOnPoints(points) {
  if (points.length === 0) return;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(MIN_VIEW_SIZE, Math.min(320, Math.max(maxX - minX, maxY - minY) + 90));
  setMapView({ x: (minX + maxX - size) / 2, y: (minY + maxY - size) / 2, width: size, height: size });
}

async function playMovementInBatches(orders) {
  if (orders.length === 0) return playMovementAnimation(orders);
  const groups = groupByProximity(orders, (order) => projectedCenters[order.target]);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    focusMapOnPoints(group.flatMap((order) => routePathPoints(order)));
    await wait(180);
    await playMovementAnimation(group, `第 ${index + 1}/${groups.length} 批行军`);
  }
}

async function playBattlesInBatches(contested) {
  if (contested.size === 0) return playBattleAnimation(contested);
  const groups = groupByProximity([...contested], (id) => projectedCenters[id]);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    focusMapOnPoints(group.map((id) => projectedCenters[id]));
    await wait(160);
    await playBattleAnimation(new Set(group), `第 ${index + 1}/${groups.length} 批交战`);
  }
}

function requestPlaybackMode() {
  return new Promise((resolve) => {
    playbackChoiceResolver = resolve;
    dom.playbackDialog.showModal();
  });
}

async function requestEndTurn() {
  if (!state.playerFaction || state.phase !== "planning" || state.gameOver) return;
  const mode = await requestPlaybackMode();
  if (!mode || mode === "cancel") return;
  await endTurn(mode);
}

async function endTurn(playbackMode = "overview") {
  if (!state.playerFaction || state.phase !== "planning" || state.gameOver) return;
  const viewBeforePlayback = { ...mapView };
  state.history.push({
    round: state.round,
    territories: cloneTerritories(),
    npcOrders: structuredClone(state.npcOrders),
    fleets: structuredClone(state.fleets),
  });
  if (state.history.length > 20) state.history.shift();
  const roundOrders = structuredClone([...state.playerOrders.values(), ...state.npcOrders]);
  state.phase = "marching";
  render();
  if (playbackMode === "batches") await playMovementInBatches(roundOrders);
  else await playMovementAnimation(roundOrders);
  const { report, contested } = resolveBattles(roundOrders);
  state.playerOrders.clear();
  state.selectedOrderKey = null;
  state.phase = "battle";
  state.flashIds = contested;
  render();
  if (playbackMode === "batches") await playBattlesInBatches(contested);
  else await playBattleAnimation(contested);
  state.flashIds.clear();
  dom.battleAnimationLayer.innerHTML = "";
  if (playbackMode === "batches") setMapView(viewBeforePlayback);
  applyGrowth(report);
  state.phase = "growth";
  setPlaybackStatus("战后整补 · 各领地兵力增长");
  render();
  await wait(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 220 : 560);
  setPlaybackStatus("");
  state.round += 1;
  state.phase = "planning";
  state.notice = null;
  const result = getGameResult();
  if (result) state.gameOver = true;
  else {
    maybeStartNpcConstruction(state.round);
    state.npcOrders = generateNpcOrders(cloneTerritories(), state.round);
  }
  render();
  showReport(report, result);
}

function resolveBattles(orders) {
  const forces = {};
  const attackModes = {};
  const departureBudgets = {};
  const report = [];
  const contested = new Set();
  const encircledBeforeBattle = getEncircledTerritories();
  for (const [id, territory] of Object.entries(state.territories)) {
    forces[id] = { [territory.owner]: territory.troops };
    attackModes[id] = {};
    departureBudgets[`${territory.owner}::${id}`] = Math.max(0, territory.troops - 1);
  }
  const movements = [];
  for (const order of orders) {
    const budgetKey = `${order.owner}::${order.source}`;
    const available = departureBudgets[budgetKey] ?? 0;
    const amount = Math.max(0, Math.min(order.amount, available));
    if (amount <= 0) continue;
    departureBudgets[budgetKey] -= amount;
    forces[order.source][order.owner] -= amount;
    const analysis = analyzeOrder(order);
    const attrition = analysis.rate > 0 && amount >= 4 ? Math.max(1, Math.floor(amount * analysis.rate)) : 0;
    const movement = { ...order, mode: order.mode ?? "land", path: order.path ?? [order.source, order.target], troops: amount - attrition, sent: amount, attrition };
    movements.push(movement);
    if (attrition > 0) {
      const geography = [...analysis.rivers, ...analysis.mountains].join("、");
      report.push({ type: "terrain", text: `${FACTIONS[order.owner].name}从${TERRITORIES[order.source].shortName}执行${routeModeLabel(order.mode)}，${geography || analysis.label}造成 ${attrition} 兵损耗，剩余 ${movement.troops} 兵继续前进。` });
    }
  }

  const resolvedEncounters = new Set();
  for (let first = 0; first < movements.length; first += 1) {
    if (resolvedEncounters.has(first) || movements[first].troops <= 0) continue;
    const second = movements.findIndex((other, index) => index > first && !resolvedEncounters.has(index)
      && other.troops > 0 && other.owner !== movements[first].owner
      && other.source === movements[first].target && other.target === movements[first].source);
    if (second < 0) continue;
    const a = movements[first];
    const b = movements[second];
    resolvedEncounters.add(first);
    resolvedEncounters.add(second);
    if (a.troops === b.troops) {
      report.push({ type: "battle", text: `${TERRITORIES[a.source].shortName}与${TERRITORIES[a.target].shortName}之间爆发遭遇战，双方各 ${a.troops} 兵同归于尽；两座出发城市均已扣除出征兵力。` });
      a.troops = 0;
      b.troops = 0;
      continue;
    }
    const winner = a.troops > b.troops ? a : b;
    const loser = winner === a ? b : a;
    const survivor = winner.troops - loser.troops;
    report.push({ type: "battle", text: `${TERRITORIES[a.source].shortName}—${TERRITORIES[a.target].shortName}遭遇战：${FACTIONS[winner.owner].name}获胜，减去战损后 ${survivor} 兵继续执行原任务；败方出征部队覆灭，后方守军也已因出征减少。` });
    winner.troops = survivor;
    loser.troops = 0;
  }

  const fleetGroups = new Map();
  for (const fleet of state.fleets ?? []) {
    const key = fleet.target;
    if (!fleetGroups.has(key)) fleetGroups.set(key, []);
    fleetGroups.get(key).push({ ...fleet });
  }
  for (const movement of movements.filter((item) => item.mode === "sea" && item.troops > 0)) {
    if (!fleetGroups.has(movement.target)) fleetGroups.set(movement.target, []);
    fleetGroups.get(movement.target).push({ id: `fleet-${state.round}-${movement.owner}-${movement.source}-${movement.target}`, owner: movement.owner, origin: movement.source, target: movement.target, ships: movement.troops });
    contested.add(movement.target);
  }
  const survivingFleets = [];
  for (const [target, fleets] of fleetGroups) {
    const totals = Object.entries(fleets.reduce((map, fleet) => ({ ...map, [fleet.owner]: (map[fleet.owner] ?? 0) + fleet.ships }), {}));
    const highest = Math.max(...totals.map(([, ships]) => ships));
    const leaders = totals.filter(([, ships]) => ships === highest);
    if (leaders.length > 1) {
      if (totals.length > 1) report.push({ type: "battle", text: `${TERRITORIES[target].shortName}近海爆发舰队战，优势兵力并列，各方舰队相互抵消。` });
      continue;
    }
    const [owner, ships] = leaders[0];
    const opposition = totals.filter(([candidate]) => candidate !== owner).reduce((sum, [, amount]) => sum + amount, 0);
    const survivors = Math.max(1, ships - opposition);
    const representative = fleets.find((fleet) => fleet.owner === owner);
    survivingFleets.push({ ...representative, owner, target, ships: survivors });
    if (totals.length > 1) report.push({ type: "battle", text: `${TERRITORIES[target].shortName}近海舰队战：${FACTIONS[owner].name}剩余 ${survivors} 舰，继续为登陆战提供海上支援。` });
  }
  state.fleets = survivingFleets;

  for (const movement of movements) {
    if (movement.troops <= 0) continue;
    if (movement.mode === "sea") continue;
    forces[movement.target][movement.owner] = (forces[movement.target][movement.owner] ?? 0) + movement.troops;
    attackModes[movement.target][movement.owner] ??= new Set();
    attackModes[movement.target][movement.owner].add(movement.mode === "air" ? "air" : "land");
    if (state.territories[movement.target].owner !== movement.owner) contested.add(movement.target);
  }
  for (const fleet of state.fleets) {
    attackModes[fleet.target][fleet.owner] ??= new Set();
    attackModes[fleet.target][fleet.owner].add("sea");
  }
  for (const [target, ownerModes] of Object.entries(attackModes)) for (const [owner, modes] of Object.entries(ownerModes)) {
    if (modes.size < 2 || !(forces[target][owner] > 0) || state.territories[target].owner === owner) continue;
    const bonus = modes.size >= 3 ? 45 : 20;
    const branches = [...modes].map((mode) => mode === "land" ? "陆军" : mode === "air" ? "空军" : "海军").join("、");
    report.push({ type: "strategy", text: `${FACTIONS[owner].name}在${TERRITORIES[target].name}形成${branches}协同，进攻有效兵力提高 ${bonus}%；战后驻军只计算陆军与空降兵，舰队继续留在海面。` });
  }

  for (const [id, forceMap] of Object.entries(forces)) {
    const participants = Object.entries(forceMap).filter(([, troops]) => troops > 0);
    const originalOwner = state.territories[id].owner;
    if (participants.length === 1) {
      const [owner, troops] = participants[0];
      const previous = state.territories[id];
      state.territories[id] = { ...previous, owner, troops: Math.min(territoryCap(previous), troops) };
      continue;
    }
    let defenseMultiplier = 1;
    const defenseNotes = [];
    if (TERRITORIES[id].mountainRanges.length > 0) {
      defenseMultiplier *= MOUNTAIN_DEFENSE_MULTIPLIER;
      defenseNotes.push(TERRITORIES[id].mountainRanges.join("、"));
    }
    if (state.territories[id].capitalOf === originalOwner) {
      defenseMultiplier *= CAPITAL_DEFENSE_MULTIPLIER;
      defenseNotes.push("首都");
    }
    if (state.territories[id].metropolis) {
      defenseMultiplier *= METROPOLIS_DEFENSE_MULTIPLIER;
      defenseNotes.push("特大城市");
    }
    if (encircledBeforeBattle.has(id)) {
      defenseMultiplier *= ENCIRCLED_DEFENSE_MULTIPLIER;
      defenseNotes.push("包围减益");
    }
    const effectiveParticipants = participants.map(([owner, troops]) => {
      const modes = attackModes[id][owner] ?? new Set();
      const combinedMultiplier = owner === originalOwner ? 1 : modes.size >= 3 ? 1.45 : modes.size >= 2 ? 1.2 : 1;
      return { owner, troops, modes, combinedMultiplier, effective: owner === originalOwner ? Math.ceil(troops * defenseMultiplier) : Math.ceil(troops * combinedMultiplier) };
    });
    const highest = Math.max(...effectiveParticipants.map((entry) => entry.effective));
    const leaders = effectiveParticipants.filter((entry) => entry.effective === highest);
    let winner;
    let survivors;
    if (leaders.length > 1) {
      winner = leaders.some((entry) => entry.owner === originalOwner) ? originalOwner : NEUTRAL;
      survivors = 1;
      report.push({ type: "battle", text: `${TERRITORIES[id].name}发生${participants.length}方混战，最高有效兵力并列，${winner === originalOwner ? `${FACTIONS[winner].name}以 1 兵守住` : "进攻方相互抵消，领地转为 1 兵中立"}。` });
    } else {
      winner = leaders[0].owner;
      const opposition = effectiveParticipants.filter((entry) => entry.owner !== winner).map((entry) => entry.effective);
      const survivorEffective = Math.max(1, Math.ceil(highest - opposition.reduce((sum, troops) => sum + troops, 0) / opposition.length));
      const winnerEntry = effectiveParticipants.find((entry) => entry.owner === winner);
      survivors = winner === originalOwner && defenseMultiplier !== 1
        ? Math.max(1, Math.ceil(survivorEffective / defenseMultiplier))
        : Math.max(1, Math.ceil(survivorEffective / (winnerEntry?.combinedMultiplier ?? 1)));
      const terrainNote = winner === originalOwner && defenseNotes.length ? `（${defenseNotes.join("、")}修正生效）` : "";
      const combinedNote = winner !== originalOwner && winnerEntry?.modes.size >= 2 ? `（${[...winnerEntry.modes].map((mode) => mode === "land" ? "陆" : mode === "air" ? "空" : "海").join("")}协同 +${Math.round((winnerEntry.combinedMultiplier - 1) * 100)}%；驻军只计陆军与空降兵）` : "";
      report.push({ type: "battle", text: `${TERRITORIES[id].name}发生${participants.length}方战斗，${FACTIONS[winner].name}${winner === originalOwner ? "守住" : "夺取"}领地，剩余 ${survivors} 兵${terrainNote}${combinedNote}。` });
    }
    const previous = state.territories[id];
    const captured = winner !== originalOwner;
    state.territories[id] = {
      ...previous,
      owner: winner,
      troops: Math.min(territoryCap(previous), survivors),
      construction: captured ? null : previous.construction,
      capitalOf: captured ? null : previous.capitalOf,
    };
  }
  ensureCapitals(report);
  state.fleets = state.fleets.filter((fleet) => Object.values(state.territories).some((territory) => territory.owner === fleet.owner));
  if (report.length === 0) report.push({ type: "info", text: "本回合没有发生战斗，各方完成调动或原地休整。" });
  return { report, contested };
}

function ensureCapitals(report = null) {
  for (const [id, territory] of Object.entries(state.territories)) if (territory.capitalOf && territory.owner !== territory.capitalOf) territory.capitalOf = null;
  for (const factionId of activeFactionIds()) {
    const holdings = TERRITORY_IDS.filter((id) => state.territories[id].owner === factionId);
    if (holdings.length === 0 || holdings.some((id) => state.territories[id].capitalOf === factionId)) continue;
    const nextCapital = holdings.sort((a, b) => state.territories[b].troops - state.territories[a].troops)[0];
    state.territories[nextCapital].capitalOf = factionId;
    report?.push({ type: "strategy", text: `${FACTIONS[factionId].name}失去原首都，将首都迁往${TERRITORIES[nextCapital].name}。` });
  }
}

function applyGrowth(report) {
  const growth = Object.fromEntries(activeFactionIds().map((id) => [id, 0]));
  const encircled = getEncircledTerritories();
  let encircledCount = 0;
  for (const [id, territory] of Object.entries(state.territories)) {
    if (territory.owner === NEUTRAL) continue;
    if (territory.construction) {
      territory.construction.remaining -= 1;
      if (territory.construction.remaining <= 0) {
        const completedType = territory.construction.type;
        territory[completedType] = true;
        territory.construction = null;
        report.push({ type: "strategy", text: `${TERRITORIES[id].name}${completedType === "airport" ? "机场" : "港口"}竣工，本回合仍不获得兵力增长。` });
        if (completedType === "airport" && territory.troops >= MAX_TROOPS && !territory.metropolis) {
          territory.metropolis = true;
          report.push({ type: "strategy", text: `${TERRITORIES[id].name}同步升级为特大城市：防御提高，兵力上限提升至 ${METROPOLIS_MAX_TROOPS}。` });
        }
      }
      continue;
    }
    if (encircled.has(id)) {
      const before = territory.troops;
      territory.troops = Math.max(1, territory.troops - 1);
      encircledCount += 1;
      if (before > territory.troops) report.push({ type: "strategy", text: `${TERRITORIES[id].name}补给线被切断，停止增长并损失 1 兵。` });
      continue;
    }
    const before = territory.troops;
    territory.troops = Math.min(territoryCap(territory), territory.troops + GROWTH_PER_TERRITORY);
    growth[territory.owner] += territory.troops - before;
    if (territory.airport && territory.troops >= MAX_TROOPS && !territory.metropolis) {
      territory.metropolis = true;
      report.push({ type: "strategy", text: `${TERRITORIES[id].name}拥有机场并达到 30 兵，升级为特大城市：防御提高，兵力上限提升至 ${METROPOLIS_MAX_TROOPS}。` });
    }
  }
  const growthText = activeFactionIds().filter((id) => growth[id] > 0).map((id) => `${FACTIONS[id].name} +${growth[id]}`).join("，");
  report.push({ type: "growth", text: `增长阶段：${growthText || "没有势力增长"}。普通城市上限 30，特大城市上限 ${METROPOLIS_MAX_TROOPS}${encircledCount ? `；${encircledCount} 座城市处于包围状态` : ""}。` });
}

function maybeStartNpcConstruction(round) {
  for (const factionId of activeFactionIds().filter((id) => id !== state.playerFaction)) {
    const holdings = TERRITORY_IDS.filter((id) => state.territories[id].owner === factionId);
    if (holdings.length < 2 || holdings.some((id) => state.territories[id].construction)) continue;
    const hasAirport = holdings.some((id) => state.territories[id].airport);
    const hasPort = holdings.some((id) => state.territories[id].port);
    let type = null;
    if (!hasAirport && round >= 2) type = "airport";
    else if (!hasPort && round >= 4 && holdings.some((id) => COASTAL_TERRITORIES.has(id))) type = "port";
    if (!type || hashRoll(round, factionId, "construction") < .45) continue;
    const candidates = holdings.filter((id) => type === "airport" ? !state.territories[id].airport : COASTAL_TERRITORIES.has(id) && !state.territories[id].port)
      .sort((a, b) => state.territories[b].troops - state.territories[a].troops);
    if (candidates[0]) state.territories[candidates[0]].construction = { type, remaining: CONSTRUCTION_TURNS };
  }
}

function rollbackTurn() {
  if (!state.playerFaction || state.phase !== "planning" || state.history.length === 0) return false;
  const snapshot = state.history.pop();
  closeAllDialogs();
  state.round = snapshot.round;
  state.territories = structuredClone(snapshot.territories);
  state.npcOrders = structuredClone(snapshot.npcOrders);
  state.fleets = structuredClone(snapshot.fleets ?? []);
  state.phase = "planning";
  state.playerOrders.clear();
  state.selectedOrderKey = null;
  state.selectedTerritoryId = state.territories[FACTIONS[state.playerFaction].start]?.owner === state.playerFaction
    ? FACTIONS[state.playerFaction].start
    : TERRITORY_IDS.find((id) => state.territories[id].owner === state.playerFaction) ?? null;
  state.notice = `已回到第 ${snapshot.round} 回合开始时；NPC 仍使用当时已锁定的命令。`;
  state.flashIds.clear();
  state.gameOver = false;
  render();
  return true;
}

function getGameResult() {
  const hasPlayerLand = Object.values(state.territories).some((item) => item.owner === state.playerFaction);
  if (!hasPlayerLand) return "defeat";
  const livingEnemies = activeFactionIds().filter((id) => id !== state.playerFaction && Object.values(state.territories).some((item) => item.owner === id));
  return livingEnemies.length === 0 ? "victory" : null;
}

function showReport(report, result) {
  dom.reportTitle.textContent = `第 ${state.round - 1} 回合战报`;
  dom.reportList.innerHTML = report.map((entry) => `<div class="report-entry ${entry.type === "battle" ? "is-battle" : entry.type === "growth" ? "is-growth" : entry.type === "terrain" ? "is-terrain" : entry.type === "strategy" ? "is-strategy" : ""}">${entry.text}</div>`).join("");
  dom.reportDialog.showModal();
  if (result) dom.reportDialog.addEventListener("close", () => showResult(result), { once: true });
}

function showResult(result) {
  const victory = result === "victory";
  dom.resultSeal.textContent = victory ? "胜" : "败";
  dom.resultTitle.textContent = victory ? "全境统一" : "势力覆灭";
  dom.resultCopy.textContent = victory ? `你在第 ${state.round - 1} 回合消灭了另外 ${activeFactionIds().length - 1} 个势力。` : `${FACTIONS[state.playerFaction].name}在第 ${state.round - 1} 回合失去全部领地。`;
  dom.resultDialog.showModal();
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(console.warn); } catch (error) { console.warn(error); }
  };
  register({
    name: "read_battlefield_state", title: "读取当前战局", description: "读取玩家势力、实力排名、补给状态、城市设施和部署命令。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() { const encircled = getEncircledTerritories(); return { mode: state.mode, playerFaction: state.playerFaction, round: state.round, phase: state.phase, historyDepth: state.history.length, ranking: activeFactionIds().map((id) => ({ faction: id, ...getFactionStrength(id) })).sort((a, b) => b.future - a.future || b.current - a.current), territories: Object.fromEntries(Object.entries(state.territories).map(([id, item]) => [id, { name: TERRITORIES[id].name, mountainRanges: TERRITORIES[id].mountainRanges, coastal: COASTAL_TERRITORIES.has(id), encircled: encircled.has(id), ...item }])), fleets: state.fleets, playerOrders: [...state.playerOrders.values()] }; },
  });
  register({
    name: "stage_territory_order", title: "部署领地命令", description: "部署最多跨一座己方城市的陆路、700公里空降或沿海登陆命令。",
    inputSchema: { type: "object", properties: { source: { type: "string", enum: TERRITORY_IDS }, target: { type: "string", enum: TERRITORY_IDS }, amount: { type: "integer", minimum: 1, maximum: 44 }, mode: { type: "string", enum: ["land", "air", "sea"] } }, required: ["source", "target", "amount"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!state.playerFaction || state.phase !== "planning" || state.gameOver) throw new Error("当前不能部署。");
      const { source, target, amount, mode = "land" } = input ?? {};
      if (!TERRITORY_IDS.includes(source) || !TERRITORY_IDS.includes(target)) throw new Error("领地不存在。");
      if (state.territories[source].owner !== state.playerFaction) throw new Error("起点不是玩家领地。");
      const key = orderKey(source, target);
      const maxAmount = state.territories[source].troops - 1 - committedTroops(source, key);
      if (!Number.isInteger(amount) || amount < 1 || amount > maxAmount) throw new Error(`兵力数量无效；该路线当前最多可派 ${maxAmount} 兵。`);
      const path = mode === "land" ? fitLandRoute(source, target) : [source, target];
      if (!stageOrder(source, target, mode, path, amount)) throw new Error(state.notice || "路线无效。");
      return { staged: true, source, target, amount, mode, path };
    },
  });
  register({
    name: "start_city_construction", title: "开始城市建设", description: "让己方城市牺牲8个回合增长，修建机场或港口。",
    inputSchema: { type: "object", properties: { territory: { type: "string", enum: TERRITORY_IDS }, type: { type: "string", enum: ["airport", "port"] } }, required: ["territory", "type"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const { territory, type } = input ?? {};
      const item = state.territories[territory];
      if (!item || item.owner !== state.playerFaction || item.construction || (type === "airport" && item.airport) || (type === "port" && (item.port || !COASTAL_TERRITORIES.has(territory)))) throw new Error("该城市当前不能进行这项建设。");
      startConstruction(territory, type);
      return { started: true, territory, type, remaining: CONSTRUCTION_TURNS };
    },
  });
  register({
    name: "complete_planning_turn", title: "结束部署并结算", description: "结束玩家部署，同时结算当前模式中玩家与全部 NPC 的同步命令。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute() { if (!state.playerFaction || state.phase !== "planning" || state.gameOver) throw new Error("当前无法结算。"); const resolvedRound = state.round; await endTurn(); return { resolvedRound, nextRound: state.round, gameOver: state.gameOver }; },
  });
  register({
    name: "rollback_last_turn", title: "回到上一回合", description: "恢复上一回合开始时的领地、兵力和 NPC 已锁定命令。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute() { if (!rollbackTurn()) throw new Error("当前没有可回档的回合。"); return { rolledBack: true, round: state.round, historyDepth: state.history.length }; },
  });
}

dom.map.addEventListener("pointerdown", beginDrag);
dom.map.addEventListener("pointerdown", beginPan);
dom.map.addEventListener("pointermove", moveDrag);
dom.map.addEventListener("pointermove", movePan);
dom.map.addEventListener("pointerup", finishDrag);
dom.map.addEventListener("pointerup", finishPan);
dom.map.addEventListener("pointercancel", cancelDrag);
dom.map.addEventListener("pointercancel", finishPan);
dom.map.addEventListener("wheel", handleMapWheel, { passive: false });
dom.zoomIn.addEventListener("click", () => zoomMap(0.72));
dom.zoomOut.addEventListener("click", () => zoomMap(1.38));
dom.zoomReset.addEventListener("click", () => setMapView({ x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE }));
dom.orderModeSwitch?.querySelectorAll("[data-order-mode]").forEach((button) => button.addEventListener("click", () => {
  if (!state?.playerFaction || state.phase !== "planning") return;
  state.orderMode = button.dataset.orderMode;
  state.selectedOrderKey = null;
  state.notice = null;
  render();
}));
dom.endTurn.addEventListener("click", () => { void requestEndTurn(); });
dom.rollback.addEventListener("click", rollbackTurn);
dom.rulesButton.addEventListener("click", () => dom.rulesDialog.showModal());
dom.resultRollback.addEventListener("click", rollbackTurn);
dom.restart.addEventListener("click", showFactionSelection);
dom.modeOptions?.querySelectorAll("[data-game-mode]").forEach((button) => button.addEventListener("click", () => renderFactionOptions(button.dataset.gameMode)));
dom.factionDialog.addEventListener("cancel", (event) => event.preventDefault());
dom.playbackDialog.querySelectorAll("[data-playback-mode]").forEach((button) => button.addEventListener("click", () => {
  const resolve = playbackChoiceResolver;
  playbackChoiceResolver = null;
  dom.playbackDialog.close();
  resolve?.(button.dataset.playbackMode);
}));
dom.playbackDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  const resolve = playbackChoiceResolver;
  playbackChoiceResolver = null;
  dom.playbackDialog.close();
  resolve?.(null);
});
dom.playbackDialog.addEventListener("close", () => {
  if (!playbackChoiceResolver) return;
  const resolve = playbackChoiceResolver;
  playbackChoiceResolver = null;
  resolve(null);
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog:not(#faction-dialog):not(#result-dialog)").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));

export function startSinglePlayerApp() {
  return bootstrap();
}
