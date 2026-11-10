-- Luacheck configuration for HushCut
-- Target runtime is Lua 5.1 / LuaJIT (as used by DaVinci Resolve Fusion scripting)
std = "lua51+luajit"

-- DaVinci Resolve environment globals
read_globals = {
  "resolve",
  "Resolve",
  "bmd",
}

-- Ignore implicit self argument warnings for method syntax
self = false
