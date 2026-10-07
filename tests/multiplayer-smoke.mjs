import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";
import { EIGHT_FACTION_IDS, EIGHT_TERRITORY_GROUPS, FACTION_IDS } from "../dist/modules/config.js";

const port = Number(process.env.TEST_PORT ?? 4273);
const baseUrl = `http://127.0.0.1:${port}`;
const saveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "war-game-smoke-"));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), WAR_GAME_SAVE_DIR: saveDirectory },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("test server did not start");
}

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 3000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function connectClient(label) {
  const socket = io(baseUrl, { transports: ["websocket"], reconnection: false });
  socket.latestRoom = null;
  socket.latestGame = null;
  socket.on("roomState", (state) => { socket.latestRoom = state; });
  socket.on("gameState", (state) => { socket.latestGame = state; });
  socket.label = label;
  return socket;
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const factions = ["zhu_di", "li_shimin", "cao_cao", "nurhaci"];

async function runRoomScenario(count) {
  const clients = Array.from({ length: count }, (_, index) => connectClient(`P${index + 1}`));
  await Promise.all(clients.map((socket) => once(socket, "connect")));
  const latency = await request(clients[0], "latencyPing");
  assert.equal(latency.ok, true);
  assert.equal(Number.isFinite(latency.data.serverTime), true);
  const roomSettings = count === 4 ? { gameMode: "partition", strategicTerrain: true } : { gameMode: "expansion", strategicTerrain: false };
  const created = await request(clients[0], "createRoom", { playerName: "P1", maxPlayers: count, ...roomSettings });
  assert.equal(created.ok, true);
  const roomCode = created.data.roomCode;
  const credentials = [created.data];
  for (let index = 1; index < clients.length; index += 1) {
    const joined = await request(clients[index], "joinRoom", { roomCode, playerName: `P${index + 1}` });
    assert.equal(joined.ok, true);
    credentials[index] = joined.data;
  }
  for (let index = 0; index < clients.length; index += 1) {
    assert.equal((await request(clients[index], "selectFaction", { factionId: factions[index] })).ok, true);
    assert.equal((await request(clients[index], "setReady", { ready: true })).ok, true);
  }
  const started = await request(clients[0], "startGame");
  assert.equal(started.ok, true);
  await waitUntil(() => clients.every((socket) => socket.latestGame?.round === 1), `${count}-player initial gameState`);
  assert.equal(clients[0].latestGame.players.length, count === 4 ? EIGHT_FACTION_IDS.length : FACTION_IDS.length);
  assert.equal(clients[0].latestGame.players.filter((player) => player.isNpc).length, (count === 4 ? EIGHT_FACTION_IDS.length : FACTION_IDS.length) - count);
  assert.deepEqual(clients[0].latestRoom.settings, roomSettings);
  if (count === 4) {
    assert.equal(Object.values(clients[0].latestGame.territories).some((territory) => territory.owner === "neutral"), false);
    for (const faction of EIGHT_FACTION_IDS) assert.deepEqual(
      new Set(Object.entries(clients[0].latestGame.territories).filter(([, territory]) => territory.owner === faction).map(([id]) => id)),
      new Set(EIGHT_TERRITORY_GROUPS[faction]),
    );
  }
  const submitted = new Set();
  if (count > 1) {
    const secondOrder = await request(clients[1], "stageOrder", { source: "140100", target: "140300", amount: 2, mode: "land" });
    assert.equal(secondOrder.ok, true, "第二名玩家无需等待房主即可部署");
    const secondSubmitted = await request(clients[1], "endTurn");
    assert.equal(secondSubmitted.ok, true);
    assert.equal(secondSubmitted.data.resolved, false);
    submitted.add(1);
    const firstOrder = await request(clients[0], "stageOrder", { source: "110000", target: "130700", amount: 2, mode: "land" });
    assert.equal(firstOrder.ok, true, "其他玩家提交后房主仍可继续部署");
  }
  if (count === 2) {
    clients[1].close();
    await waitUntil(() => clients[0].latestGame?.phase === "paused", "automatic pause after disconnect");
    const blocked = await request(clients[0], "endTurn");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "GAME_PAUSED");
    const replacement = connectClient("P2-reconnected");
    await once(replacement, "connect");
    const resumed = await request(replacement, "resumeSession", credentials[1]);
    assert.equal(resumed.ok, true);
    clients[1] = replacement;
    await waitUntil(() => clients.every((socket) => socket.latestGame?.phase === "planning"), "automatic resume after reconnect");
  }
  for (let index = 0; index < clients.length; index += 1) {
    if (submitted.has(index)) continue;
    const ended = await request(clients[index], "endTurn");
    assert.equal(ended.ok, true);
  }
  await waitUntil(() => clients.every((socket) => socket.latestGame?.round === 2), `${count}-player synchronized round 2`);
  const reference = JSON.stringify(clients[0].latestGame.territories);
  assert.ok(clients.every((socket) => JSON.stringify(socket.latestGame.territories) === reference));
  assert.ok(clients[0].latestGame.lastResolution.orders.some((order) => String(order.playerId).startsWith("npc:")));
  for (const client of clients) client.close();
  await delay(50);
  console.log(`PASS ${count}-player simultaneous planning, NPC fill and synchronized resolution`);
}

async function runCapacityScenario() {
  const clients = Array.from({ length: 5 }, (_, index) => connectClient(`C${index + 1}`));
  await Promise.all(clients.map((socket) => once(socket, "connect")));
  const created = await request(clients[0], "createRoom", { playerName: "C1", maxPlayers: 4 });
  const roomCode = created.data.roomCode;
  for (let index = 1; index < 4; index += 1) assert.equal((await request(clients[index], "joinRoom", { roomCode, playerName: `C${index + 1}` })).ok, true);
  const fifth = await request(clients[4], "joinRoom", { roomCode, playerName: "C5" });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.error.code, "ROOM_FULL");
  for (const client of clients) client.close();
  console.log("PASS fifth player rejected from a four-player room");
}

try {
  await waitForServer();
  for (const count of [2, 3, 4]) await runRoomScenario(count);
  await runCapacityScenario();
  console.log("All multiplayer smoke tests passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), delay(2000)]);
  fs.rmSync(saveDirectory, { recursive: true, force: true });
}
