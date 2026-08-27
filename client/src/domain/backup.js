import { MatchEvent } from "./match-event.js";

export const BACKUP_FORMAT = "lineupjd-full-backup";
export const BACKUP_VERSION = 1;

export function createFullBackup(meta, events, exportedAt = new Date().toISOString()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    meta: structuredClone(meta),
    events: structuredClone(events)
  };
}

export function parseFullBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("That file is not valid JSON."); }
  if (parsed?.format !== BACKUP_FORMAT || parsed?.version !== BACKUP_VERSION) {
    throw new Error("Choose a full LineUp JD backup file.");
  }
  if (!Array.isArray(parsed.meta) || !Array.isArray(parsed.events)) throw new Error("The backup is missing app data.");
  const metaKeys = new Set();
  const meta = parsed.meta.map(record => {
    if (!record || typeof record.key !== "string" || !record.key || metaKeys.has(record.key)) throw new Error("The backup contains invalid settings.");
    metaKeys.add(record.key);
    return structuredClone(record);
  });
  const eventIds = new Set();
  const events = parsed.events.map(record => {
    const event = new MatchEvent(record).toJSON();
    if (eventIds.has(event.eventId)) throw new Error("The backup contains duplicate events.");
    eventIds.add(event.eventId);
    return event;
  });
  return { meta, events, exportedAt: parsed.exportedAt || null };
}

export function mergeEventHistories(localEvents, incomingEvents) {
  const byId = new Map(localEvents.map(event => [event.eventId, event]));
  const addedEvents = [];
  for (const incoming of incomingEvents) {
    const existing = byId.get(incoming.eventId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(incoming)) throw new Error(`Event conflict found in match ${incoming.matchId}. No data was imported.`);
      continue;
    }
    byId.set(incoming.eventId, incoming);
    addedEvents.push(incoming);
  }
  const events = [...byId.values()].sort((a, b) => a.realTimestamp.localeCompare(b.realTimestamp) || a.sequence - b.sequence);
  return { events, addedEvents };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
