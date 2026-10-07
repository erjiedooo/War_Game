import {
  AIR_RANGE_KM, COASTAL_TERRITORIES, FACTIONS, MAP_SIZE, MILITARY_STRONGHOLDS,
  MIN_VIEW_SIZE, mountainBarrierForEdge, STRATEGIC_MOUNTAIN_LINES,
} from "./config.js";
import {
  createProjection, distancePointToSegment, geometryToPath, getBounds, haversineKm, simplifyRoute,
} from "./geometry.js";
import { loadMapData } from "./map-data.js";

export async function createMultiplayerMap({ dom, getContext, onDrawOrder, onSelectTerritory }) {
  const { territories: geojson, rivers, mountains } = await loadMapData();
  const definitions = Object.fromEntries(geojson.features.map((feature) => [feature.properties.code, {
    id: feature.properties.code,
    name: feature.properties.name,
    shortName: feature.properties.name.replace(/(市|盟|地区)$/, ""),
    label: feature.properties.label,
  }]));
  const ids = Object.keys(definitions);
  const features = new Map(geojson.features.map((feature) => [feature.properties.code, feature]));
  const adjacency = deriveAdjacency(ids, features);
  const projection = createProjection(getBounds(geojson.features));
  const centers = Object.fromEntries(ids.map((id) => [id, projection(definitions[id].label)]));
  let view = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };
  let drag = null;
  let pan = null;
  let selectedId = null;

  dom.territoryLayer.innerHTML = ids.map((id) => `<g class="territory" data-id="${id}" tabindex="0" role="button" aria-label="${definitions[id].name}">
    <path class="territory-shape" d="${geometryToPath(features.get(id).geometry, projection)}" fill-rule="evenodd" />
  </g>`).join("");
  dom.battlefieldClip.innerHTML = ids.map((id) => `<path d="${geometryToPath(features.get(id).geometry, projection)}" fill-rule="evenodd" />`).join("");
  dom.labelLayer.innerHTML = ids.map((id) => {
    const [x, y] = centers[id];
    return `<g class="map-label" data-id="${id}" transform="translate(${x} ${y})"><g class="marker-scale">
      <text class="territory-label" y="-14">${definitions[id].shortName}</text>
      <g class="army-node" data-id="${id}" tabindex="0" role="button"><circle r="10"></circle><text y="3.5">0</text></g>
      <text class="status-icons" y="18"></text>
    </g></g>`;
  }).join("");
  dom.mountainLayer.innerHTML = mountains.features.map((feature) => `<path class="mountain-range terrain-${feature.properties.kind || "mountain"}" d="${geometryToPath(feature.geometry, projection)}" fill-rule="evenodd"><title>${feature.properties.nameZh || feature.properties.name}</title></path>`).join("")
    + mountains.features.map((feature) => {
      const bounds = getBounds([feature]);
      const [x, y] = projection([(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2]);
      return `<text class="mountain-label ${feature.properties.kind === "desert" ? "terrain-desert-label" : ""}" x="${x}" y="${y}">${feature.properties.nameZh || feature.properties.name}</text>`;
    }).join("")
    + STRATEGIC_MOUNTAIN_LINES.map((barrier) => {
      const points = barrier.points.map(projection);
      const path = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");
      const [x, y] = points[Math.floor(points.length / 2)];
      return `<path class="mountain-barrier" d="${path}"><title>${barrier.name} · 陆军不可直接跨越</title></path><text class="mountain-barrier-label" x="${x}" y="${y}">${barrier.name}</text>`;
    }).join("");
  const riverLabels = new Set(["黄河", "海河", "辽河", "滦河", "淮河"]);
  const riverPaths = [];
  const labels = [];
  for (const feature of rivers.features) {
    const name = feature.properties.nameZh || feature.properties.name;
    const path = feature.geometry.coordinates.map((line) => line.map((coordinate, index) => {
      const [x, y] = projection(coordinate);
      return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ")).join(" ");
    riverPaths.push(`<path class="river-path rank-${Math.min(9, Math.max(1, Number(feature.properties.scalerank ?? 9)))}" d="${path}" />`);
    if (riverLabels.has(name) && feature.geometry.coordinates[0]?.length) {
      const line = feature.geometry.coordinates[0];
      const [x, y] = projection(line[Math.floor(line.length / 2)]);
      labels.push(`<text class="river-label" x="${x}" y="${y}">${name}</text>`);
      riverLabels.delete(name);
    }
  }
  dom.riverLayer.innerHTML = riverPaths.join("") + labels.join("");
  dom.map.classList.add("is-large-map");
  dom.mapLoading.classList.add("is-hidden");
  setView(view);

  function setView(next) {
    const width = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, next.width));
    const height = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, next.height));
    view = {
      x: Math.max(0, Math.min(MAP_SIZE - width, next.x)),
      y: Math.max(0, Math.min(MAP_SIZE - height, next.y)),
      width,
      height,
    };
    dom.map.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    const symbolScale = Math.max(0.14, Math.min(1, width / MAP_SIZE));
    document.querySelectorAll(".marker-scale").forEach((node) => node.setAttribute("transform", `scale(${symbolScale.toFixed(3)})`));
    document.querySelectorAll(".river-label, .mountain-label, .mountain-barrier-label").forEach((node) => { node.style.fontSize = `${(7 * symbolScale).toFixed(2)}px`; });
    renderOrders(getContext().gameState?.pendingOrders ?? []);
  }

  function zoom(factor, anchor = [view.x + view.width / 2, view.y + view.height / 2]) {
    const width = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, view.width * factor));
    const height = Math.max(MIN_VIEW_SIZE, Math.min(MAP_SIZE, view.height * factor));
    const xRatio = (anchor[0] - view.x) / view.width;
    const yRatio = (anchor[1] - view.y) / view.height;
    setView({ x: anchor[0] - width * xRatio, y: anchor[1] - height * yRatio, width, height });
  }

  function clientToSvg(clientX, clientY) {
    const point = dom.map.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(dom.map.getScreenCTM().inverse());
    return [transformed.x, transformed.y];
  }

  function canActFrom(id) {
    const { gameState, roomState } = getContext();
    const viewer = gameState?.players.find((player) => player.id === roomState?.viewerPlayerId);
    return Boolean(viewer && !viewer.isNpc && gameState.phase === "planning" && !gameState.submittedPlayerIds.includes(viewer.id) && gameState.territories[id]?.owner === viewer.factionId);
  }

  function beginDrag(event) {
    const army = event.target.closest?.(".army-node");
    if (!army || !canActFrom(army.dataset.id)) return;
    const source = army.dataset.id;
    const point = clientToSvg(event.clientX, event.clientY);
    drag = { source, pointerId: event.pointerId, start: centers[source], current: point, points: [centers[source], point], moved: false };
    dom.map.setPointerCapture(event.pointerId);
    const validTargets = new Set(reachableTargets(source));
    dom.territoryLayer.querySelectorAll(".territory").forEach((node) => node.classList.toggle("is-valid-target", validTargets.has(node.dataset.id)));
    drawDrag();
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.current = clientToSvg(event.clientX, event.clientY);
    const previous = drag.points.at(-1);
    if (Math.hypot(drag.current[0] - previous[0], drag.current[1] - previous[1]) > 3) drag.points.push(drag.current);
    if (Math.hypot(drag.current[0] - drag.start[0], drag.current[1] - drag.start[1]) > 6) drag.moved = true;
    drawDrag();
  }

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const currentDrag = drag;
    drag = null;
    dom.dragLayer.innerHTML = "";
    dom.territoryLayer.querySelectorAll(".territory.is-valid-target").forEach((node) => node.classList.remove("is-valid-target"));
    const target = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest?.(".territory, .army-node")).find(Boolean)?.dataset.id;
    selectedId = currentDrag.source;
    onSelectTerritory(currentDrag.source);
    if (!currentDrag.moved || !target || target === currentDrag.source) return;
    const { gameState, orderMode } = getContext();
    const routePoints = fitDrawnRoute(currentDrag.source, target, currentDrag.points);
    const path = orderMode === "land" ? fitLandRoute(currentDrag.source, target, currentDrag.points, gameState) : [currentDrag.source, target];
    const orderId = `${currentDrag.source}:${target}:${orderMode}`;
    const committed = gameState.pendingOrders.filter((order) => order.source === currentDrag.source && order.id !== orderId).reduce((sum, order) => sum + order.amount, 0);
    const available = gameState.territories[currentDrag.source].troops - 1 - committed;
    if (available < 1) return;
    onDrawOrder({
      source: currentDrag.source,
      target,
      mode: orderMode,
      amount: Math.max(1, Math.floor(available / 2)),
      path,
      routeGeo: routePoints.map((point) => projection.inverse(point)),
    });
  }

  function reachableTargets(source) {
    const { gameState, orderMode } = getContext();
    if (!gameState?.territories[source]) return [];
    const sourceTerritory = gameState.territories[source];
    if (orderMode === "air") {
      if (!sourceTerritory.airport) return [];
      return ids.filter((id) => id !== source && haversineKm(definitions[source].label, definitions[id].label) <= AIR_RANGE_KM);
    }
    if (orderMode === "sea") {
      if (!sourceTerritory.port || !COASTAL_TERRITORIES.has(source)) return [];
      return ids.filter((id) => id !== source && COASTAL_TERRITORIES.has(id) && gameState.territories[id].owner !== sourceTerritory.owner);
    }
    const passable = (a, b) => !gameState.settings?.strategicTerrain || !mountainBarrierForEdge(a, b);
    const targets = new Set((adjacency[source] ?? []).filter((target) => passable(source, target)));
    for (const middle of adjacency[source] ?? []) {
      if (gameState.territories[middle]?.owner !== sourceTerritory.owner || !passable(source, middle)) continue;
      for (const target of adjacency[middle] ?? []) if (target !== source && passable(middle, target)) targets.add(target);
    }
    return [...targets];
  }

  function drawDrag() {
    if (!drag) return;
    const points = [...drag.points, drag.current];
    dom.dragLayer.innerHTML = `<path class="drag-line" d="${points.map((point, index) => `${index ? "L" : "M"} ${point[0]} ${point[1]}`).join(" ")}" />`;
  }

  function beginPan(event) {
    if (event.button !== 0 || event.target.closest?.(".army-node")) return;
    pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, view: { ...view }, moved: false, territoryId: event.target.closest?.(".territory")?.dataset.id ?? null };
    dom.map.classList.add("is-panning");
    dom.map.setPointerCapture(event.pointerId);
  }

  function movePan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const bounds = dom.map.getBoundingClientRect();
    const dx = (event.clientX - pan.clientX) * pan.view.width / bounds.width;
    const dy = (event.clientY - pan.clientY) * pan.view.height / bounds.height;
    if (Math.hypot(event.clientX - pan.clientX, event.clientY - pan.clientY) > 5) pan.moved = true;
    setView({ ...pan.view, x: pan.view.x - dx, y: pan.view.y - dy });
  }

  function finishPan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const clicked = !pan.moved ? pan.territoryId : null;
    pan = null;
    dom.map.classList.remove("is-panning");
    if (clicked) {
      selectedId = clicked;
      onSelectTerritory(clicked);
    }
  }

  function fitLandRoute(source, target, stroke, gameState) {
    const candidates = [];
    const passable = (a, b) => !gameState.settings?.strategicTerrain || !mountainBarrierForEdge(a, b);
    if (adjacency[source]?.includes(target) && passable(source, target)) candidates.push([source, target]);
    for (const middle of adjacency[source] ?? []) {
      if (gameState.territories[middle]?.owner === gameState.territories[source]?.owner && adjacency[middle]?.includes(target) && passable(source, middle) && passable(middle, target)) candidates.push([source, middle, target]);
    }
    if (!candidates.length) return [source, target];
    return candidates.sort((a, b) => strokeDistance(stroke, a) - strokeDistance(stroke, b))[0];
  }

  function strokeDistance(stroke, route) {
    const points = route.map((id) => centers[id]);
    return stroke.reduce((total, point) => total + Math.min(...points.slice(1).map((end, index) => distancePointToSegment(point, points[index], end))), 0);
  }

  function fitDrawnRoute(source, target, stroke) {
    const points = simplifyRoute(stroke, Math.max(2, view.width / 190));
    points[0] = [...centers[source]];
    points[points.length - 1] = [...centers[target]];
    return points.length > 16 ? points.filter((_, index) => index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 14) === 0) : points;
  }

  function orderSvgPath(order, inset = 0) {
    const points = (order.routeGeo?.length > 1 ? order.routeGeo.map(projection) : order.path.map((id) => centers[id])).map((point) => [...point]);
    if (points.length < 2) return "";
    if (inset) {
      insetPair(points, 0, 1, inset, true);
      insetPair(points, points.length - 2, points.length - 1, inset, false);
    }
    return points.map((point, index) => `${index ? "L" : "M"} ${point[0]} ${point[1]}`).join(" ");
  }

  function insetPair(points, first, second, inset, changeFirst) {
    const dx = points[second][0] - points[first][0];
    const dy = points[second][1] - points[first][1];
    const length = Math.hypot(dx, dy) || 1;
    const safe = Math.min(inset, length * 0.36);
    const index = changeFirst ? first : second;
    const direction = changeFirst ? 1 : -1;
    points[index] = [points[index][0] + direction * dx / length * safe, points[index][1] + direction * dy / length * safe];
  }

  function renderOrders(orders) {
    const viewer = getContext().gameState?.players.find((player) => player.id === getContext().roomState?.viewerPlayerId);
    const color = viewer ? FACTIONS[viewer.factionId].color : "#e6b85c";
    dom.orderLines.innerHTML = orders.map((order) => `<path class="order-line mode-${order.mode}" style="--order-color:${color}" d="${orderSvgPath(order, Math.max(2.5, 24 * view.width / MAP_SIZE))}" />`).join("");
  }

  function render(gameState, roomState) {
    const viewer = gameState.players.find((player) => player.id === roomState.viewerPlayerId);
    const strategicTerrain = Boolean(gameState.settings?.strategicTerrain);
    dom.map.classList.toggle("strategic-terrain-enabled", strategicTerrain);
    document.querySelectorAll(".territory").forEach((node) => {
      const id = node.dataset.id;
      const territory = gameState.territories[id];
      node.style.setProperty("--owner-color", FACTIONS[territory.owner]?.color ?? FACTIONS.neutral.color);
      node.classList.toggle("is-selected", id === selectedId);
      node.setAttribute("aria-label", `${definitions[id].name}${strategicTerrain && MILITARY_STRONGHOLDS[id] ? `，军事重镇，${MILITARY_STRONGHOLDS[id].role}` : ""}，${FACTIONS[territory.owner]?.name ?? "中立"}，${territory.troops}兵`);
    });
    document.querySelectorAll(".map-label").forEach((node) => {
      const id = node.dataset.id;
      const territory = gameState.territories[id];
      node.style.setProperty("--owner-color", FACTIONS[territory.owner]?.color ?? FACTIONS.neutral.color);
      node.classList.toggle("is-stronghold", strategicTerrain && Boolean(MILITARY_STRONGHOLDS[id]));
      const army = node.querySelector(".army-node");
      army.classList.toggle("is-player", territory.owner === viewer?.factionId);
      army.querySelector("text").textContent = territory.troops;
      army.setAttribute("aria-label", `${definitions[id].name}兵力${territory.troops}`);
      node.querySelector(".status-icons").textContent = [strategicTerrain && MILITARY_STRONGHOLDS[id] ? "♜" : "", territory.capitalOf ? "◆" : "", territory.metropolis ? "★" : "", territory.airport ? "✈" : "", territory.port ? "⚓" : "", territory.construction ? "⌛" : ""].filter(Boolean).join("");
    });
    dom.fleetLayer.innerHTML = gameState.fleets.map((fleet) => {
      const start = centers[fleet.origin] ?? centers[fleet.target];
      const end = centers[fleet.target];
      const x = start[0] + (end[0] - start[0]) * 0.72;
      const y = start[1] + (end[1] - start[1]) * 0.72;
      return `<g class="fleet-unit" transform="translate(${x} ${y})" style="--fleet-color:${FACTIONS[fleet.owner].color}"><circle r="11"></circle><text class="fleet-icon" y="-1">⚓</text><text class="fleet-count" y="13">${fleet.ships}</text></g>`;
    }).join("");
    renderOrders(gameState.pendingOrders);
  }

  async function playResolution(resolution) {
    if (!resolution?.orders) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dom.playbackStatus.hidden = false;
    dom.playbackStatus.textContent = `第 ${resolution.round} 回合 · ${resolution.orders.length} 路部队同步行动`;
    dom.battleAnimationLayer.innerHTML = resolution.orders.map((order, routeIndex) => Array.from({ length: order.amount }, (_, troopIndex) => {
      const path = orderSvgPath(order, 25);
      const color = FACTIONS[order.owner].color;
      return `<circle class="unit-dot" r="3.4" fill="${color}" style="color:${color}"><animateMotion path="${path}" begin="${reducedMotion ? 0 : routeIndex * 0.035 + troopIndex * 0.026}s" dur="${reducedMotion ? 0.18 : 0.9 + (troopIndex % 4) * 0.045}s" fill="freeze" /></circle>`;
    }).join("")).join("");
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 250 : 1400));
    dom.battleAnimationLayer.innerHTML = resolution.contested.map((id, index) => {
      const [x, y] = centers[id];
      return `<g style="animation-delay:${index * 0.08}s"><circle class="battle-ring" cx="${x}" cy="${y}" r="13" /><circle class="battle-spark" cx="${x}" cy="${y}" r="4" style="--spark-x:22px;--spark-y:-18px" /></g>`;
    }).join("");
    dom.playbackStatus.textContent = `${resolution.contested.length} 处战场结算完成`;
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 250 : 820));
    dom.battleAnimationLayer.innerHTML = "";
    dom.playbackStatus.hidden = true;
  }

  dom.map.addEventListener("pointerdown", beginDrag);
  dom.map.addEventListener("pointerdown", beginPan);
  dom.map.addEventListener("pointermove", moveDrag);
  dom.map.addEventListener("pointermove", movePan);
  dom.map.addEventListener("pointerup", finishDrag);
  dom.map.addEventListener("pointerup", finishPan);
  dom.map.addEventListener("pointercancel", () => { drag = null; pan = null; dom.dragLayer.innerHTML = ""; });
  dom.map.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 0.82 : 1.22, clientToSvg(event.clientX, event.clientY)); }, { passive: false });
  dom.zoomIn.addEventListener("click", () => zoom(0.72));
  dom.zoomOut.addEventListener("click", () => zoom(1.38));
  dom.zoomReset.addEventListener("click", () => setView({ x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE }));

  return { definitions, ids, adjacency, render, playResolution, setSelected(id) { selectedId = id; }, getSelected() { return selectedId; } };
}

function deriveAdjacency(ids, features) {
  const boundaryPoints = {};
  for (const id of ids) {
    const points = new Set();
    const visit = (coordinates) => {
      if (typeof coordinates[0] === "number") {
        points.add(`${coordinates[0].toFixed(3)},${coordinates[1].toFixed(3)}`);
        return;
      }
      coordinates.forEach(visit);
    };
    visit(features.get(id).geometry.coordinates);
    boundaryPoints[id] = points;
  }
  const adjacency = Object.fromEntries(ids.map((id) => [id, []]));
  for (let first = 0; first < ids.length; first += 1) for (let second = first + 1; second < ids.length; second += 1) {
    const a = ids[first];
    const b = ids[second];
    const [smaller, larger] = boundaryPoints[a].size < boundaryPoints[b].size ? [boundaryPoints[a], boundaryPoints[b]] : [boundaryPoints[b], boundaryPoints[a]];
    let shared = 0;
    for (const point of smaller) {
      if (larger.has(point)) shared += 1;
      if (shared >= 2) break;
    }
    if (shared >= 2) { adjacency[a].push(b); adjacency[b].push(a); }
  }
  const corrections = [
    ["110000", "130800"], ["120000", "130200"], ["130200", "130300"], ["130700", "140200"], ["140200", "140600"],
    ["130300", "211400"], ["211400", "210700"], ["210700", "211100"], ["210700", "210900"], ["210700", "211300"],
    ["211300", "150400"], ["210900", "150500"], ["150400", "150500"], ["150400", "152500"], ["150500", "152200"],
    ["152200", "150700"], ["152500", "152200"], ["150900", "152500"], ["140200", "150900"], ["210100", "210300"], ["211100", "210300"],
    ["210100", "211000"], ["210300", "211000"], ["211000", "210800"],
  ];
  for (const [a, b] of corrections) {
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
    if (!adjacency[b].includes(a)) adjacency[b].push(a);
  }
  return adjacency;
}
