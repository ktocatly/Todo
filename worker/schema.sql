-- Karen's List reminder server: one table of to-dos, one of the devices that get notifications.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- the whole to-do as JSON, exactly as the page saved it
  due INTEGER,                 -- next reminder time (ms since 1970, UTC), or NULL
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (done, due);
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- the browser's push subscription as JSON
  created_at INTEGER NOT NULL
);
