import test from "node:test";
import assert from "node:assert/strict";
import {
  createGameState, endPlayerTurn, pauseGame, resumeGameIfReady, stageOrder, startConstruction,
} from "../server/game-engine.js";
import { TERRITORY_ADJACENCY } from "../server/game-data.js";
import {
  AIR_RANGE_KM, EIGHT_FACTION_IDS, EIGHT_TERRITORY_GROUPS, FACTION_IDS, LAND_RELAY_RANGE_KM,
} from "../dist/modules/config.js";

function roomFixture(count = 2, settings = undefined) {
  const factions = ["zhu_di", "li_shimin", "cao_cao", "nurhaci"];
  return {
    code: "TEST01",
    hostPlayerId: "p1",
    settings,
    players: Array.from({ length: count }, (_, index) => ({
      id: `p${index + 1}`,
      name: `玩家${index + 1}`,
      factionId: factions[index],
      connected: true,
    })),
  };
}

test("开拓联机保留十雄，未被真人选择的势力交由 NPC", () => {
  const game = createGameState(roomFixture(4));
  assert.equal(game.players.length, FACTION_IDS.length);
  assert.equal(game.players.filter((player) => !player.isNpc).length, 4);
  assert.equal(game.players.filter((player) => player.isNpc).length, 6);
  assert.equal(game.currentPlayerId, null);
  for (const player of game.players) {
    const capital = Object.values(game.territories).find((territory) => territory.capitalOf === player.factionId);
    assert.equal(capital.troops, 15);
  }
});

test("多人割据模式复用单机八方固定版图并由 NPC 补齐", () => {
  const game = createGameState(roomFixture(4, { gameMode: "partition", strategicTerrain: true }));
  assert.equal(game.players.length, EIGHT_FACTION_IDS.length);
  assert.equal(game.players.filter((player) => player.isNpc).length, 4);
  assert.equal(Object.values(game.territories).some((territory) => territory.owner === "neutral"), false);
  for (const factionId of EIGHT_FACTION_IDS) {
    const player = game.players.find((candidate) => candidate.factionId === factionId);
    assert.ok(player);
    const owned = Object.keys(game.territories).filter((id) => game.territories[id].owner === player.factionId);
    assert.deepEqual(new Set(owned), new Set(EIGHT_TERRITORY_GROUPS[factionId]));
    const visited = new Set([owned[0]]);
    const queue = [owned[0]];
    while (queue.length) for (const next of TERRITORY_ADJACENCY[queue.shift()] ?? []) if (game.territories[next].owner === player.factionId && !visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
    assert.equal(visited.size, owned.length);
  }
});

test("天险开关阻断普通跨山路线并保留重镇关口", () => {
  const game = createGameState(roomFixture(2, { gameMode: "expansion", strategicTerrain: true }));
  assert.throws(() => stageOrder(game, "p1", { source: "110000", target: "130800", amount: 3, path: ["110000", "130800"] }), /燕山阻断/);
  const gateOrder = stageOrder(game, "p1", { source: "110000", target: "130700", amount: 3, path: ["110000", "130700"] });
  assert.deepEqual(gateOrder.path, ["110000", "130700"]);
});

test("跨越己方城市的陆路限制为 300 公里，相邻城市不受里程限制", () => {
  assert.equal(LAND_RELAY_RANGE_KM, 300);
  const game = createGameState(roomFixture(2));
  game.territories["140100"].owner = "zhu_di";
  game.territories["140100"].troops = 15;
  game.territories["140900"].owner = "zhu_di";
  game.territories["140900"].troops = 15;
  assert.throws(
    () => stageOrder(game, "p1", { source: "140100", target: "150100", amount: 3, path: ["140100", "140900", "150100"] }),
    /最远 300 公里/,
  );
  const adjacent = stageOrder(game, "p1", { source: "140900", target: "150600", amount: 3, path: ["140900", "150600"] });
  assert.deepEqual(adjacent.path, ["140900", "150600"], "相邻城市即使直线距离超过 300 公里也允许调遣");
});

test("机场空降范围提高到 1200 公里", () => {
  assert.equal(AIR_RANGE_KM, 1200);
  const game = createGameState(roomFixture(2));
  game.territories["110000"].airport = true;
  assert.equal(stageOrder(game, "p1", { source: "110000", target: "211200", amount: 3, mode: "air" }).mode, "air", "原 700 公里外目标现在可空降");
  game.territories["150700"].owner = "zhu_di";
  game.territories["150700"].troops = 15;
  game.territories["150700"].airport = true;
  assert.throws(
    () => stageOrder(game, "p1", { source: "150700", target: "411500", amount: 3, mode: "air" }),
    /超出 1200 公里/,
  );
});

test("所有真人可同时部署，服务端仍限制各自出征预算", () => {
  const game = createGameState(roomFixture(2));
  const secondPlayerOrder = stageOrder(game, "p2", { source: "140100", target: "140300", amount: 3 });
  assert.equal(secondPlayerOrder.playerId, "p2");
  assert.throws(() => stageOrder(game, "p1", { source: "110000", target: "130800", amount: 15 }), /至少留下 1/);
  const order = stageOrder(game, "p1", { source: "110000", target: "130800", amount: 7 });
  assert.equal(order.amount, 7);
  assert.equal(game.territories["110000"].troops, 15, "部署阶段不提前修改权威兵力");
});

test("玩家可任意顺序提交，全部真人提交后 NPC 才部署并同步结算", () => {
  const game = createGameState(roomFixture(3));
  assert.equal(endPlayerTurn(game, "p2").resolved, false);
  assert.equal(game.players.filter((player) => player.isNpc).every((npc) => game.pendingOrders[npc.id].length === 0), true, "真人未全部提交前 NPC 不部署");
  assert.throws(() => stageOrder(game, "p2", { source: "140100", target: "140300", amount: 2 }), /已经提交/);
  assert.doesNotThrow(() => stageOrder(game, "p1", { source: "110000", target: "130800", amount: 3 }));
  assert.equal(game.roundStartTerritories["110000"].troops, 15, "玩家部署不得改变 NPC 使用的回合初始快照");
  assert.equal(endPlayerTurn(game, "p1").resolved, false);
  const result = endPlayerTurn(game, "p3");
  assert.equal(result.resolved, true);
  assert.equal(game.round, 2);
  assert.ok(game.lastResolution.orders.some((order) => order.playerId.startsWith("npc:")), "NPC 应在真人全部提交后生成命令");
  assert.equal(game.currentPlayerId, null);
  assert.deepEqual(game.submittedPlayerIds, []);
});

test("每个势力最多四个机场，含已建、在建和待提交", () => {
  const game = createGameState(roomFixture(2));
  const owned = ["110000", "120000", "130200", "130300", "130800"];
  for (const id of owned) game.territories[id].owner = "zhu_di";
  game.territories[owned[0]].airport = true;
  game.territories[owned[1]].airport = true;
  game.territories[owned[2]].construction = { type: "airport", remaining: 4 };
  startConstruction(game, "p1", { territoryId: owned[3], type: "airport" });
  assert.throws(() => startConstruction(game, "p1", { territoryId: owned[4], type: "airport" }), /最多拥有 4 个机场/);
});

test("相互攻打先汇总遭遇战，不会交换空城", () => {
  const game = createGameState(roomFixture(2));
  game.territories["130800"].owner = "li_shimin";
  game.territories["130800"].troops = 15;
  game.territories["130800"].capitalOf = "li_shimin";
  game.territories["140100"].owner = "neutral";
  game.territories["140100"].capitalOf = null;
  stageOrder(game, "p1", { source: "110000", target: "130800", amount: 7 });
  endPlayerTurn(game, "p1");
  stageOrder(game, "p2", { source: "130800", target: "110000", amount: 7 });
  endPlayerTurn(game, "p2");
  assert.equal(game.territories["110000"].owner, "zhu_di");
  assert.equal(game.territories["130800"].owner, "li_shimin");
  assert.equal(game.territories["110000"].troops, 11);
  assert.equal(game.territories["130800"].troops, 11);
  assert.match(game.lastResolution.report.map((entry) => entry.text).join("\n"), /遭遇战/);
});

test("建设命令在所有玩家提交后才进入权威状态", () => {
  const game = createGameState(roomFixture(2));
  startConstruction(game, "p1", { territoryId: "110000", type: "airport" });
  assert.equal(game.territories["110000"].construction, null);
  assert.equal(game.pendingConstructions.p1.length, 1);
  endPlayerTurn(game, "p1");
  endPlayerTurn(game, "p2");
  assert.equal(game.territories["110000"].construction.type, "airport");
  assert.equal(game.territories["110000"].construction.remaining, 7);
  assert.match(game.lastResolution.report.map((entry) => entry.text).join("\n"), /开始修建机场/);
});

test("玩家断线会暂停战局，全部重连后恢复原阶段", () => {
  const game = createGameState(roomFixture(3));
  game.players[1].connected = false;
  pauseGame(game, "p2", "disconnect");
  assert.equal(game.phase, "paused");
  assert.throws(() => stageOrder(game, "p1", { source: "110000", target: "130800", amount: 3 }), /暂停/);
  assert.equal(resumeGameIfReady(game), false);
  game.players[1].connected = true;
  assert.equal(resumeGameIfReady(game), true);
  assert.equal(game.phase, "planning");
});
