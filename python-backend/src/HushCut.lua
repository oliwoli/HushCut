--[[
David Kolf's JSON module for Lua 5.1/5.2 (Version 2.5)
Rewritten as a self-contained local module.
--]]
local json = (function()
  -- Module options from original file are no longer needed here.
  -- lpeg will be used if available.

  -- Original source: http://dkolf.de/src/dkjson-lua.fsl/

  -- Copyright (C) 2010-2014 David Heiko Kolf
  --
  -- Permission is hereby granted, free of charge, to any person obtaining
  -- a copy of this software and associated documentation files (the
  -- "Software"), to deal in the Software without restriction, including
  -- without limitation the rights to use, copy, modify, merge, publish,
  -- distribute, sublicense, and/or sell copies of the Software, and to
  -- permit persons to whom the Software is furnished to do so, subject to
  -- the following conditions:
  --
  -- The above copyright notice and this permission notice shall be
  -- included in all copies or substantial portions of the Software.
  --
  -- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  -- EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  -- MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
  -- NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
  -- BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
  -- ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
  -- CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  -- SOFTWARE.

  -- Localized global dependencies for encapsulation
  local pairs, type, tostring, tonumber, getmetatable, setmetatable, rawset =
      pairs, type, tostring, tonumber, getmetatable, setmetatable, rawset
  local error, require, pcall, select = error, require, pcall, select
  local floor, huge = math.floor, math.huge
  local strrep, gsub, strsub, strbyte, strchar, strfind, strlen, strformat =
      string.rep, string.gsub, string.sub, string.byte, string.char,
      string.find, string.len, string.format
  local strmatch = string.match
  local concat = table.concat

  local _ENV = nil -- blocking globals in Lua 5.2

  local internal_json_module = { version = "dkjson 2.5" }

  pcall(function()
    -- Enable access to blocked metatables if debug library is available.
    local debmeta = require "debug".getmetatable
    if debmeta then getmetatable = debmeta end
  end)

  internal_json_module.null = setmetatable({}, {
    __tojson = function() return "null" end
  })

  local function isarray(tbl)
    local max, n, arraylen = 0, 0, 0
    for k, v in pairs(tbl) do
      if k == 'n' and type(v) == 'number' then
        arraylen = v
        if v > max then
          max = v
        end
      else
        if type(k) ~= 'number' or k < 1 or floor(k) ~= k then
          return false
        end
        if k > max then
          max = k
        end
        n = n + 1
      end
    end
    if max > 10 and max > arraylen and max > n * 2 then
      return false -- don't create an array with too many holes
    end
    return true, max
  end

  local escapecodes = {
    ["\""] = "\\\"",
    ["\\"] = "\\\\",
    ["\b"] = "\\b",
    ["\f"] = "\\f",
    ["\n"] = "\\n",
    ["\r"] = "\\r",
    ["\t"] = "\\t"
  }

  local function escapeutf8(uchar)
    local value = escapecodes[uchar]
    if value then
      return value
    end
    local a, b, c, d = strbyte(uchar, 1, 4)
    a, b, c, d = a or 0, b or 0, c or 0, d or 0
    if a <= 0x7f then
      value = a
    elseif 0xc0 <= a and a <= 0xdf and b >= 0x80 then
      value = (a - 0xc0) * 0x40 + b - 0x80
    elseif 0xe0 <= a and a <= 0xef and b >= 0x80 and c >= 0x80 then
      value = ((a - 0xe0) * 0x40 + b - 0x80) * 0x40 + c - 0x80
    elseif 0xf0 <= a and a <= 0xf7 and b >= 0x80 and c >= 0x80 and d >= 0x80 then
      value = (((a - 0xf0) * 0x40 + b - 0x80) * 0x40 + c - 0x80) * 0x40 + d - 0x80
    else
      return ""
    end
    if value <= 0xffff then
      return strformat("\\u%.4x", value)
    elseif value <= 0x10ffff then
      -- encode as UTF-16 surrogate pair
      value = value - 0x10000
      local highsur, lowsur = 0xD800 + floor(value / 0x400), 0xDC00 + (value % 0x400)
      return strformat("\\u%.4x\\u%.4x", highsur, lowsur)
    else
      return ""
    end
  end

  local function fsub(str, pattern, repl)
    if strfind(str, pattern) then
      return gsub(str, pattern, repl)
    else
      return str
    end
  end

  local function quotestring(value)
    value = fsub(value, "[%z\1-\31\"\\\127]", escapeutf8)
    if strfind(value, "[\194\216\220\225\226\239]") then
      value = fsub(value, "\194[\128-\159\173]", escapeutf8)
      value = fsub(value, "\216[\128-\132]", escapeutf8)
      value = fsub(value, "\220\143", escapeutf8)
      value = fsub(value, "\225\158[\180\181]", escapeutf8)
      value = fsub(value, "\226\128[\140-\143\168-\175]", escapeutf8)
      value = fsub(value, "\226\129[\160-\175]", escapeutf8)
      value = fsub(value, "\239\187\191", escapeutf8)
      value = fsub(value, "\239\191[\176-\191]", escapeutf8)
    end
    return "\"" .. value .. "\""
  end
  internal_json_module.quotestring = quotestring

  local function replace(str, o, n)
    local i, j = strfind(str, o, 1, true)
    if i then
      return strsub(str, 1, i - 1) .. n .. strsub(str, j + 1, -1)
    else
      return str
    end
  end

  local decpoint, numfilter

  local function updatedecpoint()
    decpoint = strmatch(tostring(0.5), "([^05+])")
    numfilter = "[^0-9%-%+eE" .. gsub(decpoint, "[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0") .. "]+"
  end

  updatedecpoint()

  local function num2str(num)
    return replace(fsub(tostring(num), numfilter, ""), decpoint, ".")
  end

  local function str2num(str)
    local num = tonumber(replace(str, ".", decpoint))
    if not num then
      updatedecpoint()
      num = tonumber(replace(str, ".", decpoint))
    end
    return num
  end

  local function addnewline2(level, buffer, buflen)
    buffer[buflen + 1] = "\n"
    buffer[buflen + 2] = strrep("  ", level)
    buflen = buflen + 2
    return buflen
  end

  function internal_json_module.addnewline(state)
    if state.indent then
      state.bufferlen = addnewline2(state.level or 0,
        state.buffer, state.bufferlen or #(state.buffer))
    end
  end

  local encode2 -- forward declaration

  local function addpair(key, value, prev, indent, level, buffer, buflen, tables, globalorder, state)
    local kt = type(key)
    if kt ~= 'string' and kt ~= 'number' then
      return nil, "type '" .. kt .. "' is not supported as a key by JSON."
    end
    if prev then
      buflen = buflen + 1
      buffer[buflen] = ","
    end
    if indent then
      buflen = addnewline2(level, buffer, buflen)
    end
    buffer[buflen + 1] = quotestring(key)
    buffer[buflen + 2] = ":"
    return encode2(value, indent, level, buffer, buflen + 2, tables, globalorder, state)
  end

  local function appendcustom(res, buffer, state)
    local buflen = state.bufferlen
    if type(res) == 'string' then
      buflen = buflen + 1
      buffer[buflen] = res
    end
    return buflen
  end

  local function exception(reason, value, state, buffer, buflen, defaultmessage)
    defaultmessage = defaultmessage or reason
    local handler = state.exception
    if not handler then
      return nil, defaultmessage
    else
      state.bufferlen = buflen
      local ret, msg = handler(reason, value, state, defaultmessage)
      if not ret then return nil, msg or defaultmessage end
      return appendcustom(ret, buffer, state)
    end
  end

  function internal_json_module.encodeexception(reason, value, state, defaultmessage)
    return quotestring("<" .. defaultmessage .. ">")
  end

  encode2 = function(value, indent, level, buffer, buflen, tables, globalorder, state)
    local valtype = type(value)
    local valmeta = getmetatable(value)
    valmeta = type(valmeta) == 'table' and valmeta -- only tables
    local valtojson = valmeta and valmeta.__tojson
    if valtojson then
      if tables[value] then
        return exception('reference cycle', value, state, buffer, buflen)
      end
      tables[value] = true
      state.bufferlen = buflen
      local ret, msg = valtojson(value, state)
      if not ret then return exception('custom encoder failed', value, state, buffer, buflen, msg) end
      tables[value] = nil
      buflen = appendcustom(ret, buffer, state)
    elseif value == nil then
      buflen = buflen + 1
      buffer[buflen] = "null"
    elseif valtype == 'number' then
      local s
      if value ~= value or value >= huge or -value >= huge then
        s = "null"
      else
        s = num2str(value)
      end
      buflen = buflen + 1
      buffer[buflen] = s
    elseif valtype == 'boolean' then
      buflen = buflen + 1
      buffer[buflen] = value and "true" or "false"
    elseif valtype == 'string' then
      buflen = buflen + 1
      buffer[buflen] = quotestring(value)
    elseif valtype == 'table' then
      if tables[value] then
        return exception('reference cycle', value, state, buffer, buflen)
      end
      tables[value] = true
      level = level + 1
      local isa, n = isarray(value)
      if n == 0 and valmeta and valmeta.__jsontype == 'object' then
        isa = false
      end
      local msg
      if isa then -- JSON array
        buflen = buflen + 1
        buffer[buflen] = "["
        for i = 1, n do
          buflen, msg = encode2(value[i], indent, level, buffer, buflen, tables, globalorder, state)
          if not buflen then return nil, msg end
          if i < n then
            buflen = buflen + 1
            buffer[buflen] = ","
          end
        end
        buflen = buflen + 1
        buffer[buflen] = "]"
      else -- JSON object
        local prev = false
        buflen = buflen + 1
        buffer[buflen] = "{"
        local order = valmeta and valmeta.__jsonorder or globalorder
        if order then
          local used = {}
          n = #order
          for i = 1, n do
            local k = order[i]
            local v = value[k]
            if v then
              used[k] = true
              buflen, msg = addpair(k, v, prev, indent, level, buffer, buflen, tables, globalorder, state)
              prev = true
            end
          end
          for k, v in pairs(value) do
            if not used[k] then
              buflen, msg = addpair(k, v, prev, indent, level, buffer, buflen, tables, globalorder, state)
              if not buflen then return nil, msg end
              prev = true
            end
          end
        else -- unordered
          for k, v in pairs(value) do
            buflen, msg = addpair(k, v, prev, indent, level, buffer, buflen, tables, globalorder, state)
            if not buflen then return nil, msg end
            prev = true
          end
        end
        if indent then
          buflen = addnewline2(level - 1, buffer, buflen)
        end
        buflen = buflen + 1
        buffer[buflen] = "}"
      end
      tables[value] = nil
    else
      return exception('unsupported type', value, state, buffer, buflen,
        "type '" .. valtype .. "' is not supported by JSON.")
    end
    return buflen
  end

  function internal_json_module.encode(value, state)
    state = state or {}
    local oldbuffer = state.buffer
    local buffer = oldbuffer or {}
    state.buffer = buffer
    updatedecpoint()
    local ret, msg = encode2(value, state.indent, state.level or 0,
      buffer, state.bufferlen or 0, state.tables or {}, state.keyorder, state)
    if not ret then
      error(msg, 2)
    elseif oldbuffer == buffer then
      state.bufferlen = ret
      return true
    else
      state.bufferlen = nil
      state.buffer = nil
      return concat(buffer)
    end
  end

  local function loc(str, where)
    local line, pos, linepos = 1, 1, 0
    while true do
      pos = strfind(str, "\n", pos, true)
      if pos and pos < where then
        line = line + 1
        linepos = pos
        pos = pos + 1
      else
        break
      end
    end
    return "line " .. line .. ", column " .. (where - linepos)
  end

  local function unterminated(str, what, where)
    return nil, strlen(str) + 1, "unterminated " .. what .. " at " .. loc(str, where)
  end

  local function scanwhite(str, pos)
    while true do
      pos = strfind(str, "%S", pos)
      if not pos then return nil end
      local sub2 = strsub(str, pos, pos + 1)
      if sub2 == "\239\187" and strsub(str, pos + 2, pos + 2) == "\191" then
        pos = pos + 3
      elseif sub2 == "//" then
        pos = strfind(str, "[\n\r]", pos + 2)
        if not pos then return nil end
      elseif sub2 == "/*" then
        pos = strfind(str, "*/", pos + 2)
        if not pos then return nil end
        pos = pos + 2
      else
        return pos
      end
    end
  end

  local escapechars = {
    ["\""] = "\"",
    ["\\"] = "\\",
    ["/"] = "/",
    ["b"] = "\b",
    ["f"] = "\f",
    ["n"] = "\n",
    ["r"] = "\r",
    ["t"] = "\t"
  }

  local function unichar(value)
    if value < 0 then
      return nil
    elseif value <= 0x007f then
      return strchar(value)
    elseif value <= 0x07ff then
      return strchar(0xc0 + floor(value / 0x40),
        0x80 + (floor(value) % 0x40))
    elseif value <= 0xffff then
      return strchar(0xe0 + floor(value / 0x1000),
        0x80 + (floor(value / 0x40) % 0x40),
        0x80 + (floor(value) % 0x40))
    elseif value <= 0x10ffff then
      return strchar(0xf0 + floor(value / 0x40000),
        0x80 + (floor(value / 0x1000) % 0x40),
        0x80 + (floor(value / 0x40) % 0x40),
        0x80 + (floor(value) % 0x40))
    else
      return nil
    end
  end

  local function scanstring(str, pos)
    local lastpos = pos + 1
    local buffer, n = {}, 0
    while true do
      local nextpos = strfind(str, "[\"\\]", lastpos)
      if not nextpos then
        return unterminated(str, "string", pos)
      end
      if nextpos > lastpos then
        n = n + 1
        buffer[n] = strsub(str, lastpos, nextpos - 1)
      end
      if strsub(str, nextpos, nextpos) == "\"" then
        lastpos = nextpos + 1
        break
      else
        local escchar = strsub(str, nextpos + 1, nextpos + 1)
        local value
        if escchar == "u" then
          value = tonumber(strsub(str, nextpos + 2, nextpos + 5), 16)
          if value then
            local value2
            if 0xD800 <= value and value <= 0xDBff then
              if strsub(str, nextpos + 6, nextpos + 7) == "\\u" then
                value2 = tonumber(strsub(str, nextpos + 8, nextpos + 11), 16)
                if value2 and 0xDC00 <= value2 and value2 <= 0xDFFF then
                  value = (value - 0xD800) * 0x400 + (value2 - 0xDC00) + 0x10000
                else
                  value2 = nil
                end
              end
            end
            value = value and unichar(value)
            if value then
              if value2 then
                lastpos = nextpos + 12
              else
                lastpos = nextpos + 6
              end
            end
          end
        end
        if not value then
          value = escapechars[escchar] or escchar
          lastpos = nextpos + 2
        end
        n = n + 1
        buffer[n] = value
      end
    end
    if n == 1 then
      return buffer[1], lastpos
    elseif n > 1 then
      return concat(buffer), lastpos
    else
      return "", lastpos
    end
  end

  local scanvalue -- forward declaration

  local function scantable(what, closechar, str, startpos, nullval, objectmeta, arraymeta)
    local tbl, n = {}, 0
    local pos = startpos + 1
    if what == 'object' then
      setmetatable(tbl, objectmeta)
    else
      setmetatable(tbl, arraymeta)
    end
    while true do
      pos = scanwhite(str, pos)
      if not pos then return unterminated(str, what, startpos) end
      local char = strsub(str, pos, pos)
      if char == closechar then
        return tbl, pos + 1
      end
      local val1, err
      val1, pos, err = scanvalue(str, pos, nullval, objectmeta, arraymeta)
      if err then return nil, pos, err end
      pos = scanwhite(str, pos)
      if not pos then return unterminated(str, what, startpos) end
      char = strsub(str, pos, pos)
      if char == ":" then
        if val1 == nil then
          return nil, pos, "cannot use nil as table index (at " .. loc(str, pos) .. ")"
        end
        pos = scanwhite(str, pos + 1)
        if not pos then return unterminated(str, what, startpos) end
        local val2
        val2, pos, err = scanvalue(str, pos, nullval, objectmeta, arraymeta)
        if err then return nil, pos, err end
        tbl[val1] = val2
        pos = scanwhite(str, pos)
        if not pos then return unterminated(str, what, startpos) end
        char = strsub(str, pos, pos)
      else
        n = n + 1
        tbl[n] = val1
      end
      if char == "," then
        pos = pos + 1
      end
    end
  end

  scanvalue = function(str, pos, nullval, objectmeta, arraymeta)
    pos = pos or 1
    pos = scanwhite(str, pos)
    if not pos then
      return nil, strlen(str) + 1, "no valid JSON value (reached the end)"
    end
    local char = strsub(str, pos, pos)
    if char == "{" then
      return scantable('object', "}", str, pos, nullval, objectmeta, arraymeta)
    elseif char == "[" then
      return scantable('array', "]", str, pos, nullval, objectmeta, arraymeta)
    elseif char == "\"" then
      return scanstring(str, pos)
    else
      local pstart, pend = strfind(str, "^%-?[%d%.]+[eE]?[%+%-]?%d*", pos)
      if pstart then
        local number = str2num(strsub(str, pstart, pend))
        if number then
          return number, pend + 1
        end
      end
      pstart, pend = strfind(str, "^%a%w*", pos)
      if pstart then
        local name = strsub(str, pstart, pend)
        if name == "true" then
          return true, pend + 1
        elseif name == "false" then
          return false, pend + 1
        elseif name == "null" then
          return nullval, pend + 1
        end
      end
      return nil, pos, "no valid JSON value at " .. loc(str, pos)
    end
  end

  local function optionalmetatables(...)
    if select("#", ...) > 0 then
      return ...
    else
      return { __jsontype = 'object' }, { __jsontype = 'array' }
    end
  end

  function internal_json_module.decode(str, pos, nullval, ...)
    local objectmeta, arraymeta = optionalmetatables(...)
    return scanvalue(str, pos, nullval, objectmeta, arraymeta)
  end

  function internal_json_module.use_lpeg()
    local g = require("lpeg")

    if g.version() == "0.11" then
      error "due to a bug in LPeg 0.11, it cannot be used for JSON matching"
    end

    local pegmatch = g.match
    local P, S, R = g.P, g.S, g.R

    local function ErrorCall(str, pos, msg, state)
      if not state.msg then
        state.msg = msg .. " at " .. loc(str, pos)
        state.pos = pos
      end
      return false
    end

    local function Err(msg)
      return g.Cmt(g.Cc(msg) * g.Carg(2), ErrorCall)
    end

    local SingleLineComment = P "//" * (1 - S "\n\r") ^ 0
    local MultiLineComment = P "/*" * (1 - P "*/") ^ 0 * P "*/"
    local Space = (S " \n\r\t" + P "\239\187\191" + SingleLineComment + MultiLineComment) ^ 0

    local PlainChar = 1 - S "\"\\\n\r"
    local EscapeSequence = (P "\\" * g.C(S "\"\\/bfnrt" + Err "unsupported escape sequence")) / escapechars
    local HexDigit = R("09", "af", "AF")
    local function UTF16Surrogate(match, pos, high, low)
      high, low = tonumber(high, 16), tonumber(low, 16)
      if 0xD800 <= high and high <= 0xDBff and 0xDC00 <= low and low <= 0xDFFF then
        return true, unichar((high - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000)
      else
        return false
      end
    end
    local function UTF16BMP(hex)
      return unichar(tonumber(hex, 16))
    end
    local U16Sequence = (P "\\u" * g.C(HexDigit * HexDigit * HexDigit * HexDigit))
    local UnicodeEscape = g.Cmt(U16Sequence * U16Sequence, UTF16Surrogate) + U16Sequence / UTF16BMP
    local Char = UnicodeEscape + EscapeSequence + PlainChar
    local String = P "\"" * g.Cs(Char ^ 0) * (P "\"" + Err "unterminated string")
    local Integer = P "-" ^ (-1) * (P "0" + (R "19" * R "09" ^ 0))
    local Fractal = P "." * R "09" ^ 0
    local Exponent = (S "eE") * (S "+-") ^ (-1) * R "09" ^ 1
    local Number = (Integer * Fractal ^ (-1) * Exponent ^ (-1)) / str2num
    local Constant = P "true" * g.Cc(true) + P "false" * g.Cc(false) + P "null" * g.Carg(1)
    local SimpleValue = Number + String + Constant
    local ArrayContent, ObjectContent

    local function parsearray(str, pos, nullval, state)
      local obj, cont
      local npos
      local t, nt = {}, 0
      repeat
        obj, cont, npos = pegmatch(ArrayContent, str, pos, nullval, state)
        if not npos then break end
        pos = npos
        nt = nt + 1
        t[nt] = obj
      until cont == 'last'
      return pos, setmetatable(t, state.arraymeta)
    end

    local function parseobject(str, pos, nullval, state)
      local obj, key, cont
      local npos
      local t = {}
      repeat
        key, obj, cont, npos = pegmatch(ObjectContent, str, pos, nullval, state)
        if not npos then break end
        pos = npos
        t[key] = obj
      until cont == 'last'
      return pos, setmetatable(t, state.objectmeta)
    end

    local Array = P "[" * g.Cmt(g.Carg(1) * g.Carg(2), parsearray) * Space * (P "]" + Err "']' expected")
    local Object = P "{" * g.Cmt(g.Carg(1) * g.Carg(2), parseobject) * Space * (P "}" + Err "'}' expected")
    local Value = Space * (Array + Object + SimpleValue)
    local ExpectedValue = Value + Space * Err "value expected"
    ArrayContent = Value * Space * (P "," * g.Cc 'cont' + g.Cc 'last') * g.Cp()
    local Pair = g.Cg(Space * String * Space * (P ":" + Err "colon expected") * ExpectedValue)
    ObjectContent = Pair * Space * (P "," * g.Cc 'cont' + g.Cc 'last') * g.Cp()
    local DecodeValue = ExpectedValue * g.Cp()

    function internal_json_module.decode(str, pos, nullval, ...)
      local state = {}
      state.objectmeta, state.arraymeta = optionalmetatables(...)
      local obj, retpos = pegmatch(DecodeValue, str, pos, nullval, state)
      if state.msg then
        return nil, state.pos, state.msg
      else
        return obj, retpos
      end
    end

    internal_json_module.use_lpeg = function() return internal_json_module end
    internal_json_module.using_lpeg = true
    return internal_json_module
  end

  -- Always try using lpeg if available
  pcall(internal_json_module.use_lpeg)

  return internal_json_module
end)()

-- helper function to quote app paths
local function quote(str)
  return '"' .. str:gsub('"', '\\"') .. '"'
end

local function get_script_dir()
  local source = debug.getinfo(1, "S").source
  if source:sub(1, 1) == "@" then
    local script_path = source:sub(2)
    local sep = package.config:sub(1, 1) -- '/' or '\'
    return script_path:match("(.*" .. sep .. ")") or "./"
  else
    -- source is something like =stdin or =...
    return "./"
  end
end

local script_dir = get_script_dir()

local go_server_port = nil
local TEMP_DIR = script_dir .. "wav_files"


---
-- Sends a JSON message to the Go server via an HTTP POST request.
-- @param message_type (string) The type of the message being sent.
-- @param payload (table) The Lua table to be sent as the JSON payload.
-- @param task_id (string, optional) An identifier for the task.
-- @return (boolean) True on success, false on failure.
--
local function send_message_to_go(message_type, payload, task_id)
  if not go_server_port then
    print("Lua Error: Go server port not configured. Cannot send message to Go.")
    return false
  end


  local go_message = { Type = message_type, Payload = payload }

  -- Create a state table with a custom exception handler for the JSON encoder.
  -- This mimics the Python fallback_serializer by converting unknown types to a string.
  local state = {
    exception = function(reason, value, state, defaultmessage)
      if reason == 'unsupported type' then
        -- Fallback to string representation for any unsupported type (like userdata).
        -- We must quote the string to make it a valid JSON string value.
        return json.quotestring(tostring("<BMD_Object>"))
      end
      -- For any other error, re-raise it to halt execution.
      error(defaultmessage, 0)
    end
  }

  -- Encode the payload with the custom handler.
  -- Use pcall to safely handle any potential encoding errors.
  local success, json_payload = pcall(json.encode, go_message, state)

  if not success then
    print("Lua (to Go): JSON encoding failed: " .. tostring(json_payload))
    return false
  end


  local path = "/msg"
  if task_id then
    path = path .. "?task_id=" .. task_id
  end
  local url = "http://localhost:" .. go_server_port .. path

  local tmp_filename = TEMP_DIR .. "/payload.json"
  local f = io.open(tmp_filename, "w")
  if not f then
    print("Lua (to Go): Failed to open temp file for payload.")
    return false
  end
  f:write(json_payload)
  f:close()

  local command = string.format(
    'curl -s -X POST -H "Content-Type: application/json" --data-binary "@%s" "%s" -w "\\n%%{http_code}"',
    tmp_filename,
    url
  )

  local handle = io.popen(command)
  if not handle then
    print("Lua (to Go): Failed to execute curl command.")
    return false
  end

  local response_lines = {}
  for line in handle:lines() do
    table.insert(response_lines, line)
  end
  handle:close()

  if #response_lines == 0 then
    print("Lua (to Go): No response from curl command for message type '" .. message_type .. "'.")
    return false
  end

  local status_code_str = table.remove(response_lines)
  local response_body = table.concat(response_lines, "\n")
  local status_code = tonumber(status_code_str)

  if status_code and status_code >= 200 and status_code < 300 then
    print("Lua (to Go): Message type '" ..
      message_type .. "' sent successfully. Task id: " .. (task_id or 'nil') .. ". Go responded: " .. status_code)
    return true
  else
    print("Lua (to Go): Error sending message type '" ..
      message_type .. "'. Go responded with status " .. (status_code_str or 'N/A') .. ": " .. response_body)
    return false
  end
end


local function send_result_with_alert(alertTitle, alertMessage, task_id, alertSeverity)
  if not go_server_port then
    print("Lua Error: Go server port not configured. Cannot send result with alert.")
    return false
  end


  -- Construct the message payload
  local payload = {
    status = "error",
    message = alertMessage,
    shouldShowAlert = true,
    alertTitle = alertTitle,
    alertMessage = alertMessage,
    alertSeverity = alertSeverity or "error",
  }


  -- Send the message to the Go server
  return send_message_to_go("taskResult", payload, task_id)
end



local os_type = jit.os
local potential_paths



if os_type == "OSX" then
  potential_paths = {
    script_dir .. "HushCut.app/Contents/MacOS/HushCut",
    script_dir .. "../../build/bin/HushCut.app/Contents/MacOS/HushCut",
    script_dir .. "../../build/bin/HushCut",
  }
elseif os_type == "Windows" then
  potential_paths = {
    script_dir .. "HushCut.exe",
    script_dir .. "../../build/bin/HushCut.exe",
  }
else
  potential_paths = {
    script_dir .. "HushCut",
    script_dir .. "../../build/bin/HushCut",
  }
end



local go_app_path = nil
for _, path in ipairs(potential_paths) do
  local f = io.open(path, "r")
  if f then
    f:close()
    go_app_path = path
    break
  end
end



local function find_free_port(go_script_path)
  local handle = io.popen(quote(go_script_path) .. " --find-port")
  if handle then
    local port = handle:read("*a")
    handle:close()
    if port then
      return port:gsub("%s+", "")
    end
  end
  return nil
end





local function get_resolve()
  local success, result = pcall(function()
    ---@diagnostic disable-next-line: undefined-global
    return Resolve()
  end)

  if success and result then
    return result
  else
    print("Warning: Failed to obtain Resolve object.")
    print("Details:", result)

    return resolve
  end
end



local go_script_path = script_dir .. "lua-go-http"
local free_port = find_free_port(go_script_path)



---@diagnostic disable-next-line: undefined-global
local resolve_obj = get_resolve()
if not resolve_obj then
  print("Lua Error: Resolve object not found. Ensure this script is run inside DaVinci Resolve.")
  return
end
local pm = nil
local project = nil
local media_pool = nil
local timeline = nil
local created_timelines = {}



if resolve_obj then
  pm = resolve_obj:GetProjectManager()
  if pm then
    project = pm:GetCurrentProject()
    if project then
      media_pool = project:GetMediaPool()
      timeline = project:GetCurrentTimeline()
    end
  end
end



local function create_temp_dir(path)
  local is_windows = package.config:sub(1, 1) == '\\'

  local command
  if is_windows then
    -- Enclose in quotes to handle spaces in path
    command = 'mkdir "' .. path .. '"'
  else
    command = 'mkdir -p "' .. path .. '"'
  end

  local success = os.execute(command)
  if not success then
    print("Failed to create temp directory: " .. path)
    return false
  end

  return true
end

-- Usage
if not create_temp_dir(TEMP_DIR) then
  return
end

local make_new_timeline = true
local MAX_RETRIES = 100
local project_data = nil

if not resolve_obj then
  print("Resolve not found. Make sure this script is run inside DaVinci Resolve.")
  return
end



local bit = require("bit") -- assumes LuaBitOp or LuaJIT's bit library

-- FNV-1a hash using bitwise operations compatible with Lua 5.1
local function fnv1a_hash(str)
  local hash = 2166136261
  for i = 1, #str do
    hash = bit.bxor(hash, string.byte(str, i))
    hash = (hash * 16777619) % 2 ^ 32
  end
  return hash
end

-- UUID generator with optional deterministic seed
local function uuid(seed)
  local random
  if seed then
    local seed_num = fnv1a_hash(seed)
    local state = seed_num
    random = function(min, max)
      state = (1103515245 * state + 12345) % 2 ^ 31
      return min + (state % (max - min + 1))
    end
  else
    random = math.random
  end

  local template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  return string.gsub(template, '[xy]', function(c)
    local v = (c == 'x') and random(0, 0xf) or random(8, 0xb)
    return string.format('%x', v)
  end)
end



-- Placeholder for a function that creates a UUID from a file path.
local function uuid_from_path(path)
  -- call the script with --uuid-from-str <path>
  local command = string.format("%s --uuid-from-str '%s'", quote(go_script_path), path)
  local handle = io.popen(command)
  if not handle then
    print("Lua Error: Failed to execute command to get UUID from path: " .. path)
    return nil
  else
    local uuid_str = handle:read("*a")
    handle:close()
    if uuid_str and #uuid_str > 0 then
      return uuid_str:gsub("%s+", "") -- Remove any whitespace
    else
      print("Lua Error: No UUID returned for path: " .. path)
      return nil
    end
  end
end



---
-- Creates a unique identifier for a timeline item based on the Python implementation.
-- @param bmd_item (bmd.TimelineItem) The timeline item object from Resolve (unused).
-- @param item_name (string) The name of the item.
-- @param start_frame (number) The starting frame of the item on the timeline.
-- @param track_type (string) The type of track ("video" or "audio").
-- @param track_index (number) The index of the track.
-- @return (string) A unique identifier string.
--
local function get_item_id(bmd_item, item_name, start_frame, track_type, track_index)
  -- This creates an ID like: "MyClip-video-1--120"
  return string.format("%s-%s-%d--%d", item_name, track_type, track_index, start_frame)
end


local function generate_uuid_from_nested_clips(top_level_item, nested_clips)
  -- 1. Start with the top-level clip's unique properties.
  local bmd_item = top_level_item.bmd_mpi
  local seed_string = bmd_item and ("bmd_id:" .. bmd_item:GetUniqueId() .. ";") or "bmd_id:<unknown>;"
  seed_string = seed_string .. "duration:" .. (top_level_item.end_frame - top_level_item.start_frame) .. ";"
  seed_string = seed_string .. "source_start:" .. top_level_item.source_start_frame .. ";"
  seed_string = seed_string .. "source_end:" .. top_level_item.source_end_frame .. ";"

  -- 2. Add properties from all nested clips.
  -- Sort by the clip's start time within the container.
  table.sort(nested_clips, function(a, b) return a.start_frame < b.start_frame end)

  local nested_strings = {}
  for _, clip in ipairs(nested_clips) do
    local clip_signature = string.format("path:%s,start:%s,end:%s,s_start:%s,s_end:%s",
      tostring(clip.source_file_path), tostring(clip.start_frame), tostring(clip.end_frame),
      tostring(clip.source_start_frame), tostring(clip.source_end_frame)
    )
    table.insert(nested_strings, clip_signature)
  end

  seed_string = seed_string .. "nested_clips[" .. table.concat(nested_strings, "||") .. "]"

  -- 3. Generate a deterministic UUID from the canonical seed string by calling Go helper.
  local command = string.format("%s --uuid-from-str '%s'", quote(go_script_path), seed_string)
  local handle = io.popen(command)
  if not handle then
    print("Lua Error: Failed to execute command to get UUID from string.")
    return uuid() -- fallback to random
  else
    local uuid_str = handle:read("*a")
    handle:close()
    if uuid_str and #uuid_str > 0 then
      return uuid_str:gsub("%s+", "") -- Remove any whitespace
    else
      print("Lua Error: No UUID returned for seed string.")
      return uuid() -- fallback to random
    end
  end
end

---
-- Finds unique compound/multicam content and updates their properties.
-- @param audio_timeline_items (table) A list of all audio items from the timeline.
-- @param curr_processed_file_names (table) A list of filenames already processed.
--
local function mixdown_compound_clips(audio_timeline_items, curr_processed_file_names)
  -- --- Pass 1: Map all compound/multicam clips by their content UUID ---
  local content_map = {}
  for _, item in ipairs(audio_timeline_items) do
    if item.type and item.nested_clips and #item.nested_clips > 0 then
      local content_uuid = generate_uuid_from_nested_clips(item, item.nested_clips)
      if not content_map[content_uuid] then
        content_map[content_uuid] = {}
      end
      table.insert(content_map[content_uuid], item)
    end
  end

  -- --- Pass 2: Process each unique content group ---
  for content_uuid, items_in_group in pairs(content_map) do
    local representative_item = items_in_group[1]
    local output_filename = content_uuid .. ".wav"
    local output_wav_path = TEMP_DIR .. "/" .. output_filename

    local needs_render = true
    for _, name in ipairs(curr_processed_file_names) do
      if name == output_filename then
        needs_render = false
        break
      end
    end

    if needs_render then
      print("Go Mode: Skipping local render for new content ID " .. content_uuid .. ". Go will handle it.")
    else
      print("Content for '" .. representative_item.name .. "' is unchanged. Skipping render.")
    end

    for _, tl_item in ipairs(items_in_group) do
      tl_item.processed_file_name = output_filename
      tl_item.source_file_path = output_wav_path
      tl_item.source_start_frame = 0.0
      tl_item.source_end_frame = tl_item.end_frame - tl_item.start_frame
    end
  end
end

local function safe_get(tbl, ...)
  local current = tbl
  for i = 1, select('#', ...) do
    local key = select(i, ...)
    if type(current) ~= 'table' or current[key] == nil then
      return nil
    end
    current = current[key]
  end
  return current
end

-- =============================================================================
-- DATA GATHERING & PROCESSING
-- =============================================================================

---
-- Gathers all items of a specific type (video or audio) from the timeline.
-- @param track_type (string) The type of track to scan ("video" or "audio").
-- @param timeline (bmd.Timeline) The current timeline object.
-- @return (table) A list of timeline item tables.
--
local function get_items_by_tracktype(track_type, bmd_timeline)
  local items = {}
  local track_count = bmd_timeline:GetTrackCount(track_type)

  for i = 1, track_count do
    local track_items = bmd_timeline:GetItemListInTrack(track_type, i)
    if track_items then
      for _, item_bmd in ipairs(track_items) do
        local start_frame = tonumber(item_bmd:GetStart(true)) + 0.0
        local item_name = item_bmd:GetName()
        local media_pool_item = item_bmd:GetMediaPoolItem()
        local left_offset = tonumber(item_bmd:GetLeftOffset(true)) + 0.0
        local duration = tonumber(item_bmd:GetDuration(true)) + 0.0
        local source_start_float = left_offset
        local source_end_float = left_offset + duration

        local source_file_path = (media_pool_item and (media_pool_item:GetClipProperty("File Path") or "")) or ""

        local timeline_item = {
          bmd_item = item_bmd,
          bmd_mpi = media_pool_item,
          duration = 0, -- unused, therefore 0
          name = item_name,
          edit_instructions = {},
          start_frame = start_frame,
          end_frame = item_bmd:GetEnd(true),
          id = get_item_id(item_bmd, item_name, start_frame, track_type, i),
          track_type = track_type,
          track_index = i,
          source_file_path = source_file_path,
          processed_file_name = nil,
          source_start_frame = source_start_float,
          source_end_frame = source_end_float,
          source_channel = 0, -- Default value
          link_group_id = nil,
          type = json.null,
          nested_clips = {},
        }

        if media_pool_item and source_file_path == "" then
          local clip_type = media_pool_item:GetClipProperty("Type")
          print("Detected complex clip type: " .. tostring(clip_type) .. " for item: " .. item_name)
          timeline_item.type = clip_type
          timeline_item.nested_clips = {}
        end

        table.insert(items, timeline_item)
      end
    end
  end
  return items
end

-- Placeholder function, needs implementation.
local function export_timeline_to_otio(davinci_tl, file_path)
  if not resolve_obj then return end
  if not davinci_tl then
    print("No timeline to export.")
    return
  end
  -- In a real implementation, this would use Resolve's API to export the timeline.
  local success = davinci_tl:Export(file_path, resolve_obj.EXPORT_OTIO)
  if success then
    print("Timeline exported successfully to " .. file_path)
  else
    print("Failed to export timeline.")
  end
end


local function _create_nested_audio_item_from_otio(otio_clip, clip_start_in_container, max_duration)
  local media_refs = otio_clip.media_references
  if not media_refs then return nil end

  local active_media_key = otio_clip.active_media_reference_key or "DEFAULT_MEDIA"
  local media_ref = media_refs[active_media_key]

  if not media_ref or not media_ref.OTIO_SCHEMA or string.lower(media_ref.OTIO_SCHEMA):find("externalreference", 1, true) == nil then
    return nil
  end

  local source_path_uri = media_ref.target_url
  if not source_path_uri then return nil end

  local source_file_path
  if source_path_uri:sub(1, 7) == "file://" then
    source_file_path = source_path_uri:sub(8)
  else
    source_file_path = source_path_uri
  end

  local source_uuid = uuid_from_path(source_file_path)

  local source_range = otio_clip.source_range
  local available_range = media_ref.available_range
  if not source_range or not available_range then return nil end

  local clip_source_start_val = safe_get(source_range, "start_time", "value") or 0.0
  local media_available_start_val = safe_get(available_range, "start_time", "value") or 0.0

  local normalized_source_start_frame = clip_source_start_val - media_available_start_val
  local duration = safe_get(source_range, "duration", "value") or 0.0

  if max_duration and duration > max_duration then
    duration = max_duration
  end

  local source_channel = 0
  local processed_file_name = source_uuid .. ".wav"

  local resolve_meta = safe_get(otio_clip, "metadata", "Resolve_OTIO") or {}
  local channels_info = resolve_meta.Channels or {}

  if #channels_info == 1 then
    local channel_num = channels_info[1]["Source Track ID"]
    if type(channel_num) == 'number' and channel_num > 0 then
      source_channel = channel_num
      processed_file_name = source_uuid .. "_ch" .. tostring(source_channel) .. ".wav"
      print("OTIO parser: Found mapping for clip '" ..
        tostring(otio_clip.name) .. "' to source channel " .. tostring(source_channel))
    end
  end

  local nested_item = {
    source_file_path = source_file_path,
    processed_file_name = processed_file_name,
    source_channel = source_channel + 1,
    start_frame = clip_start_in_container,
    end_frame = clip_start_in_container + duration,
    source_start_frame = normalized_source_start_frame,
    source_end_frame = normalized_source_start_frame + duration,
    duration = duration,
    edit_instructions = {},
    nested_items = nil,
  }
  return nested_item
end

local _recursive_otio_parser -- Forward declaration
_recursive_otio_parser = function(otio_composable, active_angle_name, container_duration)
  local found_clips = {}

  for _, track in ipairs(otio_composable.children or {}) do
    if string.lower(track.kind or "") == "audio" then
      if not active_angle_name or track.name == active_angle_name then
        local playhead = 0.0
        for _, item_in_track in ipairs(track.children or {}) do
          if container_duration and playhead >= container_duration then break end

          local schema = string.lower(item_in_track.OTIO_SCHEMA or "")
          local item_duration = safe_get(item_in_track, "source_range", "duration", "value") or 0.0
          local effective_duration = item_duration

          if container_duration then
            local remaining_time = container_duration - playhead
            if item_duration > remaining_time then
              effective_duration = math.max(0, remaining_time)
            end
          end

          if schema:find("gap", 1, true) then
            playhead = playhead + item_duration
          elseif effective_duration > 0 then
            if schema:find("clip", 1, true) then
              local item = _create_nested_audio_item_from_otio(item_in_track, playhead, effective_duration)
              if item then table.insert(found_clips, item) end
            elseif schema:find("stack", 1, true) then
              local nested_clips = _recursive_otio_parser(item_in_track, active_angle_name, container_duration)
              for _, nested_clip in ipairs(nested_clips) do
                nested_clip.start_frame = nested_clip.start_frame + playhead
                nested_clip.end_frame = nested_clip.end_frame + playhead
                table.insert(found_clips, nested_clip)
              end
            end
            playhead = playhead + item_duration
          end
        end
      end
    end
  end
  return found_clips
end

local function populate_nested_clips(input_otio_path)
  if not project_data or not project_data.timeline then
    print("Cannot populate nested clips: project_data is not configured.")
    return
  end

  local f = io.open(input_otio_path, "r")
  if not f then
    print("Failed to read OTIO file: " .. input_otio_path)
    return
  end
  local otio_json_str = f:read("*a")
  f:close()

  local ok, otio_data = pcall(json.decode, otio_json_str)
  if not ok then
    print("Failed to parse OTIO JSON: " .. tostring(otio_data))
    return
  end

  local pd_timeline = project_data.timeline
  local all_pd_items = {}
  for _, item in ipairs(pd_timeline.video_track_items or {}) do table.insert(all_pd_items, item) end
  for _, item in ipairs(pd_timeline.audio_track_items or {}) do table.insert(all_pd_items, item) end

  local timeline_start_frame = safe_get(otio_data, "global_start_time", "value") or 0.0
  local FRAME_MATCH_TOLERANCE = 0.5
  local audio_track_counter = 0

  for _, track in ipairs(safe_get(otio_data, "tracks", "children") or {}) do
    if string.lower(track.kind or "") == "audio" then
      audio_track_counter = audio_track_counter + 1
      local current_track_index = audio_track_counter
      local playhead_frames = 0

      for _, item in ipairs(track.children or {}) do
        local duration_val = safe_get(item, "source_range", "duration", "value") or 0.0
        local item_schema = string.lower(item.OTIO_SCHEMA or "")

        if item_schema:find("gap", 1, true) then
          playhead_frames = playhead_frames + duration_val
        elseif item_schema:find("stack", 1, true) then
          local container_duration = duration_val
          local resolve_meta = safe_get(item, "metadata", "Resolve_OTIO") or {}
          local sequence_type = resolve_meta["Sequence Type"]
          local active_angle_name = nil

          if sequence_type == "Multicam Clip" then
            local item_name = item.name or ""
            active_angle_name = string.match(item_name, "Angle %d+")
            if active_angle_name then
              print("Detected Multicam clip. Active audio angle: '" .. active_angle_name .. "'")
            else
              print("Could not parse active angle from Multicam name: '" .. item_name .. "'.")
            end
          end

          local nested_clips_for_this_instance = _recursive_otio_parser(item, active_angle_name, container_duration)

          if #nested_clips_for_this_instance > 0 then
            local record_frame_float = playhead_frames + timeline_start_frame
            local otio_item_name = item.name

            local corresponding_pd_items = {}
            for _, pd_item in ipairs(all_pd_items) do
              if pd_item.type and pd_item.track_index == current_track_index and
                  math.abs((pd_item.start_frame or -1) - record_frame_float) < FRAME_MATCH_TOLERANCE and
                  pd_item.name == otio_item_name then
                table.insert(corresponding_pd_items, pd_item)
              end
            end

            if #corresponding_pd_items == 0 then
              print("Could not find corresponding project item for OTIO stack '" ..
                tostring(otio_item_name) .. "' on track " .. tostring(current_track_index))
            end

            for _, pd_item in ipairs(corresponding_pd_items) do
              pd_item.nested_clips = nested_clips_for_this_instance
            end
          end
          playhead_frames = playhead_frames + duration_val
        else
          playhead_frames = playhead_frames + duration_val
        end
      end
    end
  end
end


---
-- Gathers and processes all required data from the current project and timeline.
-- @param project (bmd.Project) The current project object.
-- @param timeline (bmd.Timeline) The current timeline object.
-- @return (boolean, string|nil) A tuple of success status and an optional error message.
--
local function get_project_data(bmd_project, bmd_timeline)
  -- --- 1. Initial Data Gathering ---
  local audio_track_items = get_items_by_tracktype("audio", bmd_timeline)
  local video_track_items = get_items_by_tracktype("video", bmd_timeline)


  project_data = {
    project_name = bmd_project:GetName(),
    timeline = {
      name = bmd_timeline:GetName(),
      fps = bmd_timeline:GetSetting("timelineFrameRate"),
      start_timecode = bmd_timeline:GetStartTimecode(),
      curr_timecode = bmd_timeline:GetCurrentTimecode(),
      video_track_items = video_track_items,
      audio_track_items = audio_track_items,
    },
    files = {},
  }

  local has_complex_clips = false
  for _, item in ipairs(audio_track_items) do
    if item.type then
      has_complex_clips = true
      break
    end
  end

  if has_complex_clips then
    print("Complex clips found. Analyzing timeline structure with OTIO...")
    local input_otio_path = TEMP_DIR .. "/temp-timeline.otio"
    export_timeline_to_otio(bmd_timeline, input_otio_path)
    populate_nested_clips(input_otio_path) -- This should populate project_data
  end



  -- --- 2. Analyze Mappings & Define Streams ---
  print("Analyzing timeline items and audio channel mappings...")
  for _, item in ipairs(audio_track_items) do
    if item.source_file_path and item.source_file_path ~= "" and item.type == json.null then
      -- This is the crucial step to correctly classify normal clips
      -- item.type = nil

      local source_uuid = uuid_from_path(item.source_file_path)
      item.source_channel = 0 -- Default
      item.processed_file_name = source_uuid .. ".wav"

      local success, mapping_str = pcall(function() return item.bmd_item:GetSourceAudioChannelMapping() end)
      if success and mapping_str and mapping_str ~= "" then
        local ok, mapping = pcall(json.decode, mapping_str)
        if ok and mapping then
          local clip_track_map = mapping.track_mapping and mapping.track_mapping["1"] or {}
          local clip_type = clip_track_map.type
          local channel_indices = clip_track_map.channel_idx or {}

          if clip_type and string.lower(clip_type) == "mono" and #channel_indices == 1 then
            local channel_num = channel_indices[1]
            print("Detected clip '" .. item.name .. "' using specific source channel: " .. channel_num)
            item.source_channel = channel_num
            item.processed_file_name = source_uuid .. "_ch" .. channel_num .. ".wav"
          end
        end
      else
        print("Warning: Could not get audio mapping for '" ..
          item.name .. "'. Defaulting to mono mixdown. Error: " .. tostring(mapping_str))
      end
    end
  end

  -- --- 3. Populate the 'files' map ---
  for _, item in ipairs(audio_track_items) do
    local source_path = item.source_file_path
    if source_path and source_path ~= "" then
      if not project_data.files[source_path] then
        project_data.files[source_path] = {
          properties = { FPS = project_data.timeline.fps },
          processed_audio_path = "",
          timelineItems = {},
          fileSource = {
            file_path = source_path,
            uuid = uuid_from_path(source_path),
            bmd_media_pool_item = item.bmd_mpi,
          },
          silenceDetections = json.null,
        }
      end
    end
  end

  -- --- 4. Handle Compound Clips ---
  if has_complex_clips then
    print("Processing complex clips...")
    mixdown_compound_clips(audio_track_items, {})
  end

  return true, nil
end

-- =============================================================================
-- EDIT UNIFICATION LOGIC (from Python)
-- =============================================================================



---
-- Unifies edit instructions for a group of linked items.
-- This is a Lua translation of the Python `unify_edit_instructions` function.
-- @param items (table) A list of linked timeline items.
-- @return (table) A list of unified edit instruction tables.
--
local function unify_edit_instructions(items)
  local has_any_edits = false
  for _, item in ipairs(items) do
    if item.edit_instructions and #item.edit_instructions > 0 then
      has_any_edits = true
      break
    end
  end
  if not has_any_edits then
    return { { 0.0, nil, true } }
  end

  local events = {}
  for _, item in ipairs(items) do
    if item.edit_instructions then
      local base = item.source_start_frame or 0.0
      for _, edit in ipairs(item.edit_instructions) do
        if edit.source_start_frame and edit.source_end_frame then
          local rel_start = edit.source_start_frame - base
          local rel_end = edit.source_end_frame - base
          local is_enabled = edit.enabled == nil or edit.enabled == true
          table.insert(events, { frame = rel_start, type = 1, enabled = is_enabled })
          table.insert(events, { frame = rel_end, type = -1, enabled = is_enabled })
        end
      end
    end
  end

  if #events == 0 then return {} end

  table.sort(events, function(a, b)
    if a.frame == b.frame then return a.type > b.type end
    return a.frame < b.frame
  end)

  local merged_segments = {}
  local active_enabled_count = 0
  local active_disabled_count = 0
  local last_frame = events[1].frame

  for _, event in ipairs(events) do
    local frame, type_val, is_enabled = event.frame, event.type, event.enabled
    local segment_duration = frame - last_frame
    if segment_duration > 0 then
      local is_segment_enabled = active_enabled_count > 0
      local is_segment_active = active_enabled_count > 0 or active_disabled_count > 0
      if is_segment_active then
        table.insert(merged_segments, { start_frame = last_frame, end_frame = frame, enabled = is_segment_enabled })
      end
    end

    if type_val == 1 then -- Start
      if is_enabled then
        active_enabled_count = active_enabled_count + 1
      else
        active_disabled_count = active_disabled_count + 1
      end
    else -- End
      if is_enabled then
        active_enabled_count = active_enabled_count - 1
      else
        active_disabled_count = active_disabled_count - 1
      end
    end
    last_frame = frame
  end

  if #merged_segments == 0 then return {} end

  local final_edits = {}
  if #merged_segments > 0 then
    local current_edit = merged_segments[1]
    table.insert(final_edits, current_edit)

    for i = 2, #merged_segments do
      local next_edit = merged_segments[i]
      if next_edit.start_frame == current_edit.end_frame and next_edit.enabled == current_edit.enabled then
        current_edit.end_frame = next_edit.end_frame -- Merge
      else
        current_edit = next_edit
        table.insert(final_edits, current_edit)
      end
    end
  end


  local filtered_edits = {}
  for _, edit in ipairs(final_edits) do
    if (edit.end_frame - edit.start_frame) >= 1.0 then
      table.insert(filtered_edits, { edit.start_frame, edit.end_frame, edit.enabled })
    end
  end

  return filtered_edits
end

local function find_closest_match(pd_items, record_frame, duration_val, track_index, frame_tolerance, search_range)
  frame_tolerance = frame_tolerance or 0.5
  search_range = search_range or 5

  local best_match = nil
  local best_distance = math.huge

  for offset = -search_range, search_range do
    local frame_try = record_frame + offset
    for _, item in ipairs(pd_items) do
      if item.track_index == track_index then
        local frame_diff = math.abs((item.start_frame or -1) - frame_try)
        local duration_diff = math.abs((item.duration or -1) - duration_val)

        if frame_diff < frame_tolerance and duration_diff < frame_tolerance then
          return { item } -- Early return on valid match
        end

        local distance = frame_diff + duration_diff
        if distance < best_distance then
          best_distance = distance
          best_match = item
        end
      end
    end
  end

  if best_match then
    return { best_match }
  end
  return {}
end

local function process_track_items(otio_items, pd_timeline, pd_timeline_key, track_index, timeline_start_frame, max_id)
  local playhead_frames = 0.0

  for _, item in ipairs(otio_items) do
    if item then
      local item_schema = string.lower(safe_get(item, "OTIO_SCHEMA") or "")
      local duration_val = safe_get(item, "source_range", "duration", "value") or 0

      if string.find(item_schema, "gap") then
        playhead_frames = playhead_frames + duration_val
      elseif string.find(item_schema, "clip") or string.find(item_schema, "stack") then
        local record_frame_float = playhead_frames + timeline_start_frame

        local corresponding_items = find_closest_match(
          pd_timeline[pd_timeline_key] or {},
          record_frame_float,
          duration_val,
          track_index
        )

        if #corresponding_items == 0 then
          print("Warning: Could not find a corresponding project item for OTIO item at frame " ..
            tostring(record_frame_float) .. " on track " .. tostring(track_index))
        else
          local link_group_id = safe_get(item, "metadata", "Resolve_OTIO", "Link Group ID")
          print("Processing item '" .. tostring(item.name) .. "' on track " .. tostring(track_index) ..
            " with link group ID: " .. tostring(link_group_id))

          if link_group_id then
            for _, corresponding_item in ipairs(corresponding_items) do
              corresponding_item.link_group_id = link_group_id
            end
            max_id = math.max(max_id, link_group_id)
          end
        end
        playhead_frames = playhead_frames + duration_val
      end
    end
  end
  return max_id
end

---
-- Reads an OTIO file, finds linked clips, unifies their edits, and updates project_data.
-- Lua translation of `unify_linked_items_in_project_data`.
-- @param input_otio_path (string) Path to the OTIO JSON file.
--
local function unify_linked_items_in_project_data(input_otio_path)
  if not project_data or not project_data.timeline then
    print("Could not find project data to unify.")
    return
  end

  local f = io.open(input_otio_path, "r")
  if not f then
    print("Failed to open OTIO file: " .. input_otio_path)
    return
  end
  local otio_json_str = f:read("*a")
  f:close()

  local ok, otio_data = pcall(json.decode, otio_json_str)
  if not ok then
    print("Failed to parse OTIO JSON: " .. tostring(otio_data))
    return
  end

  local pd_timeline = project_data.timeline
  local max_link_group_id = 0
  local track_type_counters = { video = 0, audio = 0 }
  local timeline_start_frame = safe_get(otio_data, "global_start_time", "value") or 0.0

  local otio_tracks = safe_get(otio_data, "tracks", "children") or {}
  for _, track in ipairs(otio_tracks) do
    local kind = string.lower(safe_get(track, "kind") or "")
    if track_type_counters[kind] then
      track_type_counters[kind] = track_type_counters[kind] + 1
      local current_track_index = track_type_counters[kind]
      local pd_key = kind .. "_track_items"
      max_link_group_id = process_track_items(
        safe_get(track, "children") or {},
        pd_timeline,
        pd_key,
        current_track_index,
        timeline_start_frame,
        max_link_group_id
      )
    end
  end

  local all_pd_items = {}
  for _, item in ipairs(pd_timeline.video_track_items) do table.insert(all_pd_items, item) end
  for _, item in ipairs(pd_timeline.audio_track_items) do table.insert(all_pd_items, item) end

  local items_by_link_group = {}
  local next_new_group_id = max_link_group_id + 1
  for _, item in ipairs(all_pd_items) do
    if item.link_group_id == nil and item.edit_instructions and #item.edit_instructions > 0 then
      item.link_group_id = next_new_group_id
      next_new_group_id = next_new_group_id + 1
    end
    if item.link_group_id then
      if not items_by_link_group[item.link_group_id] then
        items_by_link_group[item.link_group_id] = {}
      end
      table.insert(items_by_link_group[item.link_group_id], item)
    end
  end

  for link_id, group_items in pairs(items_by_link_group) do
    local unified_edits = unify_edit_instructions(group_items)
    local group_timeline_anchor = math.huge
    for _, item in ipairs(group_items) do
      group_timeline_anchor = math.min(group_timeline_anchor, item.start_frame)
    end

    if group_timeline_anchor ~= math.huge then
      for _, item in ipairs(group_items) do
        local item_duration = item.end_frame - item.start_frame
        local is_effectively_uncut = false
        if #unified_edits == 1 then
          local edit_start, edit_end, _ = unified_edits[1][1], unified_edits[1][2], unified_edits[1][3]
          if edit_end and edit_start == 0.0 and math.abs(edit_end - item_duration) < 0.01 then
            is_effectively_uncut = true
          end
        end

        local new_edit_instructions = {}
        local base_source_offset = item.source_start_frame

        if is_effectively_uncut then
          local original_edit = (item.edit_instructions and #item.edit_instructions > 0) and item.edit_instructions[1] or
              {}
          table.insert(new_edit_instructions, {
            source_start_frame = item.source_start_frame,
            source_end_frame = item.source_end_frame,
            start_frame = item.start_frame,
            end_frame = item.end_frame,
            enabled = original_edit.enabled == nil or original_edit.enabled == true
          })
        else
          local timeline_playhead = math.floor(group_timeline_anchor + 0.5)
          for _, unified_edit in ipairs(unified_edits) do
            local rel_start, rel_end, is_enabled = unified_edit[1], unified_edit[2], unified_edit[3]
            local source_duration
            if rel_end == nil then
              source_duration = item.source_end_frame - item.source_start_frame
            else
              source_duration = rel_end - rel_start
            end
            local timeline_duration = math.floor(source_duration + 0.5)

            if timeline_duration >= 1 then
              local source_start = base_source_offset + rel_start
              local source_end = source_start + source_duration
              local timeline_start = timeline_playhead
              local timeline_end = timeline_playhead + timeline_duration

              table.insert(new_edit_instructions, {
                source_start_frame = source_start,
                source_end_frame = source_end,
                start_frame = timeline_start,
                end_frame = timeline_end,
                enabled = is_enabled
              })
              timeline_playhead = timeline_end
            end
          end
        end
        item.edit_instructions = new_edit_instructions
      end
    end
  end
  print("Finished unifying linked item edits.")
end

-- =============================================================================
-- FINAL TIMELINE CREATION
-- =============================================================================
---
-- Applies 'edit_instructions' from a source project data (from Go) to the target (local).
-- @param target_project (table) The local project_data table.
-- @param source_project (table) The project_data table received from Go.
-- @return (table) The modified target_project table.
--
local function apply_edits_from_go(target_project, source_project)
  print("Applying edit instructions from Go...")
  local source_audio_items = source_project.timeline and source_project.timeline.audio_track_items or {}
  local source_items_by_id = {}
  for _, item in ipairs(source_audio_items) do
    if item.id then
      source_items_by_id[item.id] = item
    end
  end

  if not next(source_items_by_id) then
    print("Warning: No audio items with IDs found in data from Go. No edits applied.")
    return target_project
  end

  local target_audio_items = target_project.timeline and target_project.timeline.audio_track_items or {}
  local target_video_items = target_project.timeline and target_project.timeline.video_track_items or {}
  local all_target_items = {}
  for _, i in ipairs(target_audio_items) do table.insert(all_target_items, i) end
  for _, i in ipairs(target_video_items) do table.insert(all_target_items, i) end


  local items_updated_count = 0
  for _, target_item in ipairs(all_target_items) do
    if target_item.id and source_items_by_id[target_item.id] then
      local source_item = source_items_by_id[target_item.id]
      if source_item.edit_instructions then
        target_item.edit_instructions = source_item.edit_instructions
        items_updated_count = items_updated_count + 1
      end
    end
  end

  print("Finished applying edits. Updated " .. items_updated_count .. " timeline items.")
  return target_project
end

---
-- Verifies that the clips on the timeline match the expected state.
-- @param bmd_timeline (bmd.Timeline) The DaVinci Resolve timeline object.
-- @param expected_clips (table) A list of clip info tables that were intended to be appended.
-- @return (boolean) True if the timeline state is correct, false otherwise.
--
local function _verify_timeline_state(bmd_timeline, expected_clips)
  print("Verifying timeline state...")
  -- Build a "checklist" of expected cuts. Key: "mediaType-trackIndex-recordFrame"
  local expected_cuts = {}
  for _, clip in ipairs(expected_clips) do
    local key = table.concat({ tostring(clip.mediaType), tostring(clip.trackIndex), tostring(clip.recordFrame) }, "-")
    expected_cuts[key] = (expected_cuts[key] or 0) + 1
  end

  -- Get actual clips and "check them off" the list
  local actual_video_items = get_items_by_tracktype("video", bmd_timeline)
  local actual_audio_items = get_items_by_tracktype("audio", bmd_timeline)
  local all_actual_items = {}
  for _, item in ipairs(actual_video_items) do table.insert(all_actual_items, item) end
  for _, item in ipairs(actual_audio_items) do table.insert(all_actual_items, item) end

  for _, item in ipairs(all_actual_items) do
    local media_type = item.track_type == "video" and 1 or 2
    local key = table.concat(
      { tostring(media_type), tostring(item.track_index), tostring(math.floor(item.start_frame + 0.5)) }, "-")
    if expected_cuts[key] then
      expected_cuts[key] = expected_cuts[key] - 1
    end
  end

  -- Check if any expected cuts are "left over"
  local missing_cuts = false
  for key, count in pairs(expected_cuts) do
    if count > 0 then
      print("  - Verification FAILED. Missing clip: " .. key .. " (count: " .. count .. ")")
      missing_cuts = true
    end
  end

  if not missing_cuts then
    print("  - Verification successful. All expected clips were found.")
    return true
  end
  return false
end

---
-- Prepares a batch of clips for the AppendToTimeline API call and groups them by link key.
-- @param timeline_items (table) The list of all timeline items from project_data.
-- @return (table, table) A tuple containing the list of API-ready clip info and the list of all processed clips with metadata.
--
local function _prepare_clips_for_append(timeline_items)
  local grouped_clips = {}

  for _, item in ipairs(timeline_items) do
    local link_id = item.link_group_id
    if link_id then
      local media_type = item.track_type == "video" and 1 or 2
      for i, edit in ipairs(item.edit_instructions or {}) do
        local record_frame = math.floor(edit.start_frame + 0.5)
        local end_frame = math.floor(edit.end_frame + 0.5)
        local duration_frames = end_frame - record_frame

        if duration_frames >= 1 then
          if not item.bmd_mpi then
            item.bmd_mpi = item.bmd_item:GetMediaPoolItem()
          end

          local clip_info_for_api = {
            mediaPoolItem = item.bmd_mpi,
            startFrame = edit.source_start_frame,
            endFrame = edit.source_start_frame + duration_frames,
            recordFrame = record_frame,
            trackIndex = item.track_index,
            mediaType = media_type,
          }
          local link_key = tostring(link_id) .. "-" .. tostring(i)
          local appended_clip = {
            clip_info = clip_info_for_api,
            link_key = link_key,
            enabled = edit.enabled == nil or edit.enabled == true,
            auto_linked = false,
          }

          if not grouped_clips[link_key] then
            grouped_clips[link_key] = {}
          end
          table.insert(grouped_clips[link_key], appended_clip)
        end
      end
    end
  end

  local final_api_batch = {}
  local all_processed_clips = {}

  for link_key, group in pairs(grouped_clips) do
    local is_optimizable = false
    if #group == 2 then
      local clip1, clip2 = group[1], group[2]
      local mpi1 = clip1.clip_info.mediaPoolItem
      local mpi2 = clip2.clip_info.mediaPoolItem
      local path1 = mpi1 and mpi1:GetClipProperty("File Path") or nil
      local path2 = mpi2 and mpi2:GetClipProperty("File Path") or nil

      local media_types = {}
      for _, c in ipairs(group) do media_types[c.clip_info.mediaType] = true end

      if media_types[1] and media_types[2] and clip1.clip_info.trackIndex == 1 and clip2.clip_info.trackIndex == 1 and
          (path1 and path1 == path2) then
        is_optimizable = true
      end
    end

    if is_optimizable then
      print("Optimizing append for link group " .. link_key .. " on Track 1.")
      for _, clip in ipairs(group) do
        clip.auto_linked = true
      end
      local optimized_clip_info = {}
      for k, v in pairs(group[1].clip_info) do optimized_clip_info[k] = v end
      optimized_clip_info.mediaType = nil
      optimized_clip_info.trackIndex = nil
      table.insert(final_api_batch, optimized_clip_info)
    else
      for _, clip in ipairs(group) do
        table.insert(final_api_batch, clip.clip_info)
      end
    end

    for _, clip in ipairs(group) do
      table.insert(all_processed_clips, clip)
    end
  end

  table.sort(all_processed_clips, function(a, b)
    return a.clip_info.recordFrame < b.clip_info.recordFrame
  end)

  return final_api_batch, all_processed_clips
end

--[[
NOTE: Place these new/updated functions into your existing Lua script.
You will need to replace the original `append_and_link_timeline_items`
and its related helpers with these versions.
--]]

---
-- Checks if a clip is "uncut", meaning its edit instructions represent the
-- entire, original clip segment on the timeline.
-- This is a direct port of the Python helper function.
-- @param item (table) The timeline item to check.
-- @return (boolean) True if the item is uncut, false otherwise.
--
local function clip_is_uncut(item)
  if not item.edit_instructions or #item.edit_instructions == 0 then
    return true
  end

  if #item.edit_instructions > 1 then
    return false
  end

  -- Check if the only edit instruction is for the full clip
  local edit = item.edit_instructions[1]
  local TOLERANCE = 0.01

  if math.abs(edit.start_frame - item.start_frame) < TOLERANCE and
      math.abs(edit.end_frame - item.end_frame) < TOLERANCE and
      math.abs(edit.source_start_frame - item.source_start_frame) < TOLERANCE and
      math.abs(edit.source_end_frame - item.source_end_frame) < TOLERANCE then
    return true
  end

  return false
end


---
-- Groups clips, prepares a SINGLE batch of instructions for the API with a
-- mix of optimized (auto-linked) and standard clips, then makes one API call.
-- This is a direct port of the Python `_append_clips_to_timeline` helper.
-- @param timeline (bmd.Timeline) The target timeline object.
-- @param media_pool (bmd.MediaPool) The media pool object.
-- @param timeline_items (table) A list of all timeline items to process.
-- @return (table, table) A tuple: (all_processed_clips, appended_bmd_items_from_api)
--
local function _append_clips_to_timeline(timeline, media_pool, timeline_items)
  local grouped_clips = {}

  for _, item in ipairs(timeline_items) do
    local link_id = item.link_group_id
    if link_id then
      local media_type = item.track_type == "video" and 1 or 2
      for i, edit in ipairs(item.edit_instructions or {}) do
        local record_frame = math.floor((edit.start_frame or 0) + 0.5)
        local end_frame = math.floor((edit.end_frame or 0) + 0.5)
        local duration_frames = end_frame - record_frame

        if duration_frames >= 1 then
          local source_start = edit.source_start_frame or 0
          local source_end = source_start + duration_frames

          if not item.bmd_mpi then
            item.bmd_mpi = item.bmd_item:GetMediaPoolItem()
          end

          local clip_info_for_api = {
            mediaPoolItem = item.bmd_mpi,
            startFrame = source_start,
            endFrame = source_end,
            recordFrame = record_frame,
            trackIndex = item.track_index,
            mediaType = media_type,
          }
          local link_key = tostring(link_id) .. "-" .. tostring(i) -- Lua uses string keys
          local appended_clip = {
            clip_info = clip_info_for_api,
            link_key = link_key,
            enabled = edit.enabled == nil or edit.enabled,
            auto_linked = false,
          }
          if not grouped_clips[link_key] then grouped_clips[link_key] = {} end
          table.insert(grouped_clips[link_key], appended_clip)
        end
      end
    end
  end

  if not next(grouped_clips) then
    return {}, {}
  end

  local final_api_batch = {}
  local all_processed_clips = {}

  for link_key, group in pairs(grouped_clips) do
    local is_optimizable = false
    if #group == 2 then
      local clip1, clip2 = group[1], group[2]
      local mpi1 = clip1.clip_info.mediaPoolItem
      local mpi2 = clip2.clip_info.mediaPoolItem
      local path1 = mpi1 and mpi1:GetClipProperty("File Path") or nil
      local path2 = mpi2 and mpi2:GetClipProperty("File Path") or nil

      local media_types = {}
      media_types[clip1.clip_info.mediaType] = true
      media_types[clip2.clip_info.mediaType] = true

      if media_types[1] and media_types[2] and clip1.clip_info.trackIndex == 1 and clip2.clip_info.trackIndex == 1 and (path1 and path1 == path2) then
        is_optimizable = true
      end
    end

    if is_optimizable then
      print("Optimizing append for link group " .. link_key .. " on Track 1.")
      for _, clip in ipairs(group) do clip.auto_linked = true end
      -- Create a shallow copy for the optimized clip
      local optimized_clip_info = {}
      for k, v in pairs(group[1].clip_info) do optimized_clip_info[k] = v end
      optimized_clip_info.mediaType = nil
      optimized_clip_info.trackIndex = nil
      table.insert(final_api_batch, optimized_clip_info)
    else
      for _, clip in ipairs(group) do table.insert(final_api_batch, clip.clip_info) end
    end
    for _, clip in ipairs(group) do table.insert(all_processed_clips, clip) end
  end

  table.sort(all_processed_clips, function(a, b) return a.clip_info.recordFrame < b.clip_info.recordFrame end)

  print("Appending " .. #final_api_batch .. " total clip instructions to timeline...")
  local BATCH_SIZE = 100
  local appended_bmd_items = {}
  for i = 1, #final_api_batch, BATCH_SIZE do
    local chunk = {}
    for j = i, math.min(i + BATCH_SIZE - 1, #final_api_batch) do
      table.insert(chunk, final_api_batch[j])
    end
    local appended = media_pool:AppendToTimeline(chunk) or {}
    for _, item in ipairs(appended) do table.insert(appended_bmd_items, item) end
  end

  return all_processed_clips, appended_bmd_items
end


---
-- Appends clips to the timeline, using an optimized auto-linking method where
-- possible, and then manually links any remaining clips.
-- THIS IS THE REFACTORED VERSION TO MATCH PYTHON.
--
function append_and_link_timeline_items(create_new, task_id)
  if not project_data or not project_data.timeline then
    print("Error: Project data is missing or malformed.")
    return
  end

  if not project then
    print("Error: Could not get current project.")
    return
  end

  media_pool = project:GetMediaPool()
  if not media_pool then
    print("Error: MediaPool object not available.")
    return
  end

  local timeline_items = {}
  for _, item in ipairs(project_data.timeline.video_track_items or {}) do table.insert(timeline_items, item) end
  for _, item in ipairs(project_data.timeline.audio_track_items or {}) do table.insert(timeline_items, item) end

  local max_indices = { video = 0, audio = 0 }
  for _, item in ipairs(timeline_items) do
    max_indices[item.track_type] = math.max(max_indices[item.track_type], item.track_index)
  end
  local og_tl_name = project_data.timeline.name

  local target_timeline
  if create_new then
    print("Creating a new timeline...")
    created_timelines[og_tl_name] = (created_timelines[og_tl_name] or 0)
    local retries = 0
    repeat
      local index = created_timelines[og_tl_name] + 1
      local timeline_name = string.format("%s-hc-%02d", og_tl_name, index)
      target_timeline = media_pool:CreateEmptyTimeline(timeline_name)
      created_timelines[og_tl_name] = index
      retries = retries + 1
    until target_timeline or retries >= MAX_RETRIES
    if not target_timeline then
      send_result_with_alert("DaVinci Error", "Could not create new timeline after " .. MAX_RETRIES .. " attempts.",
        task_id)
      return
    end
    target_timeline:SetStartTimecode(project_data.timeline.start_timecode)
  else
    target_timeline = timeline
    -- --- FIX: Robustly clear only relevant clips from the existing timeline ---
    print("Clearing edited clips from existing timeline...")
    local all_clips_to_delete = {}

    for _, item in ipairs(timeline_items) do
      if not item.bmd_item then
        print("Warning: BMD item missing for " .. item.name)
      elseif not clip_is_uncut(item) then
        print("Marking edited item '" .. item.name .. "' for deletion.")
        table.insert(all_clips_to_delete, item.bmd_item)
      else
        print("Skipping uncut item '" .. item.name .. "'.")
      end
    end

    if #all_clips_to_delete > 0 then
      print("Deleting " .. #all_clips_to_delete .. " existing clips...")
      target_timeline:DeleteClips(all_clips_to_delete, false)
    else
      print("No clips marked for deletion.")
    end
  end

  if not target_timeline then
    print("Error: Could not get a valid timeline. Aborting operation.")
    return
  end

  project:SetCurrentTimeline(target_timeline)
  timeline = target_timeline -- Update global reference

  for track_type, required_count in pairs(max_indices) do
    local tracks_to_add = required_count - target_timeline:GetTrackCount(track_type)
    if tracks_to_add > 0 then
      print("Timeline has " ..
        target_timeline:GetTrackCount(track_type) ..
        " " .. track_type .. " tracks, adding " .. tracks_to_add .. " more...")
      for _ = 1, tracks_to_add do target_timeline:AddTrack(track_type) end
    end
  end

  print("Operating on timeline: '" .. target_timeline:GetName() .. "'")

  -- === STEP 4: APPEND, VERIFY, AND LINK CLIPS (RETRY LOOP) ===
  local success = false
  local num_retries = 4
  for attempt = 1, num_retries do
    local processed_clips, bmd_items_from_api = _append_clips_to_timeline(target_timeline, media_pool, timeline_items)

    if #processed_clips == 0 then
      success = true
      break
    end

    local expected_clip_infos = {}
    for _, p_clip in ipairs(processed_clips) do table.insert(expected_clip_infos, p_clip.clip_info) end

    if _verify_timeline_state(target_timeline, expected_clip_infos) then
      print("Verification successful. Proceeding to modify and link.")

      local auto_linked_keys = {}
      for _, clip in ipairs(processed_clips) do
        if clip.auto_linked then auto_linked_keys[clip.link_key] = true end
      end

      local link_key_lookup = {}
      for _, appended_clip in ipairs(processed_clips) do
        local info = appended_clip.clip_info
        local lookup_key = table.concat({ info.mediaType, info.trackIndex, info.recordFrame }, "-")
        link_key_lookup[lookup_key] = appended_clip.link_key
      end

      local actual_items_video = get_items_by_tracktype("video", target_timeline)
      local actual_items_audio = get_items_by_tracktype("audio", target_timeline)
      local actual_items = {}
      for _, item in ipairs(actual_items_video) do table.insert(actual_items, item) end
      for _, item in ipairs(actual_items_audio) do table.insert(actual_items, item) end

      local disabled_keys = {}
      for _, p_clip in ipairs(processed_clips) do
        if not p_clip.enabled then
          local info = p_clip.clip_info
          local key = table.concat({ info.mediaType, info.trackIndex, info.recordFrame }, "-")
          disabled_keys[key] = true
        end
      end
      if next(disabled_keys) then
        for _, item_dict in ipairs(actual_items) do
          local media_type = item_dict.track_type == "video" and 1 or 2
          local key = table.concat({ media_type, item_dict.track_index, math.floor(item_dict.start_frame + 0.5) }, "-")
          if disabled_keys[key] then
            item_dict.bmd_item:SetClipColor("Violet")
          end
        end
      end

      local link_groups = {}
      for _, item_dict in ipairs(actual_items) do
        local media_type = item_dict.track_type == "video" and 1 or 2
        local lookup_key = table.concat({ media_type, item_dict.track_index, math.floor(item_dict.start_frame + 0.5) },
          "-")
        local link_key = link_key_lookup[lookup_key]

        if link_key then
          if not link_groups[link_key] then link_groups[link_key] = {} end
          table.insert(link_groups[link_key], item_dict.bmd_item)
        end
      end

      print("Performing manual linking for necessary clips...")
      for group_key, clips_to_link in pairs(link_groups) do
        if not auto_linked_keys[group_key] and #clips_to_link >= 2 then
          print("  - Manually linking group: " .. tostring(group_key))
          target_timeline:SetClipsLinked(clips_to_link, true)
        end
      end

      print("✅ Operation completed successfully.")
      success = true
      break
    else
      print("Attempt " .. attempt .. " failed verification. Rolling back changes...")
      if bmd_items_from_api and #bmd_items_from_api > 0 then
        target_timeline:DeleteClips(bmd_items_from_api, false)
      end
    end
  end

  if not success then
    print("❌ Operation failed after all retries. Please check the logs.")
    send_result_with_alert("Timeline Creation Failed",
      "Could not apply edits to the timeline after " .. num_retries .. " attempts.", task_id)
  else
    local response_payload = { status = "success", message = "Edit successful!" }
    send_message_to_go("taskResult", response_payload, task_id)
  end
end

--- @param sync boolean
--- @param task_id string|nil
local function main(sync, task_id)
  if not resolve_obj then
    resolve_obj = get_resolve()
  end

  if not resolve_obj then
    local alert_title = "Resolve Not Found"
    local alert_message = "This script must be run inside DaVinci Resolve."
    local alert_severity = "error"
    send_result_with_alert(alert_title, alert_message, task_id, alert_severity)
    return
  end

  pm = resolve_obj:GetProjectManager()
  if not pm then
    project = nil
    local alert_title = "DaVinci Resolve Error"
    local message = "Could not connect to DaVinci Resolve. Is it running?"
    send_result_with_alert(alert_title, message, task_id, "error")
    return
  end

  project = pm:GetCurrentProject()
  if not project then
    project_data = nil
    media_pool = nil
    timeline = nil
    local alert_title = "No open project"
    local alert_message = "Please open a project and a timeline."
    send_result_with_alert(alert_title, alert_message, task_id, "error")
    return
  end

  timeline = project:GetCurrentTimeline()
  if not timeline then
    project_data = nil
    local title = "No timeline"
    local msg = "Please open a timeline."
    send_result_with_alert(title, msg, task_id, "error")
    return
  end

  local input_otio_path = TEMP_DIR .. "/temp-timeline.otio"

  if sync or not project_data then
    print("syncing project data...")
    local success, err = get_project_data(project, timeline)
    if not success then
      local alert_title = "Project Data Error"
      local alert_message = "Failed to gather project data: " .. (err or "Unknown error")
      send_result_with_alert(alert_title, alert_message, task_id, "error")
      return
    end
    print("Project data gathered successfully.")
    -- Export the timeline to OTIO format
    export_timeline_to_otio(timeline, input_otio_path)

    if project_data then
      local payload = {
        status = "success",
        message = "sync successful!",
        data = project_data
      }
      send_message_to_go("taskResult", payload, task_id)
      return
    end
  end

  -- If not syncing, we are making the final timeline
  if not sync then
    -- This is the new step: unify the edits before creating the timeline
    unify_linked_items_in_project_data(input_otio_path)
    print("Proceeding to create final timeline...")
    append_and_link_timeline_items(make_new_timeline, task_id)
  end
end


local function set_timecode(time_value)
  if not resolve_obj then
    print("Resolve not found. Cannot set playhead.")
    return
  end

  if not timeline then
    print("No timeline found. Cannot set playhead.")
    return
  end

  local success = timeline:SetCurrentTimecode(time_value)
  if not success then
    print("Failed to set playhead to: " .. time_value)
    return false
  else
    print("Playhead set to: " .. time_value)
    return true
  end
end


if go_app_path and free_port then
  print("Found HushCut executable at: " .. go_app_path)
  print("Found free port: " .. free_port)

  local hushcut_command
  if os_type == "Linux" then
    hushcut_command = "GDK_BACKEND=x11 " .. quote(go_app_path) .. " --python-port=" .. free_port .. " &"
  else
    hushcut_command = quote(go_app_path) .. " --python-port=" .. free_port .. " &"
  end


  print("Starting HushCut app with command: " .. hushcut_command)
  os.execute(hushcut_command)

  local server_command = quote(go_script_path) .. " --port=" .. free_port .. " 2>&1"
  print("Starting http server with command: " .. server_command)
  local handle = io.popen(server_command)
  if not handle then
    print("Failed to start http server.")
    return
  end

  for line in handle:lines() do
    print("server output: " .. line)

    -- try to parse the line as JSON
    local json_data, pos, err = nil, nil, nil
    local params = nil
    local task_id = nil
    if line:find("Body: {") then
      local json_str = line:match("Body: (.*)")
      if json_str then
        json_data, pos, err = json.decode(json_str, 1, nil)
        if err then
          print("Error parsing JSON: " .. err)
        else
          -- print the parsed JSON data
          print("Parsed JSON data: " .. json.encode(json_data))
        end
      else
        print("No JSON found in line: " .. line)
      end
    end

    if json_data then
      params = json_data.params
      if not params then
        print("No params found in JSON data.")
      else
        print("Params found in JSON data: " .. json.encode(params))
      end
    end

    if params and params.taskId then
      task_id = params.taskId
    end

    if json_data and json_data.go_server_port then
      print("Register endpoint called.")
      go_server_port = json_data.go_server_port
      print("Go server port detected: " .. go_server_port)
    elseif json_data and json_data.command then
      local command = json_data.command
      print("Command detected: " .. command)
      if command == "sync" then
        main(true, task_id)
      elseif command == "makeFinalTimeline" then
        print("Make final timeline command detected.")
        if params and params.projectData then
          if project_data then
            project_data = apply_edits_from_go(project_data, params.projectData)
          else
            -- If there's no local project data, we can't apply edits.
            -- A sync should happen first.
            send_result_with_alert("Sync Required", "Please sync with the timeline before applying edits.", task_id)
          end
          make_new_timeline = params.makeNewTimeline or false
          print("Creating final timeline with makeNewTimeline = " .. tostring(make_new_timeline))
          main(false, task_id) -- Call main to execute the timeline creation
        else
          send_result_with_alert("Data Error", "makeFinalTimeline command received without projectData.", task_id)
        end
      elseif command == "saveProject" then
        if project then
          pm:SaveProject()
          print("Project saved.")
          send_message_to_go("taskResult", { status = "success", message = "Project saved!" }, task_id)
        else
          send_result_with_alert("Error", "No project is open to save.", task_id)
        end
      elseif command == "setPlayhead" then
        if params then
          local time_value = params.time
          if time_value and set_timecode(time_value) then
            print("Setting playhead to: " .. time_value)
            local payload = {
              status = "success",
              message = "Playhead set to " .. time_value,
            }
            -- #TODO: send ack or result to Go afterwards (ack doesn't work atm because it's not the same http request)
            -- send_message_to_go("taskResult", payload, task_id)
          end
        end
      end
    end
  end

  -- This code will be executed *after* the Go process has shut down.
  print("Go http server has shut down. Exiting Lua script.")

  -- Closing the handle is good practice. It also returns the process status.
  handle:close()

  -- os.exit() is now redundant, as the script is at its end.
  -- However, you can call it explicitly if you have more logic below.
  os.exit(0)
elseif not go_app_path then
  print("HushCut executable not found.")
else
  print("Could not find a free port.")
end
