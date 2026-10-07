import fs from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node tools/build-northern-map.mjs <cn_admin.bin> <output.geojson>");
  process.exit(1);
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  bytes(length) {
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  varint() {
    const marker = this.buffer[this.offset++];
    if (marker < 251) return marker;
    if (marker === 251) {
      const value = this.buffer.readUInt16LE(this.offset);
      this.offset += 2;
      return value;
    }
    if (marker === 252) {
      const value = this.buffer.readUInt32LE(this.offset);
      this.offset += 4;
      return value;
    }
    if (marker === 253) {
      const value = Number(this.buffer.readBigUInt64LE(this.offset));
      this.offset += 8;
      return value;
    }
    throw new Error(`unsupported bincode integer marker ${marker}`);
  }

  f64() {
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  string() {
    return this.bytes(this.varint()).toString("utf8");
  }

  vector(readItem) {
    return Array.from({ length: this.varint() }, readItem);
  }
}

function readArea(reader) {
  const name = reader.string();
  const code = reader.string();
  const polygons = reader.vector(() => reader.vector(() => reader.vector(() => [reader.f64(), reader.f64()])));
  const bbox = [reader.f64(), reader.f64(), reader.f64(), reader.f64()];
  return { name, code, polygons, bbox };
}

function polygonAreaAndCentroid(ring) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    x += (x1 + x2) * cross;
    y += (y1 + y2) * cross;
  }
  const area = twiceArea / 2;
  if (Math.abs(area) < 1e-10) return { area: 0, center: ring[0] ?? [0, 0] };
  return { area: Math.abs(area), center: [x / (6 * area), y / (6 * area)] };
}

const provinceNames = {
  "11": "北京市", "12": "天津市", "13": "河北省", "14": "山西省",
  "15": "内蒙古自治区", "21": "辽宁省", "37": "山东省", "41": "河南省",
};

const buffer = fs.readFileSync(inputPath);
if (buffer.subarray(0, 8).toString("ascii") !== "RCNGBIN1") throw new Error("unexpected data-file header");
const reader = new Reader(buffer.subarray(8));
const provinces = reader.vector(() => readArea(reader));
const cities = reader.vector(() => readArea(reader));
const counties = reader.vector(() => readArea(reader));
void provinces;
void counties;

const selected = cities.filter((area) => provinceNames[area.code.slice(0, 2)]);
const features = selected.map((area) => {
  const mainPolygon = area.polygons
    .map((polygon) => ({ polygon, result: polygonAreaAndCentroid(polygon[0] ?? []) }))
    .sort((a, b) => b.result.area - a.result.area)[0];
  return {
    type: "Feature",
    properties: {
      name: area.name,
      code: area.code,
      gb: `156${area.code}`,
      province: provinceNames[area.code.slice(0, 2)],
      label: mainPolygon?.result.center ?? [(area.bbox[0] + area.bbox[2]) / 2, (area.bbox[1] + area.bbox[3]) / 2],
    },
    geometry: { type: "MultiPolygon", coordinates: area.polygons },
  };
});

const output = {
  type: "FeatureCollection",
  source: "国家地理信息公共服务平台·天地图行政区划数据（经 reverse-geocoder-cn 边界包提取）",
  mapApprovalNumber: "GS(2024)0650号",
  scope: Object.values(provinceNames),
  features,
};

fs.writeFileSync(outputPath, JSON.stringify(output));
console.log(`wrote ${features.length} prefecture-level territories to ${outputPath}`);
