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

local go_server_port = nil
local script_path = debug.getinfo(1, "S").source:sub(2)
local script_dir = script_path:gsub("[^/\\]+$", "")
local TEMP_DIR = script_dir .. "temp"


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

  --json_payload = json_payload:gsub("'", "'\\''")
  -- local escaped_payload = json_payload:gsub('"', '\\"')
  -- local command = string.format(
  --   'curl -s -X POST -H "Content-Type: application/json" -d "%s" "%s" -w "\\n%%{http_code}"',
  --   escaped_payload,
  --   url
  -- )

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
  local handle = io.popen(go_script_path .. " --find-port")
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
    return nil
  end
end



local go_script_path = script_dir .. "lua-go-http"
local free_port = find_free_port(go_script_path)



---@diagnostic disable-next-line: undefined-global
local resolve = get_resolve()
if not resolve then
  print("Lua Error: Resolve object not found. Ensure this script is run inside DaVinci Resolve.")
  return
end
local pm = nil
local project = nil
local media_pool = nil
local timeline = nil



if resolve then
  pm = resolve:GetProjectManager()
  if pm then
    project = pm:GetCurrentProject()
    if project then
      media_pool = project:GetMediaPool()
      timeline = project:GetCurrentTimeline()
    end
  end
end



if not os.execute("mkdir -p " .. TEMP_DIR) then
  print("Failed to create temp directory: " .. TEMP_DIR)
  return
end
local make_new_timeline = true
local MAX_RETRIES = 100
local project_data = nil

if not resolve then
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
  local command = string.format("%s --uuid-from-str '%s'", go_script_path, path)
  local handle = io.popen(command)
  if not handle then
    print("Lua Error: Failed to execute command to get UUID from path: " .. path)
    return nil
  else
    local uuid = handle:read("*a")
    handle:close()
    if uuid and #uuid > 0 then
      return uuid:gsub("%s+", "") -- Remove any whitespace
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

  -- 3. Generate a deterministic UUID from the canonical seed string.
  return uuid(seed_string)
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

        local source_file_path = ""
        if media_pool_item then
          source_file_path = media_pool_item:GetClipProperty("File Path") or ""
        end

        print("source start float: " .. tostring(source_start_float) ..
          ", source end float: " .. tostring(source_end_float) ..
          ", left offset: " .. tostring(left_offset) ..
          ", duration: " .. tostring(duration))

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
          link_group_id = json.null,
          type = nil,
          nested_clips = {},
        }

        if media_pool_item and source_file_path == "" then
          local clip_type = media_pool_item:GetClipProperty("Type")
          print("Detected clip type: " .. tostring(clip_type) .. " for item: " .. item_name)
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
local function export_timeline_to_otio(timeline, file_path)
  print("Placeholder: Would export timeline to OTIO at path: " .. file_path)
  -- In a real implementation, this would use Resolve's API to export the timeline.
end

-- Placeholder function, needs implementation.
local function populate_nested_clips(input_otio_path)
  print("Placeholder: Would populate 'nested_clips' from OTIO file: " .. input_otio_path)
  -- This function would parse the OTIO file and populate the 'nested_clips'
  -- field of the relevant items in the project_data structure.
end


---
-- Gathers and processes all required data from the current project and timeline.
-- @param project (bmd.Project) The current project object.
-- @param timeline (bmd.Timeline) The current timeline object.
-- @return (boolean, string|nil) A tuple of success status and an optional error message.
--
local function get_project_data(project, timeline)
  -- --- 1. Initial Data Gathering ---
  local audio_track_items = get_items_by_tracktype("audio", timeline)



  project_data = {
    project_name = project:GetName(),
    timeline = {
      name = timeline:GetName(),
      fps = timeline:GetSetting("timelineFrameRate"),
      start_timecode = timeline:GetStartTimecode(),
      curr_timecode = timeline:GetCurrentTimecode(),
      video_track_items = get_items_by_tracktype("video", timeline),
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
    export_timeline_to_otio(timeline, input_otio_path)
    populate_nested_clips(input_otio_path) -- This should populate project_data
  end



  -- --- 2. Analyze Mappings & Define Streams ---
  print("Analyzing timeline items and audio channel mappings...")
  for _, item in ipairs(audio_track_items) do
    if item.source_file_path and item.source_file_path ~= "" then
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


--- @param sync boolean
--- @param task_id string|nil
local function main(sync, task_id)
  if not resolve then
    resolve = get_resolve()
  end

  if not resolve then
    local alert_title = "Resolve Not Found"
    local alert_message = "This script must be run inside DaVinci Resolve."
    local alert_severity = "error"
    send_result_with_alert(alert_title, alert_message, task_id, alert_severity)
    return
  end

  if not pm then
    pm = resolve:GetProjectManager()
    project = nil
    local alert_title = "DaVinci Resolve Error"
    local message = "Could not connect to DaVinci Resolve. Is it running?"
    send_result_with_alert(alert_title, message, task_id, "error")
    return
  end

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

  -- input_otio_path = os.path.join(TEMP_DIR, "temp-timeline.otio")
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
    print(project_data)

    if project_data then
      local mt = { __jsontype = 'object' }
      setmetatable(project_data, mt)
      setmetatable(project_data.files, mt)

      local state = {
        indent = true, -- Enable pretty-printing
        exception = function(reason, value)
          if reason == 'unsupported type' then
            -- Fallback to a string representation for any unserializable type
            return "<BMD_Object>"
          end
          error(reason, 0)
        end
      }

      print(json.encode(project_data, state))

      local payload = {
        status = "success",
        message = "sync successful!",
        data = project_data
      }

      local json_string = json.encode(project_data, state)
      print("DEBUG ENCODED JSON:", json_string)
      -- Now, send the data. The encoder will respect the metatable.
      --send_message_to_go("projectData", project_data)
      send_message_to_go("taskResult", payload, task_id)
      return
    end
  end
end


local function set_timecode(time_value)
  if not resolve then
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
    hushcut_command = "GDK_BACKEND=x11 " .. go_app_path .. " --python-port=" .. free_port .. " &"
  else
    hushcut_command = go_app_path .. " --python-port=" .. free_port .. " &"
  end

  print("Starting HushCut app with command: " .. hushcut_command)
  os.execute(hushcut_command)

  local server_command = go_script_path .. " --port=" .. free_port .. " 2>&1"
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
      elseif command == "setPlayhead" then
        if params then
          local time_value = params.time
          if time_value and set_timecode(time_value) then
            print("Setting playhead to: " .. time_value)
            local payload = {
              status = "success",
              message = "Playhead set to " .. time_value,
            }
            send_message_to_go("taskResult", payload, task_id)
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
