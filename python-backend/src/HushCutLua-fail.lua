#!/usr/bin/env lua

--region Imports and Preamble
-- Standard Libraries
local os = require("os")
local io = require("io")
local string = require("string")
local table = require("table")
local math = require("math")

-- Externalish Libraries (must be installed)
local dkjson = require("dkjson") -- local file, should work


local function uuid()
    --  define a seed for math.random
    local random = math.random
    local template ='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    return string.gsub(template, '[xy]', function (c)
      local v = (c == 'x') and random(0, 0xf) or random(8, 0xb)
      return string.format('%x', v)
    end)
  end


-- Polyfills & Helpers for Python features
local helpers = {}

--- Joins path components with the correct separator.
---@param ... string
---@return string
function helpers.path_join(...)
    local args = {...}
    local sep = package.config:sub(1,1)
    local path = table.concat(args, sep)
    -- Replace multiple separators with a single one, but handle the file:// prefix
    path = path:gsub("([^:])([/\\]+)", "%1" .. sep)
    return path
end

--- Replicates Python's os.path.dirname
---@param path string
---@return string
function helpers.dirname(path)
    return path:match("(.*" .. "[/\\]" .. ")")
end


--- Gets the current working directory.
---@return string
function helpers.currentdir()
    local cmd = (package.config:sub(1, 1) == '/') and "pwd" or "cd"
    local handle = io.popen(cmd)
    if not handle then return "" end
    local path = handle:read("*a")
    handle:close()
    return path:match("[^\n]+") or ""
end

--- Checks if a path (file or directory) exists.
---@param path string
---@return boolean
function helpers.path_exists(path)
    local escaped_path = '"' .. path:gsub('"', '\"') .. '"'
    if package.config:sub(1, 1) == '/' then -- Unix-like
        return os.execute("test -e " .. escaped_path) == 0
    else -- Windows
        return os.execute('dir ' .. escaped_path .. ' > nul 2>&1') == 0
    end
end

--- Creates a directory, including parent directories.
---@param path string
function helpers.mkdir(path)
    if helpers.path_exists(path) then return end
    local escaped_path = '"' .. path:gsub('"', '\"') .. '"'
    local cmd = (package.config:sub(1, 1) == '/') and ("mkdir -p " .. escaped_path) or ("mkdir " .. escaped_path)
    os.execute(cmd)
end

--- Replicates Python's os.path.abspath using the shell's realpath for robustness.
---@param path string
---@return string
function helpers.abspath(path)
    if package.config:sub(1, 1) == '/' then -- Unix-like
        local handle = io.popen('realpath -m "' .. path:gsub('"', '\"') .. '"')
        if handle then
            local resolved_path = handle:read("*a"):match("[^\n]+")
            handle:close()
            if resolved_path then return resolved_path end
        end
    end
    -- Fallback for Windows or if realpath fails
    if path:match("^[a-zA-Z]:[\\/]") or path:sub(1,1) == '/' then return path end
    return helpers.path_join(helpers.currentdir(), path)
end



-- GLOBALS
local SCRIPT_DIR = helpers.dirname(arg[0] or "")
local TEMP_DIR = helpers.path_join(SCRIPT_DIR, "..", "wav_files")
TEMP_DIR = helpers.abspath(TEMP_DIR)
if not helpers.path_exists(TEMP_DIR) then
    helpers.mkdir(TEMP_DIR)
end

local PROJECT = nil
local TIMELINE = nil
local MEDIA_POOL = nil
-- local AUTH_TOKEN = nil -- Unused
-- local ENABLE_COMMAND_AUTH = false -- Unused
local GO_SERVER_PORT = 0

local STANDALONE_MODE = false
local RESOLVE = nil
local MAKE_NEW_TIMELINE = true
local MAX_RETRIES = 100
local created_timelines = {}
---@type ProjectData?
local PROJECT_DATA = nil

local TASKS = {
    prepare = 30,
    append = 30,
    verify = 15,
    link = 35,
}

--- Deep copies a table.
---@param orig table
---@return table
function helpers.deepcopy(orig)
    local orig_type = type(orig)
    local copy
    if orig_type == 'table' then
        copy = {}
        for orig_key, orig_value in next, orig, nil do
            copy[helpers.deepcopy(orig_key)] = helpers.deepcopy(orig_value)
        end
        setmetatable(copy, helpers.deepcopy(getmetatable(orig)))
    else -- number, string, boolean, etc
        copy = orig
    end
    return copy
end


--- Sleeps for a given number of seconds.
---@param seconds number
function helpers.sleep(seconds)
    if not seconds or seconds <= 0 then return end
    if package.config:sub(1, 1) == '/' then -- Unix-like
        os.execute("sleep " .. tonumber(seconds))
    else -- Windows
        os.execute("timeout /t " .. math.floor(tonumber(seconds) + 0.5) .. " /nobreak > nul")
    end
end

--- Performs an HTTP request using curl.
---@param method string 'GET' or 'POST'
---@param url string The URL to request
---@param options table? { headers = table, body = string, timeout = number }
---@return boolean success, string response_body, number status_code
function helpers.http_request(method, url, options)
    options = options or {}
    local timeout = options.timeout or 10
    local headers = options.headers or {}
    local body = options.body

    local temp_output_file = helpers.path_join(TEMP_DIR, "curl_output_" .. uuid() .. ".txt")
    
    local command_parts = {
        "curl",
        "-s", -- silent
        "-f", -- fail silently on server errors
        string.format("-w \"%%{http_code}\""),
        string.format("--connect-timeout %d", timeout),
        string.format("-o \"%s\"", temp_output_file),
        string.format("-X %s", method)
    }

    for key, value in pairs(headers) do
        table.insert(command_parts, string.format("-H \"%s: %s\"", key, value))
    end

    local temp_body_file
    if body then
        temp_body_file = helpers.path_join(TEMP_DIR, "curl_body_" .. uuid() .. ".json")
        local file, err = io.open(temp_body_file, "w")
        if not file then
            print("Error creating temp file for curl body: " .. tostring(err))
            os.remove(temp_output_file)
            return false, "Failed to create temp body file", -1
        end
        file:write(body)
        file:close()
        table.insert(command_parts, string.format("--data-binary \"@%s\"", temp_body_file))
    end

    table.insert(command_parts, string.format("\"%s\"", url))
    
    local command = table.concat(command_parts, " ")
    
    local handle = io.popen(command)
    if not handle then
        print("Failed to execute curl command.")
        os.remove(temp_output_file)
        if temp_body_file then os.remove(temp_body_file) end
        return false, "Failed to popen curl", -1
    end

    local status_code_str = handle:read("*a")
    local proc_ok, _, _ = handle:close()

    if not proc_ok then
        print(string.format("curl command failed for URL %s. It's likely the server is not reachable.", url))
        os.remove(temp_output_file)
        if temp_body_file then os.remove(temp_body_file) end
        return false, "curl command failed", -1
    end

    local response_body = ""
    local out_file, read_err = io.open(temp_output_file, "r")
    if out_file then
        response_body = out_file:read("*a")
        out_file:close()
    else
        print("Could not read curl output file (this may be expected if the server returned no body): " .. tostring(read_err))
    end
    
    os.remove(temp_output_file)
    if temp_body_file then
        os.remove(temp_body_file)
    end

    local status_code = tonumber(status_code_str) or -1
    local success = (status_code >= 200 and status_code < 300)

    return success, response_body, status_code
end

--- Simulates subprocess.run, returning a CompletedProcess-like table.
---@param command_list table
---@return table { stdout: string, stderr: string, returncode: number }
function helpers.subprocess_run(command_list)
    local command_str = table.concat(command_list, " ")
    local proc = io.popen(command_str .. " 2>&1")
    local output = proc:read("*a")
    local ok, reason, code = proc:close()
    return {
        stdout = output or "",
        stderr = not ok and (reason or "") or "",
        returncode = code or -1,
        text = output or ""
    }
end

--- Simulates Python's collections.Counter
---@param t table
---@return table
function helpers.Counter(t)
    local counts = {}
    for _, v in ipairs(t) do
        counts[v] = (counts[v] or 0) + 1
    end
    local mt = {
        __add = function(self, other)
            local result = helpers.deepcopy(self)
            for k, v in pairs(other) do
                result[k] = (result[k] or 0) + v
            end
            return setmetatable(result, getmetatable(self))
        end,
        __sub = function(self, other)
            local result = helpers.deepcopy(self)
            for k, v in pairs(other) do
                result[k] = (result[k] or 0) - v
            end
            return setmetatable(result, getmetatable(self))
        end
    }
    return setmetatable(counts, mt)
end
--endregion

--region Type Definitions (for static analysis)
---@class ClipData
---@field source_start_frame number
---@field source_end_frame number
---@field start_frame number
---@field end_frame number

---@class SilenceInterval
---@field start number
---@field stop number -- In Python it was 'end', a keyword in Lua

---@class FileProperties
---@field FPS number

---@class EditInstruction
---@field source_start_frame number
---@field source_end_frame number
---@field start_frame number
---@field end_frame number
---@field enabled boolean

---@class NestedAudioTimelineItem
---@field source_file_path string
---@field processed_file_name string?
---@field start_frame number
---@field end_frame number
---@field source_start_frame number
---@field source_end_frame number
---@field duration number
---@field edit_instructions EditInstruction[]
---@field source_channel integer
---@field nested_items NestedAudioTimelineItem[]?

---@class TimelineItem
---@field bmd_item any
---@field bmd_mpi any
---@field name string
---@field id string
---@field track_type 'video'|'audio'|'subtitle'
---@field track_index integer
---@field source_file_path string
---@field processed_file_name string?
---@field start_frame number
---@field end_frame number
---@field source_start_frame number
---@field source_end_frame number
---@field duration number
---@field edit_instructions EditInstruction[]
---@field source_channel integer?
---@field link_group_id integer?
---@field type 'Compound'|'Timeline'|nil
---@field nested_clips NestedAudioTimelineItem[]?

---@class TimelineProperties
---@field name string
---@field FPS number
---@field item_usages TimelineItem[]

---@class FileSource
---@field bmd_media_pool_item any
---@field file_path string
---@field uuid string

---@class FileData
---@field properties FileProperties
---@field processed_audio_path string?
---@field silenceDetections SilenceInterval[]?
---@field timelineItems TimelineItem[]
---@field fileSource FileSource

---@class Timeline
---@field name string
---@field fps number
---@field start_timecode string
---@field curr_timecode string
---@field video_track_items TimelineItem[]
---@field audio_track_items TimelineItem[]

---@class ProjectData
---@field project_name string
---@field timeline Timeline
---@field files table<string, FileData>

---@class Track
---@field name string
---@field type 'video'|'audio'
---@field index integer
---@field items any[]

---@class ItemsByTracks
---@field videotrack Track[]
---@field audiotrack Track[]

---@class AudioFromVideo
---@field video_bmd_media_pool_item any
---@field video_file_path string
---@field audio_file_path string
---@field audio_file_uuid string
---@field audio_file_name string
---@field silence_intervals SilenceInterval[]

---@class ClipInfo
---@field mediaPoolItem any
---@field startFrame number
---@field endFrame number
---@field recordFrame number
---@field mediaType integer? -- 1 for video, 2 for audio
---@field trackIndex integer

---@class AppendedClipInfo
---@field clip_info table
---@field link_key {integer, integer}
---@field enabled boolean
---@field auto_linked boolean
--endregion


-- Forward declarations for all major functions
local send_message_to_go
local get_resolve
local send_result_with_alert
local export_timeline_to_otio
local populate_nested_clips
local unify_linked_items_in_project_data
local append_and_link_timeline_items
local main_logic = {}
local _create_nested_audio_item_from_otio
local _recursive_otio_parser
local process_track_items
local unify_edit_instructions
local send_progress_update
local get_items_by_tracktype
local _verify_timeline_state
local generate_uuid_from_nested_clips
local mixdown_compound_clips
local apply_edits_from_go
local setTimecode
local _append_clips_to_timeline
local poll_go_for_command
local process_go_command
local main_command_loop
local init


local function uuid_from_path(path_str)
    -- This is a placeholder. A real implementation would use a proper hashing algorithm
    -- to create a deterministic UUID from the path string, like Python's uuid5.
    -- For now, we return a random one, which is NOT correct for caching but will
    -- allow the script to run.
    return uuid()
end


function main_logic.get_project_data(project, timeline)
    local timeline_name = timeline:GetName()
    local timeline_fps = timeline:GetSetting("timelineFrameRate")
    local video_track_items = get_items_by_tracktype("video", timeline)
    local audio_track_items = get_items_by_tracktype("audio", timeline)

    local tl_dict = {
        name = timeline_name,
        fps = timeline_fps,
        start_timecode = timeline:GetStartTimecode(),
        curr_timecode = timeline:GetCurrentTimecode(),
        video_track_items = video_track_items,
        audio_track_items = audio_track_items,
    }
    PROJECT_DATA = {
        project_name = project:GetName(),
        timeline = tl_dict,
        files = {},
    }

    local has_complex_clips = false
    for _, item in ipairs(audio_track_items) do
        if item.type then has_complex_clips = true; break end
    end

    if has_complex_clips then
        print("Complex clips found. Analyzing timeline structure with OTIO...")
        local input_otio_path = helpers.path_join(TEMP_DIR, "temp-timeline.otio")
        export_timeline_to_otio(timeline, input_otio_path)
        populate_nested_clips(input_otio_path)
    end

    print("Analyzing timeline items and audio channel mappings...")
    for _, item in ipairs(audio_track_items) do
        if item.source_file_path and item.source_file_path ~= "" then
            local source_path = item.source_file_path
            local source_uuid = uuid_from_path(source_path)

            item.source_channel = 0 -- Default
            item.processed_file_name = string.format("%s.wav", source_uuid)

            local ok, mapping_str = pcall(function() return item.bmd_item:GetSourceAudioChannelMapping() end)
            if ok and mapping_str and mapping_str ~= "" then
                local s, mapping = pcall(dkjson.decode, mapping_str)
                if s then
                    local clip_track_map = ((mapping.track_mapping or {})["1"] or {})
                    local clip_type = clip_track_map.type
                    local channel_indices = clip_track_map.channel_idx or {}
                    if clip_type and string.lower(clip_type) == "mono" and #channel_indices == 1 then
                        local channel_num = channel_indices[1]
                        print(string.format("Detected clip '%s' using specific source channel: %d", item.name, channel_num))
                        item.source_channel = channel_num
                        item.processed_file_name = string.format("%s_ch%d.wav", source_uuid, channel_num)
                    end
                end
            else
                 print(string.format("Warning: Could not get audio mapping for '%s'. Defaulting to mono mixdown. Error: %s", item.name, tostring(mapping_str)))
            end
        end
    end
    
    for _, item in ipairs(audio_track_items) do
        local source_path = item.source_file_path
        if source_path and source_path ~= "" then
            if not PROJECT_DATA.files[source_path] then
                PROJECT_DATA.files[source_path] = {
                    properties = { FPS = timeline_fps },
                    processed_audio_path = nil,
                    timelineItems = {},
                    fileSource = {
                        file_path = source_path,
                        uuid = uuid_from_path(source_path),
                        bmd_media_pool_item = item.bmd_mpi,
                    },
                    silenceDetections = nil,
                }
            end
        end
    end
    
    if has_complex_clips then
        print("Complex clips found...")
        mixdown_compound_clips(audio_track_items, timeline_fps, {})
    end

    print("Lua-side analysis complete.")
    return true, nil
end

function main_logic.run(sync, task_id)
    local script_start_time = os.time()
    print("running main function...")

    if not sync then
        TRACKER:start_new_run(TASKS, task_id)
        TRACKER:update_task_progress("init", 0.1, "Preparing")
    end

    if not RESOLVE then
        task_id = task_id or ""
        get_resolve(task_id)
    end
    if not RESOLVE then
        print("could not get resolve object")
        PROJECT_DATA = {}
        send_result_with_alert("DaVinci Resolve Error", "Could not connect to DaVinci Resolve. Is it running?", task_id)
        send_message_to_go("projectData", PROJECT_DATA)
        return false
    end

    if not RESOLVE:GetProjectManager() then
        print("no project")
        PROJECT = nil
        send_result_with_alert("DaVinci Resolve Error", "Could not connect to DaVinci Resolve. Is it running?", task_id)
        return false
    end

    PROJECT = RESOLVE:GetProjectManager():GetCurrentProject()

    if not PROJECT then
        PROJECT_DATA = nil
        MEDIA_POOL = nil
        local message = "Please open a project and open a timeline."
        local response_payload = {
            status = "error", message = message, shouldShowAlert = true,
            alertTitle = "No open project", alertMessage = message, alertSeverity = "error",
        }
        send_message_to_go("taskResult", response_payload, task_id)
        send_message_to_go("projectData", PROJECT_DATA)
        return false
    end

    TIMELINE = PROJECT:GetCurrentTimeline()
    if not TIMELINE then
        PROJECT_DATA = nil
        local message = "Please open a timeline."
        local response_payload = {
            status = "error", message = message, data = PROJECT_DATA, shouldShowAlert = true,
            alertTitle = "No Open Timeline", alertMessage = message, alertSeverity = "error",
        }
        send_message_to_go("taskResult", response_payload, task_id)
        return false
    end

    local input_otio_path = helpers.path_join(TEMP_DIR, "temp-timeline.otio")

    if sync or not PROJECT_DATA then
        local success, alert_title = main_logic.get_project_data(PROJECT, TIMELINE)
        if not success then
            alert_title = alert_title or "Sync error"
            local response_payload = {
                status = "error", message = alert_title, shouldShowAlert = true,
                alertTitle = alert_title, alertMessage = "", alertSeverity = "error",
            }
            print(dkjson.encode(response_payload))
            local output_dir = helpers.path_join(TEMP_DIR, "debug_project_data.json")
            print(string.format("exporting debug json to %s", output_dir))
            -- export_to_json(PROJECT_DATA, output_dir)
            send_message_to_go("taskResult", response_payload, task_id)
            return
        end
    end

    if sync then
        local output_dir = helpers.path_join(TEMP_DIR, "debug_project_data.json")
        print(string.format("exporting debug json to %s", output_dir))
        -- export_to_json(PROJECT_DATA, output_dir)

        print("just syncing, exiting")
        print(string.format("it took %.2f seconds for script to finish", os.time() - script_start_time))

        local response_payload = {
            status = "success",
            message = "Sync successful!",
            data = PROJECT_DATA, -- make_project_data_serializable(PROJECT_DATA),
        }

        send_message_to_go("taskResult", response_payload, task_id)
        export_timeline_to_otio(TIMELINE, input_otio_path)
        print(string.format("Exported timeline to OTIO in %s", input_otio_path))
        return
    end

    if not PROJECT_DATA then
        local alert_message = "An unexpected error happened during sync. Could not get project data from Davinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return
    end

    -- safety check: do we have bmd items?
    local all_timeline_items = {}
    for _, item in ipairs(PROJECT_DATA.timeline.video_track_items) do table.insert(all_timeline_items, item) end
    for _, item in ipairs(PROJECT_DATA.timeline.audio_track_items) do table.insert(all_timeline_items, item) end

    if #all_timeline_items == 0 then
        print("critical error, can't continue")
        local alert_message = "An unexpected error happened during sync. Could not get timeline items from Davinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return
    end

    local some_bmd_item = all_timeline_items[1].bmd_item
    if not some_bmd_item or type(some_bmd_item) == "string" then
        print("critical error, can't continue")
        return
    end

    unify_linked_items_in_project_data(input_otio_path)

    TRACKER:complete_task("prepare")
    TRACKER:update_task_progress("append", 1.0, "Adding Clips to Timeline")

    append_and_link_timeline_items(MAKE_NEW_TIMELINE, task_id)

    TRACKER:complete_task("append")

    local execution_time = os.time() - script_start_time
    print(string.format("it took %.2f s to complete", execution_time))

    local response_payload = {
        status = "success",
        message = "Edit successful!",
    }

    send_message_to_go("taskResult", response_payload, task_id)
end

function _create_nested_audio_item_from_otio(otio_clip, clip_start_in_container, max_duration)
    local media_refs = otio_clip.media_references or {}
    if not next(media_refs) then return nil end

    local active_media_key = otio_clip.active_media_reference_key or "DEFAULT_MEDIA"
    local media_ref = media_refs[active_media_key]

    if not media_ref or not string.lower(media_ref.OTIO_SCHEMA or ""):match("^externalreference") then
        return nil
    end

    local source_path_uri = media_ref.target_url or ""
    if source_path_uri == "" then return nil end

    local source_file_path = source_path_uri:gsub("file://", "") -- Simple replacement

    local source_uuid = uuid_from_path(source_file_path)

    local source_range = otio_clip.source_range
    local available_range = media_ref.available_range
    if not source_range or not available_range then return nil end

    local clip_source_start_val = source_range.start_time.value or 0.0
    local media_available_start_val = available_range.start_time.value or 0.0

    local normalized_source_start_frame = clip_source_start_val - media_available_start_val
    local duration = source_range.duration.value or 0.0

    if max_duration and duration > max_duration then
        duration = max_duration
    end

    local source_channel = 0
    local processed_file_name = string.format("%s.wav", source_uuid)

    local resolve_meta = (otio_clip.metadata or {}).Resolve_OTIO or {}
    local channels_info = resolve_meta.Channels or {}

    if #channels_info == 1 then
        local channel_num = channels_info[1]["Source Track ID"]
        if type(channel_num) == "number" and channel_num > 0 then
            source_channel = channel_num
            processed_file_name = string.format("%s_ch%d.wav", source_uuid, source_channel)
            print(string.format("OTIO parser: Found mapping for clip '%s' to source channel %d", otio_clip.name, source_channel))
        end
    end

    ---@type NestedAudioTimelineItem
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

function _recursive_otio_parser(otio_composable, active_angle_name, container_duration)
    local found_clips = {}

    for _, track in ipairs(otio_composable.children or {}) do
        if string.lower(track.kind or "") == "audio" then
            if not active_angle_name or track.name == active_angle_name then
                local playhead = 0.0
                for _, item_in_track in ipairs(track.children or {}) do
                    if container_duration and playhead >= container_duration then break end

                    local schema = string.lower(item_in_track.OTIO_SCHEMA or "")
                    local item_duration = ((item_in_track.source_range or {}).duration or {}).value or 0.0

                    local effective_duration = item_duration
                    if container_duration then
                        local remaining_time = container_duration - playhead
                        if item_duration > remaining_time then
                            effective_duration = math.max(0, remaining_time)
                        end
                    end

                    if schema:find("gap") then
                        playhead = playhead + item_duration
                    elseif effective_duration > 0 then
                        if schema:find("clip") then
                            local item = _create_nested_audio_item_from_otio(item_in_track, playhead, effective_duration)
                            if item then table.insert(found_clips, item) end
                        elseif schema:find("stack") then
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

function populate_nested_clips(input_otio_path)
    if not PROJECT_DATA or not PROJECT_DATA.timeline then
        print("Cannot populate nested clips: PROJECT_DATA is not configured.")
        return
    end

    local f, err = io.open(input_otio_path, "r")
    if not f then
        print(string.format("Failed to read OTIO file at %s: %s", input_otio_path, err))
        return
    end
    local content = f:read("*a")
    f:close()
    local ok, otio_data = pcall(dkjson.decode, content)
    if not ok then
        print(string.format("Failed to parse OTIO file at %s: %s", input_otio_path, otio_data))
        return
    end

    local pd_timeline = PROJECT_DATA.timeline
    local all_pd_items = {}
    for _, item in ipairs(pd_timeline.video_track_items or {}) do table.insert(all_pd_items, item) end
    for _, item in ipairs(pd_timeline.audio_track_items or {}) do table.insert(all_pd_items, item) end

    local timeline_start_frame = (otio_data.global_start_time or {}).value or 0.0
    local FRAME_MATCH_TOLERANCE = 0.5
    local audio_track_counter = 0

    for _, track in ipairs((otio_data.tracks or {}).children or {}) do
        if string.lower(track.kind or "") == "audio" then
            audio_track_counter = audio_track_counter + 1
            local current_track_index = audio_track_counter
            local playhead_frames = 0

            for _, item in ipairs(track.children or {}) do
                local duration_val = ((item.source_range or {}).duration or {}).value or 0.0
                local item_schema = string.lower(item.OTIO_SCHEMA or "")

                if item_schema:find("gap") then
                    playhead_frames = playhead_frames + duration_val
                else
                    if item_schema:find("stack") then
                        local container_duration = duration_val
                        local resolve_meta = (item.metadata or {}).Resolve_OTIO or {}
                        local sequence_type = resolve_meta["Sequence Type"]
                        local active_angle_name = nil
                        if sequence_type == "Multicam Clip" then
                            local item_name = item.name or ""
                            active_angle_name = item_name:match("(Angle %d+)")
                            if active_angle_name then
                                print(string.format("Detected Multicam clip. Active audio angle: '%s'", active_angle_name))
                            else
                                print(string.format("Could not parse active angle from Multicam name: '%s'.", item_name))
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
                                print(string.format("Could not find corresponding project item for OTIO stack '%s' on track %d", otio_item_name, current_track_index))
                            end

                            for _, pd_item in ipairs(corresponding_pd_items) do
                                pd_item.nested_clips = nested_clips_for_this_instance
                            end
                        end
                    end
                    playhead_frames = playhead_frames + duration_val
                end
            end
        end
    end
end

function process_track_items(items, pd_timeline, pd_timeline_key, timeline_start_frame, max_id, track_index)
    local FRAME_MATCH_TOLERANCE = 0.5
    local playhead_frames = 0
    local current_max_id = max_id

    for _, item in ipairs(items) do
        if item then
            local item_schema = string.lower(item.OTIO_SCHEMA or "")
            local duration_val = ((item.source_range or {}).duration or {}).value or 0

            if item_schema:find("gap") then
                playhead_frames = playhead_frames + duration_val
            elseif item_schema:find("clip") or item_schema:find("stack") then
                local record_frame_float = playhead_frames + timeline_start_frame
                local corresponding_items = {}
                for _, tl_item in ipairs(pd_timeline[pd_timeline_key] or {}) do
                    if tl_item.track_index == track_index and math.abs((tl_item.start_frame or -1) - record_frame_float) < FRAME_MATCH_TOLERANCE then
                        table.insert(corresponding_items, tl_item)
                    end
                end

                if #corresponding_items == 0 then
                    print(string.format("Could not find a corresponding project item for OTIO item at frame %f on track %d", record_frame_float, track_index))
                else
                    local link_group_id = ((item.metadata or {}).Resolve_OTIO or {})["Link Group ID"]
                    if link_group_id then
                        for _, corresponding_item in ipairs(corresponding_items) do
                            corresponding_item.link_group_id = link_group_id
                        end
                        current_max_id = math.max(current_max_id, link_group_id)
                    end
                end
                playhead_frames = playhead_frames + duration_val
            end
        end
    end
    return current_max_id
end

function unify_edit_instructions(items)
    local has_any_edits = false
    for _, item in ipairs(items) do
        if item.edit_instructions and #item.edit_instructions > 0 then
            has_any_edits = true
            break
        end
    end
    if not has_any_edits then
        return {{0.0, nil, true}}
    end

    local events = {}
    for _, item in ipairs(items) do
        if item.edit_instructions then
            local base = item.source_start_frame or 0.0
            for _, edit in ipairs(item.edit_instructions) do
                if edit.source_start_frame and edit.source_end_frame then
                    local rel_start = edit.source_start_frame - base
                    local rel_end = edit.source_end_frame - base
                    local is_enabled = edit.enabled == nil or edit.enabled
                    table.insert(events, {rel_start, 1, is_enabled})
                    table.insert(events, {rel_end, -1, is_enabled})
                end
            end
        end
    end

    if #events == 0 then return {} end

    table.sort(events, function(a, b)
        if a[1] ~= b[1] then return a[1] < b[1]
        else return a[2] > b[2] end
    end)

    local merged_segments = {}
    local active_enabled_count = 0
    local active_disabled_count = 0
    local last_frame = events[1][1]

    for _, event in ipairs(events) do
        local frame, type_val, is_enabled = event[1], event[2], event[3]
        local segment_duration = frame - last_frame
        if segment_duration > 0 then
            local is_segment_enabled = active_enabled_count > 0
            local is_segment_active = active_enabled_count > 0 or active_disabled_count > 0
            if is_segment_active then
                table.insert(merged_segments, {last_frame, frame, is_segment_enabled})
            end
        end

        if type_val == 1 then
            if is_enabled then active_enabled_count = active_enabled_count + 1
            else active_disabled_count = active_disabled_count + 1 end
        else
            if is_enabled then active_enabled_count = active_enabled_count - 1
            else active_disabled_count = active_disabled_count - 1 end
        end
        last_frame = frame
    end

    if #merged_segments == 0 then return {} end

    local final_edits = {}
    local current_start, current_end, current_enabled = merged_segments[1][1], merged_segments[1][2], merged_segments[1][3]

    for i = 2, #merged_segments do
        local next_start, next_end, next_enabled = merged_segments[i][1], merged_segments[i][2], merged_segments[i][3]
        if next_start == current_end and next_enabled == current_enabled then
            current_end = next_end
        else
            table.insert(final_edits, {current_start, current_end, current_enabled})
            current_start, current_end, current_enabled = next_start, next_end, next_enabled
        end
    end
    table.insert(final_edits, {current_start, current_end, current_enabled})

    local min_duration_in_frames = 1.0
    local filtered_edits = {}
    for _, edit in ipairs(final_edits) do
        if (edit[2] - edit[1]) >= min_duration_in_frames then
            table.insert(filtered_edits, edit)
        end
    end
    return filtered_edits
end

function unify_linked_items_in_project_data(input_otio_path)
    if not PROJECT_DATA or not PROJECT_DATA.timeline then
        error("PROJECT_DATA is not properly configured.")
    end

    local pd_timeline = PROJECT_DATA.timeline

    local f, err = io.open(input_otio_path, "r")
    if not f then
        print(string.format("Failed to read or parse OTIO file at %s: %s", input_otio_path, err))
        return
    end
    local content = f:read("*a")
    f:close()
    local ok, otio_data = pcall(dkjson.decode, content)
    if not ok then
        print(string.format("Failed to parse OTIO file at %s: %s", input_otio_path, otio_data))
        return
    end

    local max_link_group_id = 0
    local track_type_counters = {video = 0, audio = 0, subtitle = 0}
    local start_time_value = ((otio_data.global_start_time or {}).value or 0.0)
    local timeline_start_frame = tonumber(start_time_value)

    for _, track in ipairs((otio_data.tracks or {}).children or {}) do
        local kind = string.lower(track.kind or "")
        if track_type_counters[kind] then
            track_type_counters[kind] = track_type_counters[kind] + 1
            local current_track_index = track_type_counters[kind]
            local pd_key = string.format("%s_track_items", kind)
            max_link_group_id = math.max(max_link_group_id,
                process_track_items(track.children or {}, pd_timeline, pd_key, timeline_start_frame, max_link_group_id, current_track_index)
            )
        end
    end

    local all_pd_items = {}
    for _, item in ipairs(pd_timeline.video_track_items or {}) do table.insert(all_pd_items, item) end
    for _, item in ipairs(pd_timeline.audio_track_items or {}) do table.insert(all_pd_items, item) end

    local items_by_link_group = {}
    for _, item in ipairs(all_pd_items) do
        local link_group_id = item.link_group_id
        if link_group_id then
            items_by_link_group[link_group_id] = items_by_link_group[link_group_id] or {}
            table.insert(items_by_link_group[link_group_id], item)
        end
    end

    local next_new_group_id = max_link_group_id + 1
    for _, item in ipairs(all_pd_items) do
        if not item.link_group_id and item.edit_instructions and #item.edit_instructions > 0 then
            item.link_group_id = next_new_group_id
            items_by_link_group[next_new_group_id] = {item}
            next_new_group_id = next_new_group_id + 1
        end
    end

    for link_id, group_items in pairs(items_by_link_group) do
        if #group_items > 0 then
            local unified_edits = unify_edit_instructions(group_items)
            local group_timeline_anchor = math.huge
            for _, item in ipairs(group_items) do
                group_timeline_anchor = math.min(group_timeline_anchor, item.start_frame or math.huge)
            end

            if group_timeline_anchor ~= math.huge then
                local is_uncut = #unified_edits == 0 or (unified_edits[1] and unified_edits[1][2] == nil)
                for _, item in ipairs(group_items) do
                    local new_edit_instructions = {}
                    local base_source_offset = item.source_start_frame or 0.0

                    if is_uncut then
                        local source_end = item.source_end_frame or base_source_offset
                        if source_end > base_source_offset then
                            local is_item_enabled = item.edit_instructions and #item.edit_instructions > 0 and (item.edit_instructions[1].enabled == nil or item.edit_instructions[1].enabled)
                            table.insert(new_edit_instructions, {
                                source_start_frame = base_source_offset,
                                source_end_frame = source_end,
                                start_frame = item.start_frame,
                                end_frame = item.end_frame,
                                enabled = is_item_enabled,
                            })
                        end
                    else
                        local timeline_playhead = math.floor(group_timeline_anchor + 0.5)
                        for _, edit in ipairs(unified_edits) do
                            local rel_start, rel_end, is_enabled = edit[1], edit[2], edit[3]
                            local source_duration = rel_end - rel_start
                            local timeline_duration = math.floor(source_duration + 0.5)

                            if timeline_duration >= 1 then
                                local source_start = base_source_offset + rel_start
                                local source_end = source_start + timeline_duration
                                local timeline_start = timeline_playhead
                                local timeline_end = timeline_playhead + timeline_duration

                                table.insert(new_edit_instructions, {
                                    source_start_frame = source_start,
                                    source_end_frame = source_end,
                                    start_frame = timeline_start,
                                    end_frame = timeline_end,
                                    enabled = is_enabled,
                                })
                                timeline_playhead = timeline_end
                            end
                        end
                    end
                    item.edit_instructions = new_edit_instructions
                    print(string.format("Updated item '%s' in group %d with %d unified edit(s).", item.id, link_id, #new_edit_instructions))
                end
            end
        end
    end
end

-- ProgressTracker "class"
local ProgressTracker = {}
ProgressTracker.__index = ProgressTracker

function ProgressTracker:new()
    local self = setmetatable({}, ProgressTracker)
    self.task_id = ""
    self._tasks = {}
    self._total_weight = 0.0
    self._task_progress = {}
    self._last_report = os.time()
    return self
end

function ProgressTracker:start_new_run(weighted_tasks, task_id)
    print(string.format("Initializing tracker for Task ID: %s", task_id))
    self.task_id = task_id
    local original_total = 0
    for _, weight in pairs(weighted_tasks) do
        original_total = original_total + weight
    end

    if original_total == 0 then
        self._tasks, self._total_weight = {}, 0.0
    else
        local scaling_factor = 100 / original_total
        self._tasks = {}
        for name, weight in pairs(weighted_tasks) do
            self._tasks[name] = weight * scaling_factor
        end
        self._total_weight = 100.0
    end
    self._task_progress = {}
    for task, _ in pairs(self._tasks) do
        self._task_progress[task] = 0.0
    end
end

function ProgressTracker:_report_progress(message)
    if os.time() - self._last_report > 0.25 then
        send_progress_update(self.task_id, self:get_percentage(), message)
        self._last_report = os.time()
    end
end

function ProgressTracker:update_task_progress(task_name, percentage, message)
    if not self.task_id or self.task_id == "" then
        print("Warning: Tracker not initialized. Call start_new_run() first.")
        return
    end
    if not self._tasks[task_name] then
        print(string.format("Warning: Task '%s' not found.", task_name))
        return
    end
    percentage = math.max(0, math.min(100, percentage))
    self._task_progress[task_name] = self._tasks[task_name] * (percentage / 100.0)
    local update_message = message or task_name
    print(string.format("Updating '%s' to %.1f%%. Overall: %.2f%%", task_name, percentage, self:get_percentage()))
    self:_report_progress(update_message)
end

function ProgressTracker:complete_task(task_name)
    self:update_task_progress(task_name, 100.0)
end

function ProgressTracker:get_percentage()
    if self._total_weight == 0 then
        return 0.0
    end
    local current_progress = 0
    for _, val in pairs(self._task_progress) do
        current_progress = current_progress + val
    end
    return (current_progress / self._total_weight) * 100
end

function ProgressTracker:__tostring()
    return string.format("Task ID '%s' | Overall Progress: %.2f%%", self.task_id, self:get_percentage())
end

local TRACKER = ProgressTracker:new()


function send_message_to_go(message_type, payload, task_id)
    if GO_SERVER_PORT == 0 then
        print("Lua Error: Go server port not configured. Cannot send message to Go.")
        return false
    end

    local go_message = {Type = message_type, Payload = payload}
    local json_payload = dkjson.encode(go_message)

    local url = "http://localhost:" .. GO_SERVER_PORT .. "/msg"
    if task_id then
        url = url .. "?task_id=" .. task_id
    end

    local ok, response_body, code = helpers.http_request("POST", url, {
        headers = { ["Content-Type"] = "application/json" },
        body = json_payload
    })

    if ok then
        print(string.format("Lua (to Go): Message type '%s' sent. Task id: %s. Go responded: %d", message_type, task_id or "N/A", code))
        return true
    else
        print(string.format("Lua (to Go): Error sending message type '%s'. Go responded with status %s: %s", message_type, tostring(code), response_body))
        return false
    end
end

local function resolve_import_error_msg(e, task_id)
    print(string.format("Failed to import GetResolve: %s", tostring(e)))
    print("Check and ensure DaVinci Resolve installation is correct.")

    send_message_to_go(
        "showAlert",
        {
            title = "DaVinci Resolve Error",
            message = "Failed to import DaVinci Resolve Lua API.",
            severity = "error",
        },
        task_id
    )
    return nil
end

function get_resolve(task_id)
    local resolve_modules_path = ""
    local platform = "linux"
    if os.getenv("OS") == "Windows_NT" then platform = "win"
    elseif os.execute("uname -s"):find("Darwin") then platform = "darwin" end

    if platform == "darwin" then
        resolve_modules_path = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/"
    elseif platform == "win" then
        resolve_modules_path = helpers.path_join(os.getenv("PROGRAMDATA"), "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting", "Modules")
    elseif platform == "linux" then
        resolve_modules_path = "/opt/resolve/Developer/Scripting/Modules/"
    end

    if resolve_modules_path and not package.path:find(resolve_modules_path, 1, true) then
        package.path = package.path .. ";" .. resolve_modules_path .. "?.lua"
        print(string.format("Added to package.path: %s", resolve_modules_path))
    else
        print(string.format("Already in package.path: %s", resolve_modules_path))
    end

    local ok, bmd = pcall(require, "DaVinciResolveScript")
    if not ok then
        resolve_import_error_msg(bmd, task_id)
        return nil
    end
    print("was able to import DaVinciResolveScript")

    local resolve_obj = bmd.scriptapp("Resolve")
    if not resolve_obj then
        local ok_global, _ = pcall(function() return _G.resolve end)
        if ok_global and _G.resolve then
            resolve_obj = _G.resolve
        else
            resolve_import_error_msg(
                "Failed to get Resolve object from scriptapp or global.",
                task_id
            )
            return nil
        end
    end
    RESOLVE = resolve_obj
end

function export_timeline_to_otio(timeline, file_path)
    if not RESOLVE then return end
    if not timeline then
        print("No timeline to export.")
        return
    end

    local success = timeline:Export(file_path, RESOLVE.EXPORT_OTIO, 1) -- '1' for OTIO
    if success then
        print(string.format("Timeline exported successfully to %s", file_path))
    else
        print("Failed to export timeline.")
    end
end
end

local function get_item_id(item_name, start_frame, track_type, track_index)
    return string.format("%s-%s-%d--%f", item_name, track_type, track_index, start_frame)
end

function get_items_by_tracktype(track_type, timeline)
    local items = {}
    local track_count = timeline:GetTrackCount(track_type)
    for i = 1, track_count do
        local track_items = timeline:GetItemListInTrack(track_type, i) or {}
        for _, item_bmd in ipairs(track_items) do
            local start_frame = item_bmd:GetStart()
            local item_name = item_bmd:GetName()
            local media_pool_item = item_bmd:GetMediaPoolItem()
            local left_offset = item_bmd:GetLeftOffset()
            local duration = item_bmd:GetDuration()
            local source_start_float = left_offset
            local source_end_float = left_offset + duration
            local source_file_path = ""
            if media_pool_item then
                source_file_path = media_pool_item:GetClipProperty("File Path")["File Path"] or ""
            end

            ---@type TimelineItem
            local timeline_item = {
                bmd_item = item_bmd, bmd_mpi = media_pool_item,
                duration = 0, name = item_name, edit_instructions = {},
                start_frame = start_frame, end_frame = item_bmd:GetEnd(),
                id = get_item_id(item_name, start_frame, track_type, i),
                track_type = track_type, track_index = i,
                source_file_path = source_file_path, processed_file_name = nil,
                source_start_frame = source_start_float, source_end_frame = source_end_float,
                source_channel = 0, link_group_id = nil, type = nil, nested_clips = {},
            }

            if media_pool_item and source_file_path == "" then
                local clip_type = media_pool_item:GetClipProperty("Type")["Type"]
                print(string.format("Detected clip type: %s for item: %s", clip_type, item_name))
                timeline_item.type = clip_type
                timeline_item.nested_clips = {}
            end
            table.insert(items, timeline_item)
        end
    end
    return items
end

function _verify_timeline_state(timeline, expected_clips)
    print("Verifying timeline state...")
    TRACKER:update_task_progress("verify", 1.0, "Verifying")
    
    local expected_cuts = {}
    local function getKey(clip) return string.format("%d-%d-%d", clip.mediaType, clip.trackIndex, clip.recordFrame) end

    for _, clip in ipairs(expected_clips) do
        local key = getKey(clip)
        expected_cuts[key] = (expected_cuts[key] or 0) + 1
    end

    local actual_video_items = get_items_by_tracktype("video", timeline)
    local actual_audio_items = get_items_by_tracktype("audio", timeline)
    local all_actual_items = {}
    for _, v in ipairs(actual_video_items) do table.insert(all_actual_items, v) end
    for _, a in ipairs(actual_audio_items) do table.insert(all_actual_items, a) end

    for _, item in ipairs(all_actual_items) do
        local media_type = item.track_type == "video" and 1 or 2
        local key = string.format("%d-%d-%d", media_type, item.track_index, item.start_frame)
        if expected_cuts[key] then
            expected_cuts[key] = expected_cuts[key] - 1
        else
            print(string.format("  - Found an unexpected clip: %s track %d at frame %d", item.track_type, item.track_index, item.start_frame))
        end
    end

    local missing_cuts = {}
    for key, count in pairs(expected_cuts) do
        if count > 0 then
            missing_cuts[key] = count
        end
    end

    if not next(missing_cuts) then
        print("  - Verification successful. All expected clips were found.")
        return true
    else
        print("  - Verification FAILED. The following clips are missing:")
        for key, count in pairs(missing_cuts) do
            local media_type_s, track_index_s, start_frame_s = key:match("^(%d+)-(%d+)-(%d+)$")
            local track_type = tonumber(media_type_s) == 1 and "video" or "audio"
            print(string.format("    - Missing %d clip(s) on %s track %s at frame %s", count, track_type, track_index_s, start_frame_s))
        end
        return false
    end
function generate_uuid_from_nested_clips(top_level_item, nested_clips)
    local bmd_item = top_level_item.bmd_mpi
    local seed_string = bmd_item and string.format("bmd_id:%s;", bmd_item:GetUniqueId()) or "bmd_id:<unknown>;"
    seed_string = seed_string .. string.format("duration:%f;", top_level_item.end_frame - top_level_item.start_frame)
    seed_string = seed_string .. string.format("source_start:%f;", top_level_item.source_start_frame)
    seed_string = seed_string .. string.format("source_end:%f;", top_level_item.source_end_frame)

    table.sort(nested_clips, function(a, b) return a.start_frame < b.start_frame end)

    local nested_strings = {}
    for _, clip in ipairs(nested_clips) do
        local clip_signature = string.format("path:%s,start:%f,end:%f,s_start:%f,s_end:%f",
            clip.source_file_path, clip.start_frame, clip.end_frame, clip.source_start_frame, clip.source_end_frame)
        table.insert(nested_strings, clip_signature)
    end

    seed_string = seed_string .. "nested_clips[" .. table.concat(nested_strings, "||") .. "]"
    
    return uuid_from_path(seed_string)
end

function mixdown_compound_clips(audio_timeline_items, _, curr_processed_file_names)
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

    local processed_set = {}
    for _, name in ipairs(curr_processed_file_names) do processed_set[name] = true end

    for content_uuid, items_in_group in pairs(content_map) do
        local representative_item = items_in_group[1]
        local output_filename = string.format("%s.wav", content_uuid)
        local output_wav_path = helpers.path_join(TEMP_DIR, output_filename)
        
        local needs_render = not processed_set[output_filename]

        if needs_render then
            print(string.format("Go Mode: Skipping local render for new content ID %s. Go will handle it.", content_uuid))
        else
            print(string.format("Content for '%s' is unchanged. Skipping render.", representative_item.name))
        end

        for _, tl_item in ipairs(items_in_group) do
            tl_item.processed_file_name = output_filename
            tl_item.source_file_path = output_wav_path
            tl_item.source_start_frame = 0.0
            tl_item.source_end_frame = tl_item.end_frame - tl_item.start_frame
        end
    end
end


function apply_edits_from_go(target_project, source_project)
    print("Applying edit instructions from Go...")
    
    local source_audio_items = (source_project.timeline or {}).audio_track_items or {}
    local source_items_by_id = {}
    for _, item in ipairs(source_audio_items) do
        if item.id then source_items_by_id[item.id] = item end
    end

    if not next(source_items_by_id) then
        print("Warning: No audio items with IDs found in data from Go. No edits applied.")
        return
    end

    local target_audio_items = (target_project.timeline or {}).audio_track_items or {}
    local items_updated_count = 0
    for _, target_item in ipairs(target_audio_items) do
        local item_id = target_item.id
        if item_id and source_items_by_id[item_id] then
            local source_item = source_items_by_id[item_id]
            if source_item.edit_instructions then
                target_item.edit_instructions = source_item.edit_instructions
                items_updated_count = items_updated_count + 1
            end
        end
    end
    print(string.format("Finished applying edits. Updated %d timeline items.", items_updated_count))
end

function send_result_with_alert(alert_title, alert_message, task_id, alert_severity)
    alert_severity = alert_severity or "error"
    local response_payload = {
        status = "error",
        message = alert_message,
        shouldShowAlert = true,
        alertTitle = alert_title,
        alertMessage = alert_message,
        alertSeverity = alert_severity,
    }
    send_message_to_go("taskResult", response_payload, task_id)
end

function send_progress_update(task_id, progress, message)
    message = message or "error"
    local response_payload = {message = message, progress = progress}
    send_message_to_go("taskUpdate", response_payload, task_id)
end

function setTimecode(timecode)
    if not timecode then return false end
    if not RESOLVE or not TIMELINE then return false end
    return TIMELINE:SetCurrentTimecode(timecode)
end

function _append_clips_to_timeline(timeline, media_pool, timeline_items)
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
                    local link_key = string.format("%d-%d", link_id, i) -- Lua tables can't use tables as keys easily
                    local appended_clip = {
                        clip_info = clip_info_for_api,
                        link_key = link_key,
                        enabled = edit.enabled == nil or edit.enabled,
                        auto_linked = false,
                    }
                    grouped_clips[link_key] = grouped_clips[link_key] or {}
                    table.insert(grouped_clips[link_key], appended_clip)
                end
            end
        end
    end

    if not next(grouped_clips) then return {}, {} end

    local final_api_batch = {}
    local all_processed_clips = {}

    for link_key, group in pairs(grouped_clips) do
        local is_optimizable = false
        if #group == 2 then
            local clip1, clip2 = group[1], group[2]
            local mpi1 = clip1.clip_info.mediaPoolItem
            local mpi2 = clip2.clip_info.mediaPoolItem
            local path1 = mpi1 and mpi1:GetClipProperty("File Path")["File Path"] or nil
            local path2 = mpi2 and mpi2:GetClipProperty("File Path")["File Path"] or nil
            local media_types = {[clip1.clip_info.mediaType]=true, [clip2.clip_info.mediaType]=true}

            if media_types[1] and media_types[2] and
               clip1.clip_info.trackIndex == 1 and clip2.clip_info.trackIndex == 1 and
               path1 and path1 == path2 then
                is_optimizable = true
            end
        end

        if is_optimizable then
            print(string.format("Optimizing append for link group %s on Track 1.", link_key))
            for _, clip in ipairs(group) do clip.auto_linked = true end
            
            local optimized_clip_info = helpers.deepcopy(group[1].clip_info)
            optimized_clip_info.mediaType = nil
            optimized_clip_info.trackIndex = nil
            table.insert(final_api_batch, optimized_clip_info)
        else
            for _, clip in ipairs(group) do
                table.insert(final_api_batch, clip.clip_info)
            end
        end
        for _, clip in ipairs(group) do table.insert(all_processed_clips, clip) end
    end

    table.sort(all_processed_clips, function(a, b) return a.clip_info.recordFrame < b.clip_info.recordFrame end)

    print(string.format("Appending %d total clip instructions to timeline...", #final_api_batch))
    local appended_bmd_items = media_pool:AppendToTimeline(final_api_batch) or {}

    return all_processed_clips, appended_bmd_items
end

function append_and_link_timeline_items(create_new_timeline, task_id)
    if not PROJECT_DATA or not PROJECT_DATA.timeline then
        print("Error: Project data is missing or malformed.")
        return
    end

    if not PROJECT then
        print("Error: Could not get current project.")
        return
    end

    MEDIA_POOL = PROJECT:GetMediaPool()
    if not MEDIA_POOL then
        print("Error: MediaPool object not available.")
        return
    end

    local timeline_items = {}
    for _, item in ipairs(PROJECT_DATA.timeline.video_track_items or {}) do table.insert(timeline_items, item) end
    for _, item in ipairs(PROJECT_DATA.timeline.audio_track_items or {}) do table.insert(timeline_items, item) end

    local max_indices = {video = 0, audio = 0}
    for _, item in ipairs(timeline_items) do
        local track_type = item.track_type
        local track_index = item.track_index or 1
        if max_indices[track_type] then
            max_indices[track_type] = math.max(max_indices[track_type], track_index)
        end
    end
    local og_tl_name = PROJECT_DATA.timeline.name

    local timeline = nil
    if create_new_timeline then
        print("Creating a new timeline...")
        created_timelines[og_tl_name] = created_timelines[og_tl_name] or 1
        local retries = 0
        while retries < MAX_RETRIES do
            local index = created_timelines[og_tl_name]
            local timeline_name = string.format("%s-hc-%02d", og_tl_name, index)
            timeline = MEDIA_POOL:CreateEmptyTimeline(timeline_name)
            if timeline then
                timeline:SetStartTimecode(PROJECT_DATA.timeline.start_timecode)
                created_timelines[og_tl_name] = created_timelines[og_tl_name] + 1
                break
            else
                created_timelines[og_tl_name] = created_timelines[og_tl_name] + 1
                retries = retries + 1
            end
        end
        if not timeline then
            send_result_with_alert("DaVinci Error", string.format("Could not create new timeline after %d attempts.", MAX_RETRIES), task_id)
            return
        end
    else
        timeline = TIMELINE
        if timeline then
            print("Clearing all clips from existing timeline...")
            local all_clips_to_delete = {}
            for i = 1, timeline:GetTrackCount("video") do
                local clips = timeline:GetItemListInTrack("video", i)
                if clips then for _, c in ipairs(clips) do table.insert(all_clips_to_delete, c) end end
            end
            for i = 1, timeline:GetTrackCount("audio") do
                local clips = timeline:GetItemListInTrack("audio", i)
                if clips then for _, c in ipairs(clips) do table.insert(all_clips_to_delete, c) end end
            end
            if #all_clips_to_delete > 0 then
                print(string.format("Deleting %d existing clips...", #all_clips_to_delete))
                timeline:DeleteClips(all_clips_to_delete)
            else
                print("Timeline is already empty.")
            end
        end
    end

    if not timeline then
        print("Error: Could not get a valid timeline. Aborting operation.")
        return
    end

    for track_type, required_count in pairs(max_indices) do
        local current_count = timeline:GetTrackCount(track_type)
        local tracks_to_add = required_count - current_count
        if tracks_to_add > 0 then
            print(string.format("Timeline has %d %s tracks, adding %d more...", current_count, track_type, tracks_to_add))
            for _ = 1, tracks_to_add do
                timeline:AddTrack(track_type)
            end
        end
    end

    print(string.format("Operating on timeline: '%s'", timeline:GetName()))
    TIMELINE = timeline

    local success = false
    local num_retries = 4
    local sleep_time_between = 2.5
    for attempt = 1, num_retries do
        local processed_clips, bmd_items_from_api = _append_clips_to_timeline(TIMELINE, MEDIA_POOL, timeline_items)
        TRACKER:complete_task("append")
        
        if #processed_clips == 0 then
            success = true
            break
        end

        local expected_clip_infos = {}
        for _, item in ipairs(processed_clips) do table.insert(expected_clip_infos, item.clip_info) end

        if _verify_timeline_state(TIMELINE, expected_clip_infos) then
            TRACKER:complete_task("verify")
            print("Verification successful. Proceeding to modify and link.")

            local auto_linked_keys = {}
            for _, clip in ipairs(processed_clips) do if clip.auto_linked then auto_linked_keys[clip.link_key] = true end end
            if next(auto_linked_keys) then
                local count = 0; for _ in pairs(auto_linked_keys) do count = count + 1 end
                print(string.format("Identified %d auto-linked groups to skip for manual linking.", count))
            end

            local link_key_lookup = {}
            for _, appended_clip in ipairs(processed_clips) do
                local clip_info, link_key = appended_clip.clip_info, appended_clip.link_key
                local lookup_key = string.format("%d-%d-%d", clip_info.mediaType or 0, clip_info.trackIndex, clip_info.recordFrame)
                link_key_lookup[lookup_key] = link_key
            end
            
            local actual_items = {}
            for _, item in ipairs(get_items_by_tracktype("video", TIMELINE)) do table.insert(actual_items, item) end
            for _, item in ipairs(get_items_by_tracktype("audio", TIMELINE)) do table.insert(actual_items, item) end
            
            local disabled_keys = {}
            for _, p_clip in ipairs(processed_clips) do
                if not p_clip.enabled then
                    local key = string.format("%d-%d-%d", p_clip.clip_info.mediaType or 0, p_clip.clip_info.trackIndex, p_clip.clip_info.recordFrame)
                    disabled_keys[key] = true
                end
            end
            if next(disabled_keys) then
                local disabled_count = 0
                for _, item_dict in ipairs(actual_items) do
                    local media_type = item_dict.track_type == "video" and 1 or 2
                    local actual_key = string.format("%d-%d-%d", media_type, item_dict.track_index, item_dict.start_frame)
                    if disabled_keys[actual_key] then
                        item_dict.bmd_item:SetClipColor("Violet")
                        disabled_count = disabled_count + 1
                    end
                end
                print(string.format("Updated status for %d clip(s).", disabled_count))
            end

            local link_groups = {}
            for _, item_dict in ipairs(actual_items) do
                local media_type = item_dict.track_type == "video" and 1 or 2
                local lookup_key = string.format("%d-%d-%d", media_type, item_dict.track_index, item_dict.start_frame)
                local link_key = link_key_lookup[lookup_key]
                if link_key then
                    link_groups[link_key] = link_groups[link_key] or {}
                    table.insert(link_groups[link_key], item_dict.bmd_item)
                end
            end

            print("Performing manual linking for necessary clips...")
            local groups_to_link = {}
            for k, v in pairs(link_groups) do
                if not auto_linked_keys[k] then groups_to_link[k] = v end
            end

            if not next(groups_to_link) then
                print("No clips required manual linking.")
            else
                local length_link_groups = 0; for _ in pairs(groups_to_link) do length_link_groups = length_link_groups + 1 end
                local index = 1
                for group_key, clips_to_link in pairs(groups_to_link) do
                    if #clips_to_link >= 2 then
                        print(string.format("  - Manually linking group: %s", group_key))
                        TIMELINE:SetClipsLinked(clips_to_link, true)
                    end
                    if (index % 10) == 1 then
                        local percentage = (index / length_link_groups) * 100
                        TRACKER:update_task_progress("link", percentage, "Linking clips...")
                    end
                    index = index + 1
                end
            end
            
            TRACKER:complete_task("link")
            print("✅ Operation completed successfully.")
            success = true
            break
        else
            print(string.format("Attempt %d failed. Rolling back changes...", attempt))
            if bmd_items_from_api and #bmd_items_from_api > 0 then
                TIMELINE:DeleteClips(bmd_items_from_api, false)
            end
            if attempt < num_retries then
                helpers.sleep(sleep_time_between)
                sleep_time_between = sleep_time_between + 1.5
            end
        end
    end

    if not success then
        print("❌ Operation failed after all retries. Please check the logs.")
    end
end

--region New Command Processing and Main Loop (replaces server)

--- This function replaces the old server logic. It is called when a command is received from Go.
---@param command_data table The full command object from Go.
function process_go_command(command_data)
    if not command_data or not command_data.command then
        print("Received invalid command from Go.")
        return
    end

    local command = command_data.command
    local params = command_data.params or {}
    local task_id = params.taskId

    print(string.format("Received command '%s' with task ID '%s'", command, task_id or "N/A"))

    if command == "sync" then
        main_logic.run(true, task_id)
    elseif command == "makeFinalTimeline" then
        local project_data_from_go = params.projectData
        MAKE_NEW_TIMELINE = params.makeNewTimeline == nil or params.makeNewTimeline
        if not project_data_from_go then
            print("Error: Missing projectData for makeFinalTimeline command.")
            send_result_with_alert("Lua Error", "Missing projectData parameter.", task_id)
            return
        end
        if PROJECT_DATA then
            apply_edits_from_go(PROJECT_DATA, project_data_from_go)
        else
            PROJECT_DATA = project_data_from_go
        end
        main_logic.run(false, task_id)
    elseif command == "setPlayhead" then
        local time_value = params.time
        if not setTimecode(time_value) then
             print("Could not set playhead.")
        end
    else
        print("Unknown command from Go: " .. tostring(command))
    end
end

--- Polls the Go server for the next command using long polling.
---@param go_port number The port the Go server is listening on.
---@return table|nil command_data, string|nil command_name
function poll_go_for_command(go_port)
    local url = string.format("http://localhost:%d/lua/get-command", go_port)
    -- Use a long timeout to allow for long polling on the server side
    local ok, body, code = helpers.http_request("GET", url, { timeout = 60 })
    
    if not ok then
        if code == -1 then
            -- A code of -1 from our helper means curl failed to execute or connect.
            -- This is a strong indicator that the Go application has terminated.
            print("Connection to Go server lost. Assuming shutdown.")
            return { command = "shutdown" }, "shutdown"
        end
        return nil, nil
    end

    if code == 204 then -- HTTP 204 No Content
        return nil, nil
    end

    local s, data = pcall(dkjson.decode, body)
    if not s then
        print("Failed to decode command from Go:", body)
        return nil, nil
    end

    return data, data.command
end

--- The main loop that replaces the HTTP server. It polls Go for commands.
function main_command_loop()
    print("Lua Backend: Entering main command loop, polling Go server.")
    local running = true
    while running do
        local data, command = poll_go_for_command(GO_SERVER_PORT)
        if command then
            if command == "shutdown" then
                print("Lua Backend: Received shutdown command. Exiting.")
                running = false
            else
                local ok, err = pcall(process_go_command, data)
                if not ok then
                    print(string.format("ERROR processing command '%s': %s", command, tostring(err)))
                    local task_id = data and data.params and data.params.taskId
                    send_result_with_alert("Lua Script Error", "An error occurred: " .. tostring(err), task_id)
                end
            end
        end
    end
    print("Lua Backend: Exited main command loop.")

--endregion

function init()
    local args = {}
    for i, v in ipairs(arg) do
        if v == "-gp" or v == "--go-port" then args.go_port = tonumber(arg[i+1])
        elseif v == "--standalone" then STANDALONE_MODE = true
        end
    end

    GO_SERVER_PORT = args.go_port or 8080

    if STANDALONE_MODE then
        main_logic.run(false)
        return
    end

    print(string.format("Lua Backend: Waiting for Go server to be ready on port %d...", GO_SERVER_PORT))
    local ready = false
    for i = 1, 30 do
        local ok, _, code = helpers.http_request("GET", string.format("http://localhost:%d/health", GO_SERVER_PORT))
        if ok and code == 200 then
            print("Lua Backend: Go server is ready.")
            ready = true
            break
        end
        print(string.format("Lua Backend: Waiting... (attempt %d/30)", i))
        helpers.sleep(1)
    end

    if not ready then
        print("Lua Backend: Go server did not become ready. Exiting.")
        return
    end

    main_command_loop()
end

-- Entry point
init()