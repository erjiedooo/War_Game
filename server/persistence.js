import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAVE_VERSION = 1;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serializableRoom(room) {
  return {
    ...room,
    players: room.players.map(({ socketId: _socketId, ...player }) => ({ ...player, connected: false })),
    game: room.game ? {
      ...room.game,
      players: room.game.players.map((player) => ({ ...player, connected: Boolean(player.isNpc) })),
    } : null,
  };
}

function restoredRoom(room) {
  const players = (room.players ?? []).map((player) => ({ ...player, socketId: null, connected: false }));
  const game = room.game ? structuredClone(room.game) : null;
  if (game) {
    const humanIds = new Set(players.map((player) => player.id));
    game.players = (game.players ?? []).map((player) => ({ ...player, isNpc: player.isNpc ?? !humanIds.has(player.id), connected: Boolean(player.isNpc ?? !humanIds.has(player.id)) }));
    game.pendingOrders ??= Object.fromEntries(players.map((player) => [player.id, []]));
    game.pendingConstructions ??= Object.fromEntries(players.map((player) => [player.id, []]));
    game.submittedPlayerIds ??= [];
    game.roundStartTerritories ??= structuredClone(game.territories);
    game.currentPlayerIndex = null;
    game.currentPlayerId = null;
    game.pausedPlayerIds = game.players.filter((player) => !player.isNpc && !player.eliminated).map((player) => player.id);
    if (game.phase !== "finished") {
      game.phaseBeforePause = game.phase === "paused" ? (game.phaseBeforePause ?? "planning") : game.phase;
      game.phase = "paused";
      game.pauseReason = "server_restart";
    }
  }
  return { ...room, players, game, savedAt: room.savedAt ?? null };
}

export function createRoomStore(saveDirectory = process.env.WAR_GAME_SAVE_DIR || path.join(rootDirectory, "saves")) {
  const savePath = path.join(saveDirectory, "rooms.json");

  function load() {
    if (!fs.existsSync(savePath)) return new Map();
    try {
      const document = JSON.parse(fs.readFileSync(savePath, "utf8"));
      if (document.version !== SAVE_VERSION || !Array.isArray(document.rooms)) throw new Error("unsupported save format");
      return new Map(document.rooms.map((room) => {
        const restored = restoredRoom(room);
        return [restored.code, restored];
      }));
    } catch (error) {
      console.error(`Unable to load save file ${savePath}:`, error);
      return new Map();
    }
  }

  function save(rooms) {
    fs.mkdirSync(saveDirectory, { recursive: true });
    const savedAt = new Date().toISOString();
    for (const room of rooms.values()) room.savedAt = savedAt;
    const document = {
      version: SAVE_VERSION,
      savedAt,
      rooms: [...rooms.values()].map(serializableRoom),
    };
    const temporaryPath = `${savePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, savePath);
    return savedAt;
  }

  return { saveDirectory, savePath, load, save };
}
