-- SQLite test for DaVinci Resolve Lua
print("Testing for SQLite support...")

local ok, sqlite3 = pcall(require, "lsqlite3")

if ok and sqlite3 then
  print("SQLite module 'lsqlite3' is available!")
  local db = sqlite3.open_memory()
  db:exec[[
    CREATE TABLE test (id INTEGER PRIMARY KEY, message TEXT);
    INSERT INTO test VALUES (1, 'Hello from SQLite!');
  ]]

  for row in db:nrows("SELECT * FROM test") do
    print(string.format("Row: id=%d, message=%s", row.id, row.message))
  end
  db:close()
else
  print("SQLite module not available in this Lua environment.")
  print("Error message:", sqlite3)
end
