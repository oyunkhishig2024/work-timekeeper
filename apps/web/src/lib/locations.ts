import { api } from "./api";

export interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  active: boolean;
  activeEmployees: number | null;
}

export interface LocationInput {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusM: number;
}

export const fetchAllLocations = () => api<LocationRow[]>("/v1/locations");
export const createLocation = (input: LocationInput) =>
  api<LocationRow>("/v1/locations", { method: "POST", body: input });
export const updateLocation = (id: string, input: Partial<LocationInput> & { active?: boolean }) =>
  api<LocationRow>(`/v1/locations/${id}`, { method: "PATCH", body: input });

/** Parses "47.9184, 106.9177" (what Google Maps copies on a right click) into numbers. */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? { lat, lng } : null;
}
