import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGameState } from "../server/game-engine.js";
import { createRoomStore } from "../server/persistence.js";

test("磁盘存档原子往返，并在服务器重启后以暂停状态恢复", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "war-game-save-"));
  try {
    const players = [
      { id: "p1", name: "甲", factionId: "zhu_di", connected: true, socketId: "socket-1", reconnectTokenHash: "a".repeat(64) },
      { id: "p2", name: "乙", factionId: "li_shimin", connected: true, socketId: "socket-2", reconnectTokenHash: "b".repeat(64) },
    ];
    const room = { code: "SAVE01", status: "playing", maxPlayers: 2, hostPlayerId: "p1", players, createdAt: Date.now(), game: null };
    room.game = createGameState(room);
    room.game.pendingOrders.p1.push({ id: "kept-order", playerId: "p1", owner: "zhu_di", source: "110000", target: "130800", mode: "land", amount: 2, path: ["110000", "130800"], routeGeo: [] });
    const store = createRoomStore(temporaryDirectory);
    store.save(new Map([[room.code, room]]));

    const restored = store.load().get(room.code);
    assert.ok(restored);
    assert.equal(restored.players.every((player) => !player.connected && player.socketId === null), true);
    assert.equal(restored.game.players.filter((player) => !player.isNpc).every((player) => !player.connected), true);
    assert.equal(restored.game.players.filter((player) => player.isNpc).every((player) => player.connected), true);
    assert.deepEqual(new Set(restored.game.pausedPlayerIds), new Set(["p1", "p2"]));
    assert.equal(restored.game.phase, "paused");
    assert.equal(restored.game.phaseBeforePause, "planning");
    assert.equal(restored.game.pauseReason, "server_restart");
    assert.equal(restored.game.pendingOrders.p1[0].id, "kept-order");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
