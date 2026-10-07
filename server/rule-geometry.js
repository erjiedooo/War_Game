export { haversineKm, pointInGeometry, segmentsIntersect } from "../dist/modules/geometry.js";
import { pointInGeometry, segmentsIntersect } from "../dist/modules/geometry.js";

export function lineIntersectsGeometry(start, end, geometry) {
  if (pointInGeometry(start, geometry) || pointInGeometry(end, geometry)) return true;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => polygon.some((ring) => ring.slice(1).some((point, index) => segmentsIntersect(start, end, ring[index], point))));
}
