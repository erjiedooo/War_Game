import fs from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node tools/build-northern-rivers.mjs <natural-earth-rivers.geojson> <output.geojson>");
  process.exit(1);
}

const bounds = { minLon: 100, maxLon: 126.5, minLat: 31, maxLat: 54.5 };
const chineseNames = {
  Fen: "汾河", Yi: "伊河", Huan: "洹河", Tuo: "滹沱河", Quan: "泉河", Ying: "颍河",
  Liao: "辽河", "Xar Moron": "西拉木伦河", Xiliao: "西辽河", Sanggan: "桑干河",
  Huai: "淮河", Yongding: "永定河", Hai: "海河", Huang: "黄河", Yalu: "鸭绿江",
  "Tao’er": "洮儿河", Shandian: "闪电河", Hailar: "海拉尔河", Daling: "大凌河",
  Argun: "额尔古纳河", Wei: "卫河", Qin: "沁河", Zhang: "漳河", Luan: "滦河",
  Nen: "嫩江", Wuding: "无定河", Tao: "洮河", Daqing: "大清河", Ziya: "子牙河",
};

function inside([lon, lat]) {
  return lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
}

function clipLine(line) {
  const segments = [];
  let current = [];
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    const point = line[index];
    if (inside(previous) || inside(point)) {
      if (current.length === 0) current.push(previous);
      current.push(point);
    } else if (current.length > 1) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const features = source.features.flatMap((feature) => {
  const lines = feature.geometry.coordinates.flatMap(clipLine);
  if (lines.length === 0) return [];
  const name = feature.properties.name ?? "";
  return [{
    type: "Feature",
    properties: {
      name,
      nameZh: chineseNames[name] ?? name,
      scalerank: feature.properties.scalerank,
      featurecla: feature.properties.featurecla,
    },
    geometry: { type: "MultiLineString", coordinates: lines },
  }];
});

const output = {
  type: "FeatureCollection",
  source: "Natural Earth 1:10m Rivers + Lake Centerlines v5.0.0",
  license: "Public domain",
  features,
};

fs.writeFileSync(outputPath, JSON.stringify(output));
console.log(`wrote ${features.length} northern river features to ${outputPath}`);
