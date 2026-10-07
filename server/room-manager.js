import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EIGHT_FACTION_IDS, FACTIONS, FACTION_IDS, FACTION_START_ZONES, MULTIPLAYER_GAME_MODES } from "../dist/modules/config.js";
import {
  GameRuleError, cancelConstruction, cancelOrder, createGameState, endPlayerTurn,
  pauseGame, publicGameState, resumeGameIfReady, stageOrder, startConstruction,
} from "./game-engine.js";

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

class RoomError extends Error {
  constructor(message, code = "ROOM_ERROR") {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

function requireRoom(condition, message, code) {
  if (!condition) throw new RoomError(message, code);
}

function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 20);
  requireRoom(name.length >= 1, "请输入玩家名称。", "INVALID_NAME");
  return name;
}

function cleanRoomCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function roomCode() {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function reconnectToken() {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token) {
  return createHash("sha256").update(String(token ?? "")).digest();
}

function tokenMatches(token, expectedHex) {
  if (!token || !expectedHex || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  return timingSafeEqual(tokenHash(token), Buffer.from(expectedHex, "hex"));
}

function publicRoomState(room, viewerPlayerId) {
  const availableFactionIds = room.settings?.gameMode === "partition" ? EIGHT_FACTION_IDS : FACTION_IDS;
  return {
    code: room.code,
    status: room.status,
    minPlayers: MIN_PLAYERS,
    maxPlayers: room.maxPlayers,
    hostPlayerId: room.hostPlayerId,
    viewerPlayerId,
    savedAt: room.savedAt ?? null,
    settings: {
      gameMode: room.settings?.gameMode === "partition" ? "partition" : "expansion",
      strategicTerrain: Boolean(room.settings?.strategicTerrain),
    },
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      factionId: player.factionId,
      ready: player.ready,
      connected: player.connected,
      host: player.id === room.hostPlayerId,
    })),
    availableFactions: availableFactionIds.map((id) => ({ id, name: FACTIONS[id].name, short: FACTIONS[id].short, color: FACTIONS[id].color, description: FACTIONS[id].description, startZone: FACTION_START_ZONES[id] })),
  };
}

export function createRoomManager(io, { roomStore = null } = {}) {
  const rooms = roomStore?.load() ?? new Map();

  function persist({ strict = false } = {}) {
    if (!roomStore) return null;
    try {
      const savedAt = roomStore.save(rooms);
      for (const room of rooms.values()) room.savedAt = savedAt;
      return savedAt;
    } catch (error) {
      console.error("Failed to persist rooms:", error);
      if (strict) throw new RoomError("保存战局失败，请检查服务器存储。", "SAVE_FAILED");
      return null;
    }
  }

  function roomAndPlayer(socket) {
    const room = rooms.get(socket.data.roomCode);
    requireRoom(room, "你尚未加入房间。", "NOT_IN_ROOM");
    const player = room.players.find((candidate) => candidate.id === socket.data.playerId);
    requireRoom(player, "玩家身份已失效。", "PLAYER_NOT_FOUND");
    return { room, player };
  }

  function emitRoom(room) {
    for (const player of room.players) {
      if (!player.connected || !player.socketId) continue;
      io.to(player.socketId).emit("roomState", publicRoomState(room, player.id));
    }
  }

  function emitGame(room) {
    if (!room.game) return;
    for (const player of room.players) {
      if (!player.connected || !player.socketId) continue;
      io.to(player.socketId).emit("gameState", publicGameState(room.game, player.id));
    }
  }

  function persistAndBroadcast(room) {
    persist();
    emitRoom(room);
    emitGame(room);
  }

  function emitError(socket, error, ack) {
    const payload = {
      code: error?.code ?? "INTERNAL_ERROR",
      message: error instanceof RoomError || error instanceof GameRuleError ? error.message : "服务器处理请求时发生错误。",
    };
    socket.emit("errorMessage", payload);
    if (typeof ack === "function") ack({ ok: false, error: payload });
    if (!(error instanceof RoomError) && !(error instanceof GameRuleError)) console.error(error);
  }

  function safely(socket, handler) {
    return (...args) => {
      const ack = typeof args.at(-1) === "function" ? args.pop() : null;
      try {
        const data = handler(...args);
        if (typeof ack === "function") ack({ ok: true, data });
      } catch (error) {
        emitError(socket, error, ack);
      }
    };
  }

  function bindPlayerToSocket(socket, room, player) {
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
  }

  function addPlayerToSocket(socket, room, name) {
    const token = reconnectToken();
    const player = {
      id: randomUUID(),
      socketId: socket.id,
      name: cleanName(name),
      factionId: null,
      ready: false,
      connected: true,
      reconnectTokenHash: tokenHash(token).toString("hex"),
    };
    room.players.push(player);
    bindPlayerToSocket(socket, room, player);
    return { player, token };
  }

  function register(socket) {
    socket.on("latencyPing", (_payload, ack) => {
      if (typeof ack === "function") ack({ ok: true, data: { serverTime: Date.now() } });
    });

    socket.on("createRoom", safely(socket, (payload = {}) => {
      requireRoom(!socket.data.roomCode, "你已经在一个房间中。", "ALREADY_IN_ROOM");
      const maxPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.trunc(Number(payload.maxPlayers)) || MAX_PLAYERS));
      let code;
      do code = roomCode(); while (rooms.has(code));
      const gameMode = String(payload.gameMode ?? "expansion");
      requireRoom(MULTIPLAYER_GAME_MODES[gameMode], "未知的多人地图模式。", "INVALID_GAME_MODE");
      const room = {
        code,
        status: "lobby",
        maxPlayers,
        hostPlayerId: null,
        players: [],
        game: null,
        settings: { gameMode, strategicTerrain: Boolean(payload.strategicTerrain) },
        createdAt: Date.now(),
        savedAt: null,
      };
      const { player, token } = addPlayerToSocket(socket, room, payload.playerName);
      room.hostPlayerId = player.id;
      rooms.set(code, room);
      persistAndBroadcast(room);
      return { roomCode: code, playerId: player.id, reconnectToken: token };
    }));

    socket.on("joinRoom", safely(socket, (payload = {}) => {
      requireRoom(!socket.data.roomCode, "你已经在一个房间中。", "ALREADY_IN_ROOM");
      const code = cleanRoomCode(payload.roomCode);
      const room = rooms.get(code);
      requireRoom(room, "房间不存在，请检查房间码。", "ROOM_NOT_FOUND");
      requireRoom(room.status === "lobby", "游戏已经开始，房间已锁定。", "ROOM_LOCKED");
      requireRoom(room.players.length < room.maxPlayers, "房间人数已满。", "ROOM_FULL");
      const { player, token } = addPlayerToSocket(socket, room, payload.playerName);
      socket.to(room.code).emit("playerJoined", { playerId: player.id, name: player.name });
      persistAndBroadcast(room);
      return { roomCode: room.code, playerId: player.id, reconnectToken: token };
    }));

    socket.on("resumeSession", safely(socket, (payload = {}) => {
      requireRoom(!socket.data.roomCode, "当前连接已绑定玩家。", "ALREADY_IN_ROOM");
      const room = rooms.get(cleanRoomCode(payload.roomCode));
      requireRoom(room, "存档房间不存在。", "ROOM_NOT_FOUND");
      const player = room.players.find((candidate) => candidate.id === String(payload.playerId ?? ""));
      requireRoom(player && tokenMatches(payload.reconnectToken, player.reconnectTokenHash), "重连凭证无效。", "INVALID_RECONNECT");

      if (player.socketId && player.socketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(player.socketId);
        if (previousSocket) previousSocket.disconnect(true);
      }
      bindPlayerToSocket(socket, room, player);
      const gamePlayer = room.game?.players.find((candidate) => candidate.id === player.id);
      if (gamePlayer) gamePlayer.connected = true;
      if (room.game) resumeGameIfReady(room.game);
      persistAndBroadcast(room);
      if (room.game) socket.emit("gameStarted", { roomCode: room.code, playerId: player.id, resumed: true });
      return { roomCode: room.code, playerId: player.id, resumed: true };
    }));

    socket.on("setPlayerName", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "lobby", "游戏开始后不能修改名称。", "ROOM_LOCKED");
      player.name = cleanName(payload.playerName ?? payload.name);
      player.ready = false;
      persistAndBroadcast(room);
      return { name: player.name };
    }));

    socket.on("selectFaction", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "lobby", "游戏开始后不能更换势力。", "ROOM_LOCKED");
      const factionId = String(payload.factionId ?? "");
      const availableFactionIds = room.settings?.gameMode === "partition" ? EIGHT_FACTION_IDS : FACTION_IDS;
      requireRoom(availableFactionIds.includes(factionId), "该势力不属于当前地图模式。", "INVALID_FACTION");
      requireRoom(!room.players.some((candidate) => candidate.id !== player.id && candidate.factionId === factionId), "该势力已被其他玩家选择。", "FACTION_TAKEN");
      player.factionId = factionId;
      player.ready = false;
      persistAndBroadcast(room);
      return { factionId };
    }));

    socket.on("setReady", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "lobby", "游戏已经开始。", "ROOM_LOCKED");
      const ready = Boolean(payload.ready);
      requireRoom(!ready || player.factionId, "请先选择势力。", "FACTION_REQUIRED");
      player.ready = ready;
      persistAndBroadcast(room);
      return { ready };
    }));

    socket.on("startGame", safely(socket, () => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "lobby", "游戏已经开始。", "ROOM_LOCKED");
      requireRoom(player.id === room.hostPlayerId, "只有房主可以开始游戏。", "HOST_REQUIRED");
      requireRoom(room.players.length >= MIN_PLAYERS, `至少需要 ${MIN_PLAYERS} 名玩家。`, "NOT_ENOUGH_PLAYERS");
      requireRoom(room.players.every((candidate) => candidate.connected && candidate.ready && candidate.factionId), "所有在线玩家选择势力并准备后才能开始。", "PLAYERS_NOT_READY");
      room.status = "playing";
      room.game = createGameState(room);
      persistAndBroadcast(room);
      for (const member of room.players) if (member.connected) io.to(member.socketId).emit("gameStarted", { roomCode: room.code, playerId: member.id });
      return { started: true };
    }));

    const handleStageOrder = safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "playing" && room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      const order = stageOrder(room.game, player.id, payload);
      persistAndBroadcast(room);
      return { order };
    });
    socket.on("stageOrder", handleStageOrder);
    socket.on("moveUnit", handleStageOrder);
    socket.on("attack", handleStageOrder);

    socket.on("cancelOrder", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      cancelOrder(room.game, player.id, String(payload.orderId ?? ""));
      persistAndBroadcast(room);
      return { cancelled: true };
    }));

    socket.on("startConstruction", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      const construction = startConstruction(room.game, player.id, payload);
      persistAndBroadcast(room);
      return { construction };
    }));

    socket.on("cancelConstruction", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      cancelConstruction(room.game, player.id, String(payload.constructionId ?? ""));
      persistAndBroadcast(room);
      return { cancelled: true };
    }));

    socket.on("endTurn", safely(socket, () => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      const result = endPlayerTurn(room.game, player.id);
      persistAndBroadcast(room);
      if (result.gameEnded) io.to(room.code).emit("gameEnded", { winnerId: room.game.winnerId, winnerFactionId: room.game.winnerFactionId, resolution: result.resolution });
      return result;
    }));

    socket.on("saveGame", safely(socket, () => {
      const { room } = roomAndPlayer(socket);
      const savedAt = persist({ strict: true });
      emitRoom(room);
      return { savedAt };
    }));

    socket.on("setGamePaused", safely(socket, (payload = {}) => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.game, "游戏尚未开始。", "GAME_NOT_STARTED");
      requireRoom(player.id === room.hostPlayerId, "只有房主可以暂停或继续游戏。", "HOST_REQUIRED");
      if (Boolean(payload.paused)) {
        pauseGame(room.game, null, "manual");
      } else {
        requireRoom(room.game.players.filter((candidate) => !candidate.eliminated).every((candidate) => candidate.connected), "仍有玩家离线，不能继续游戏。", "PLAYERS_OFFLINE");
        requireRoom(resumeGameIfReady(room.game, { force: true }), "当前战局无法继续。", "RESUME_FAILED");
      }
      persistAndBroadcast(room);
      return { paused: room.game.phase === "paused" };
    }));

    socket.on("leaveRoom", safely(socket, () => {
      const { room, player } = roomAndPlayer(socket);
      requireRoom(room.status === "lobby", "游戏开始后请通过断线保留席位，当前不能退出并删除身份。", "GAME_IN_PROGRESS");
      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      if (!room.players.length) rooms.delete(room.code);
      else {
        if (room.hostPlayerId === player.id) room.hostPlayerId = room.players[0].id;
        emitRoom(room);
      }
      persist();
      return { left: true };
    }));

    socket.on("requestState", safely(socket, () => {
      const { room, player } = roomAndPlayer(socket);
      socket.emit("roomState", publicRoomState(room, player.id));
      if (room.game) socket.emit("gameState", publicGameState(room.game, player.id));
      return { delivered: true };
    }));

    socket.on("disconnect", () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room) return;
      const player = room.players.find((candidate) => candidate.id === socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.socketId = null;
      player.connected = false;
      const gamePlayer = room.game?.players.find((candidate) => candidate.id === player.id);
      if (gamePlayer) gamePlayer.connected = false;
      if (room.game && room.status === "playing" && !gamePlayer?.eliminated) pauseGame(room.game, player.id, "disconnect");
      socket.to(room.code).emit("playerLeft", { playerId: player.id, name: player.name, gamePaused: Boolean(room.game) });
      persistAndBroadcast(room);
    });
  }

  return { rooms, register, publicRoomState, persist };
}
