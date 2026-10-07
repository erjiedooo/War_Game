import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pointInGeometry } from "../dist/modules/geometry.js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = path.join(rootDirectory, "dist", "data");
const territoryGeoJson = JSON.parse(fs.readFileSync(path.join(dataDirectory, "northern-theater.geojson"), "utf8"));
const riverGeoJson = JSON.parse(fs.readFileSync(path.join(dataDirectory, "northern-rivers.geojson"), "utf8"));
const mountainGeoJson = JSON.parse(fs.readFileSync(path.join(dataDirectory, "northern-mountains.geojson"), "utf8"));

const allowedRivers = new Set(["黄河", "海河", "滦河", "辽河", "西辽河", "淮河"]);

export const TERRITORY_DEFINITIONS = Object.fromEntries(territoryGeoJson.features.map((feature) => {
  const { code, name, province, label } = feature.properties;
  const mountainRanges = mountainGeoJson.features
    .filter((terrain) => terrain.properties.kind !== "desert" && pointInGeometry(label, terrain.geometry))
    .map((terrain) => terrain.properties.nameZh || terrain.properties.name);
  return [code, { id: code, name, shortName: name.replace(/(市|盟|地区)$/, ""), province, label, mountainRanges }];
}));

export const TERRITORY_IDS = Object.keys(TERRITORY_DEFINITIONS);

function deriveAdjacency() {
  const boundaryPoints = {};
  for (const feature of territoryGeoJson.features) {
    const points = new Set();
    const visit = (coordinates) => {
      if (typeof coordinates[0] === "number") {
        points.add(`${coordinates[0].toFixed(3)},${coordinates[1].toFixed(3)}`);
        return;
      }
      coordinates.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    boundaryPoints[feature.properties.code] = points;
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
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
    if (!adjacency[b].includes(a)) adjacency[b].push(a);
  }
  return adjacency;
}

export const TERRITORY_ADJACENCY = deriveAdjacency();

export const RIVER_SEGMENTS = riverGeoJson.features
  .filter((feature) => allowedRivers.has(feature.properties.nameZh))
  .flatMap((feature) => feature.geometry.coordinates.flatMap((line) => line.slice(1).map((point, index) => ({
    a: line[index],
    b: point,
    name: feature.properties.nameZh === "西辽河" ? "辽河" : feature.properties.nameZh,
  }))));

export const TERRAIN_FEATURES = mountainGeoJson.features;

export const MAP_BOUNDS = territoryGeoJson.features.reduce((bounds, feature) => {
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      bounds.minLon = Math.min(bounds.minLon, coordinates[0]);
      bounds.maxLon = Math.max(bounds.maxLon, coordinates[0]);
      bounds.minLat = Math.min(bounds.minLat, coordinates[1]);
      bounds.maxLat = Math.max(bounds.maxLat, coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  return bounds;
}, { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity });
