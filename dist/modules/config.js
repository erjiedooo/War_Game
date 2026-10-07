export const MAX_TROOPS = 30;
export const METROPOLIS_MAX_TROOPS = 45;
export const GROWTH_PER_TERRITORY = 3;
export const NEUTRAL = "neutral";
export const MOUNTAIN_DEFENSE_MULTIPLIER = 1.25;
export const CAPITAL_DEFENSE_MULTIPLIER = 1.15;
export const METROPOLIS_DEFENSE_MULTIPLIER = 1.25;
export const ENCIRCLED_DEFENSE_MULTIPLIER = 0.75;
export const RIVER_ATTRITION_RATE = 0.15;
export const MOUNTAIN_ATTRITION_RATE = 0.20;
export const DESERT_ATTRITION_RATE = 0.15;
export const AIRDROP_ATTRITION_RATE = 0.25;
export const LANDING_ATTRITION_RATE = 0.30;
export const LAND_RELAY_RANGE_KM = 300;
export const AIR_RANGE_KM = 1200;
export const CONSTRUCTION_TURNS = 8;
export const MAX_AIRPORTS_PER_FACTION = 4;
export const STRONGHOLD_DEFENSE_MULTIPLIER = 1.25;

export const MULTIPLAYER_GAME_MODES = {
  expansion: { name: "开拓模式", description: "十个势力各据一城；玩家选择势力，其余由 NPC 接管。" },
  partition: { name: "割据模式", description: "八个势力按单机固定版图瓜分 84 城；其余势力由 NPC 接管。" },
};

export const MILITARY_STRONGHOLDS = {
  "130700": { name: "张家口", role: "燕山北口" },
  "140200": { name: "大同", role: "北方锁钥" },
  "140300": { name: "阳泉", role: "太行山口" },
  "140400": { name: "长治", role: "上党门户" },
  "210700": { name: "锦州", role: "辽西走廊" },
  "411200": { name: "三门峡", role: "崤函通道" },
  "130200": { name: "唐山", role: "滦河防线" },
  "210100": { name: "沈阳", role: "辽河枢纽" },
  "370100": { name: "济南", role: "黄河防线" },
  "410100": { name: "郑州", role: "黄河渡口" },
};

const MOUNTAIN_BARRIER_EDGE_LIST = [
  ["130100", "140700", "太行山"], ["130100", "140900", "太行山"],
  ["130400", "140700", "太行山"], ["130500", "140700", "太行山"],
  ["130600", "140900", "太行山"],
  ["110000", "130800", "燕山"], ["120000", "130800", "燕山"],
  ["130200", "130800", "燕山"], ["130300", "130800", "燕山"],
  ["130300", "211300", "燕山"], ["130800", "211300", "辽西丘陵"],
  ["140800", "410300", "中条山—崤山"], ["140800", "419001", "中条山—崤山"],
];

export const MOUNTAIN_BARRIER_EDGES = MOUNTAIN_BARRIER_EDGE_LIST.map(([a, b, name]) => ({ a, b, name }));
const MOUNTAIN_BARRIER_EDGE_KEYS = new Map(MOUNTAIN_BARRIER_EDGES.map(({ a, b, name }) => [[a, b].sort().join(":"), name]));

export function mountainBarrierForEdge(a, b) {
  return MOUNTAIN_BARRIER_EDGE_KEYS.get([String(a), String(b)].sort().join(":")) ?? null;
}

export const STRATEGIC_MOUNTAIN_LINES = [
  { name: "太行山防线", points: [[114.15, 40.25], [113.7, 39.25], [113.45, 38.25], [113.35, 37.25], [113.55, 36.25], [113.55, 35.35]] },
  { name: "燕山防线", points: [[115.1, 40.75], [116.2, 40.75], [117.35, 40.75], [118.45, 40.55], [119.45, 40.3]] },
  { name: "辽西丘陵防线", points: [[118.9, 41.45], [119.75, 41.35], [120.55, 41.05], [121.15, 40.85]] },
  { name: "中条山—崤山防线", points: [[110.55, 35.25], [111.15, 35.05], [111.75, 34.75], [112.35, 34.55]] },
];

export const COASTAL_TERRITORIES = new Set([
  "120000", "130200", "130300", "130900",
  "210200", "210600", "210700", "210800", "211100", "211400",
  "370200", "370500", "370600", "370700", "371000", "371100", "371600",
]);

export const FACTIONS = {
  zhu_di: { name: "朱棣", short: "朱", start: "110000", color: "#3aa7c9", style: "steady", description: "据点北京 · 燕王旧地" },
  li_shimin: { name: "李世民", short: "李", start: "140100", color: "#d5a848", style: "aggressive", description: "据点太原 · 晋阳起兵" },
  cao_cao: { name: "曹操", short: "曹", start: "410500", color: "#b85b55", style: "aggressive", description: "据点安阳 · 邺城故地" },
  yuan_shao: { name: "袁绍", short: "袁", start: "130400", color: "#8b6db2", style: "steady", description: "据点邯郸 · 河北根基" },
  genghis: { name: "成吉思汗", short: "成", start: "150100", color: "#4db19a", style: "expander", description: "据点呼和浩特 · 草原腹地" },
  nurhaci: { name: "努尔哈赤", short: "努", start: "210100", color: "#d47b3f", style: "aggressive", description: "据点沈阳 · 辽东门户" },
  qi_huangong: { name: "齐桓公", short: "齐", start: "370300", color: "#5d86c9", style: "expander", description: "据点淄博 · 临淄故都" },
  zhao_kuangyin: { name: "赵匡胤", short: "赵", start: "410200", color: "#b16c8f", style: "steady", description: "据点开封 · 北宋都城" },
  mao_zedong: { name: "毛泽东", short: "毛", start: "130100", color: "#c84b43", style: "expander", description: "据点石家庄 · 西柏坡方向" },
  peng_dehuai: { name: "彭德怀", short: "彭", start: "140400", color: "#759447", style: "aggressive", description: "据点长治 · 太行山战场" },
  neutral: { name: "中立守军", short: "中", color: "#53635e" },
};

export const FACTION_IDS = ["zhu_di", "li_shimin", "cao_cao", "yuan_shao", "genghis", "nurhaci", "qi_huangong", "zhao_kuangyin", "mao_zedong", "peng_dehuai"];
export const FACTION_START_ZONES = {
  zhu_di: "京冀北部", yuan_shao: "京冀北部", mao_zedong: "京冀北部",
  li_shimin: "晋蒙西部", genghis: "晋蒙西部", peng_dehuai: "晋蒙西部",
  nurhaci: "辽东齐鲁", qi_huangong: "辽东齐鲁",
  cao_cao: "中原南部", zhao_kuangyin: "中原南部",
};
export const EIGHT_FACTION_IDS = ["zhu_di", "li_shimin", "cao_cao", "genghis", "nurhaci", "qi_huangong", "zhao_kuangyin", "mao_zedong"];
export const GAME_MODES = {
  ten: { name: "十雄逐鹿", description: "十个势力各据一城，其余城市由中立守军控制。", factionIds: FACTION_IDS },
  eight: { name: "八方割据", description: "八个势力在开局时瓜分全部 84 座城市。", factionIds: EIGHT_FACTION_IDS },
};

export const EIGHT_TERRITORY_GROUPS = {
  zhu_di: ["110000", "120000", "130200", "130300", "130800", "150400", "150500", "210700", "210900", "211300", "211400"],
  li_shimin: ["140100", "140300", "140400", "140500", "140700", "140800", "141000", "141100", "410300", "411200", "419001"],
  genghis: ["140900", "150100", "150200", "150300", "150600", "150700", "150800", "150900", "152200", "152500", "152900"],
  nurhaci: ["210100", "210200", "210300", "210400", "210500", "210600", "210800", "211000", "211100", "211200"],
  mao_zedong: ["130100", "130400", "130500", "130600", "130700", "130900", "131000", "131100", "140200", "140600"],
  qi_huangong: ["370100", "370200", "370300", "370500", "370600", "370700", "370900", "371000", "371100", "371300", "371600"],
  cao_cao: ["370400", "370800", "371400", "371500", "371700", "410500", "410600", "410700", "410900", "411400"],
  zhao_kuangyin: ["410100", "410200", "410400", "410800", "411000", "411100", "411300", "411500", "411600", "411700"],
};

export const MAP_SIZE = 760;
export const MIN_VIEW_SIZE = 80;
