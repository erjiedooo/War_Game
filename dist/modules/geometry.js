export function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(point, geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => polygon.length > 0 && pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

export function segmentsIntersect(a, b, c, d) {
  const minMaxOverlap = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
  if (!minMaxOverlap) return false;
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

export function haversineKm(first, second) {
  const radians = (value) => value * Math.PI / 180;
  const [lon1, lat1] = first;
  const [lon2, lat2] = second;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function distancePointToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

export function simplifyRoute(points, tolerance = 3) {
  if (points.length <= 2) return points.map((point) => [...point]);
  let maxDistance = 0;
  let splitIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = distancePointToSegment(points[index], points[0], points[points.length - 1]);
    if (distance > maxDistance) { maxDistance = distance; splitIndex = index; }
  }
  if (maxDistance <= tolerance) return [[...points[0]], [...points[points.length - 1]]];
  return [...simplifyRoute(points.slice(0, splitIndex + 1), tolerance).slice(0, -1), ...simplifyRoute(points.slice(splitIndex), tolerance)];
}

export function getBounds(features) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      minLon = Math.min(minLon, coordinates[0]);
      maxLon = Math.max(maxLon, coordinates[0]);
      minLat = Math.min(minLat, coordinates[1]);
      maxLat = Math.max(maxLat, coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  features.forEach((feature) => visit(feature.geometry.coordinates));
  return { minLon, maxLon, minLat, maxLat };
}

export function createProjection(bounds, width = 760, height = 760, padding = 62) {
  const meanLat = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  const minX = bounds.minLon * cosLat;
  const maxX = bounds.maxLon * cosLat;
  const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (bounds.maxLat - bounds.minLat));
  const usedWidth = (maxX - minX) * scale;
  const usedHeight = (bounds.maxLat - bounds.minLat) * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;
  const project = ([lon, lat]) => [offsetX + (lon * cosLat - minX) * scale, offsetY + (bounds.maxLat - lat) * scale];
  project.inverse = ([x, y]) => [((x - offsetX) / scale + minX) / cosLat, bounds.maxLat - (y - offsetY) / scale];
  return project;
}

export function geometryToPath(geometry, project) {
  if (!geometry) return "";
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => polygon.map((ring) => {
    if (!ring.length) return "";
    return ring.map((coordinate, index) => {
      const [x, y] = project(coordinate);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ") + " Z";
  }).join(" ")).join(" ");
}
