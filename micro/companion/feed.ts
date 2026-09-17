import { Database } from "bun:sqlite";
import type { WindowCapability } from "../compiler/ir.ts";

const FIELDS = [
  { name: "id", ty: "int" }, { name: "title", ty: "str" },
  { name: "topic", ty: "str" }, { name: "score", ty: "int" },
];
const TITLES = ["A smaller working set", "State has an owner", "Pages beyond the screen", "Keep the frame moving", "Space for the next idea", "Make lifetime explicit", "A window into the archive", "Local input, remote data"];
/** Sparse, persistent corpus. Access materializes records on the Companion;
 * browsing history and stored records grow here, never on the handheld. */
export function createFeedService(path: string, capability: WindowCapability) {
  if (capability.method !== "feed.window" || JSON.stringify(capability.fields) !== JSON.stringify(FIELDS)) throw Error("feed.window schema is incompatible with this provider");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, topic TEXT NOT NULL, score INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, offset INTEGER, query INTEGER, time INTEGER)");
  const insert = db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, ?, ?)");
  const get = db.prepare("SELECT id, title, topic, score FROM notes WHERE id = ?");
  const visit = db.prepare("INSERT INTO visits (offset, query, time) VALUES (?, ?, ?)");
  const page = db.transaction((offset: number, query: number, limit: number) => {
    const rows = [];
    for (let slot = 0; slot < limit; slot++) {
      const index = offset + slot;
      const id = query === 0 ? index + 1 : index * 2 + query;
      if (id > 0x7fffffff) break;
      const topic = id % 2 ? "ENGINEERING" : "DESIGN";
      insert.run(id, TITLES[(id - 1) % TITLES.length], topic, (id * 17) % 100);
      rows.push(get.get(id));
    }
    visit.run(offset, query, Date.now());
    const nextId = query === 0 ? offset + limit + 1 : (offset + limit) * 2 + query;
    const total = query === 0 ? 0x7fffffff : Math.floor((0x7fffffff - query) / 2) + 1;
    return { offset, query, more: nextId <= 0x7fffffff, total, rows };
  });
  return {
    methods: { "feed.window": (payload: string) => {
      const request = JSON.parse(payload);
      const { schema, offset, query, limit } = request;
      if (Object.keys(request).sort().join() !== "limit,offset,query,schema" || schema !== capability.schema ||
          !Number.isInteger(offset) || offset < 0 || offset > 0x7fffffff - capability.pageSize ||
          !Number.isInteger(limit) || limit !== capability.pageSize || limit < 1 || limit > 8 ||
          !Number.isInteger(query) || query < 0 || query > 2) throw Error("Invalid typed window request");
      const result = JSON.stringify(page(offset, query, limit));
      if (Buffer.byteLength(result) > 2500) throw Error("Page byte budget exceeded");
      return result;
    } },
    counts: () => ({ notes: db.query("SELECT COUNT(*) AS n FROM notes").get(), visits: db.query("SELECT COUNT(*) AS n FROM visits").get() }),
    close: () => db.close(),
  };
}
