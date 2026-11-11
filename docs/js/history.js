// Build history kept in this browser only (localStorage). Each entry keeps the
// plan JSON, so the model and every file can be rebuilt from it at any time.
const KEY = "autodesign3d.history";
const MAX = 100;

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.raw) : [];
  } catch { return []; }
}

function write(list) {
  // When the browser runs out of room, drop the oldest entries until it fits.
  for (let n = list.length; n > 0; n = Math.floor(n * 0.8)) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, n))); return true; }
    catch { if (n === 1) break; }
  }
  return false;
}

export function saveHistory(list) { return write(list.slice(0, MAX)); }

export function addEntry(entry) {
  const list = loadHistory();
  const same = list[0] && JSON.stringify(list[0].raw) === JSON.stringify(entry.raw);
  if (same) { list[0] = { ...list[0], at: entry.at, thumb: entry.thumb || list[0].thumb }; return write(list) && list[0]; }
  const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...entry };
  list.unshift(e);
  return write(list.slice(0, MAX)) && e;
}

export function removeEntry(id) { return write(loadHistory().filter((e) => e.id !== id)); }
export function getEntry(id) { return loadHistory().find((e) => e.id === id) || null; }
