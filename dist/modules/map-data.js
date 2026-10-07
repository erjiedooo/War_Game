const ALLOWED_RIVERS = new Set(["黄河", "海河", "滦河", "辽河", "西辽河", "淮河"]);

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}请求失败：${response.status}`);
  return response.json();
}

export async function loadMapData() {
  const [territories, rawRivers, mountains] = await Promise.all([
    fetchJson("./data/northern-theater.geojson", "地图数据"),
    fetchJson("./data/northern-rivers.geojson", "河道数据"),
    fetchJson("./data/northern-mountains.geojson", "山脉数据"),
  ]);
  const rivers = {
    ...rawRivers,
    features: rawRivers.features
      .filter((feature) => ALLOWED_RIVERS.has(feature.properties.nameZh))
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          nameZh: feature.properties.nameZh === "西辽河" ? "辽河" : feature.properties.nameZh,
        },
      })),
  };
  return { territories, rivers, mountains };
}
