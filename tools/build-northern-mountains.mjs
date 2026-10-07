import fs from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node tools/build-northern-mountains.mjs <natural-earth-regions.geojson> <output.geojson>");
  process.exit(1);
}

const bounds = { minLon: 100, maxLon: 126.5, minLat: 31, maxLat: 54.5 };

function intersectsBounds(coordinates) {
  let matches = false;
  const visit = (value) => {
    if (matches) return;
    if (typeof value[0] === "number") {
      const [lon, lat] = value;
      matches = lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  return matches;
}

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const features = source.features
  .filter((feature) => feature.properties.FEATURECLA === "Range/mtn" && intersectsBounds(feature.geometry.coordinates))
  .map((feature) => ({
    type: "Feature",
    properties: {
      name: feature.properties.NAME,
      nameZh: feature.properties.NAME_ZH || feature.properties.NAME,
      scalerank: feature.properties.SCALERANK,
    },
    geometry: feature.geometry,
  }));

const output = {
  type: "FeatureCollection",
  source: "Natural Earth 1:10m Geography Regions Polygons",
  license: "Public domain",
  features,
};

fs.writeFileSync(outputPath, JSON.stringify(output));
console.log(`wrote ${features.length} northern mountain ranges to ${outputPath}`);
