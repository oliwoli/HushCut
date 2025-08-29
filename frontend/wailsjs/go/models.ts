export namespace main {
	
	export class AlertContent {
	    title: string;
	    message: string;
	    button_label: string;
	    button_url: string;
	
	    static createFrom(source: any = {}) {
	        return new AlertContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.message = source["message"];
	        this.button_label = source["button_label"];
	        this.button_url = source["button_url"];
	    }
	}
	export class EditInstruction {
	    source_start_frame: number;
	    source_end_frame: number;
	    start_frame: number;
	    end_frame: number;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new EditInstruction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source_start_frame = source["source_start_frame"];
	        this.source_end_frame = source["source_end_frame"];
	        this.start_frame = source["start_frame"];
	        this.end_frame = source["end_frame"];
	        this.enabled = source["enabled"];
	    }
	}
	export class FileSource {
	    bmd_media_pool_item: any;
	    file_path: string;
	    uuid: string;
	
	    static createFrom(source: any = {}) {
	        return new FileSource(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.bmd_media_pool_item = source["bmd_media_pool_item"];
	        this.file_path = source["file_path"];
	        this.uuid = source["uuid"];
	    }
	}
	export class NestedAudioTimelineItem {
	    source_file_path: string;
	    processed_file_name?: string;
	    start_frame: number;
	    end_frame: number;
	    source_start_frame: number;
	    source_end_frame: number;
	    duration: number;
	    source_channel?: number;
	    edit_instructions: EditInstruction[];
	    nested_items?: NestedAudioTimelineItem[];
	
	    static createFrom(source: any = {}) {
	        return new NestedAudioTimelineItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source_file_path = source["source_file_path"];
	        this.processed_file_name = source["processed_file_name"];
	        this.start_frame = source["start_frame"];
	        this.end_frame = source["end_frame"];
	        this.source_start_frame = source["source_start_frame"];
	        this.source_end_frame = source["source_end_frame"];
	        this.duration = source["duration"];
	        this.source_channel = source["source_channel"];
	        this.edit_instructions = this.convertValues(source["edit_instructions"], EditInstruction);
	        this.nested_items = this.convertValues(source["nested_items"], NestedAudioTimelineItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TimelineItem {
	    bmd_item: any;
	    bmd_mpi: any;
	    name: string;
	    id: string;
	    track_type: string;
	    track_index: number;
	    source_file_path: string;
	    processed_file_name?: string;
	    start_frame: number;
	    end_frame: number;
	    source_fps: number;
	    source_start_frame: number;
	    source_end_frame: number;
	    duration: number;
	    edit_instructions: EditInstruction[];
	    source_channel?: number;
	    link_group_id?: number;
	    type?: string;
	    nested_clips?: NestedAudioTimelineItem[];
	
	    static createFrom(source: any = {}) {
	        return new TimelineItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.bmd_item = source["bmd_item"];
	        this.bmd_mpi = source["bmd_mpi"];
	        this.name = source["name"];
	        this.id = source["id"];
	        this.track_type = source["track_type"];
	        this.track_index = source["track_index"];
	        this.source_file_path = source["source_file_path"];
	        this.processed_file_name = source["processed_file_name"];
	        this.start_frame = source["start_frame"];
	        this.end_frame = source["end_frame"];
	        this.source_fps = source["source_fps"];
	        this.source_start_frame = source["source_start_frame"];
	        this.source_end_frame = source["source_end_frame"];
	        this.duration = source["duration"];
	        this.edit_instructions = this.convertValues(source["edit_instructions"], EditInstruction);
	        this.source_channel = source["source_channel"];
	        this.link_group_id = source["link_group_id"];
	        this.type = source["type"];
	        this.nested_clips = this.convertValues(source["nested_clips"], NestedAudioTimelineItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SilenceInterval {
	    start: number;
	    end: number;
	
	    static createFrom(source: any = {}) {
	        return new SilenceInterval(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.start = source["start"];
	        this.end = source["end"];
	    }
	}
	export class FileProperties {
	    FPS: number;
	
	    static createFrom(source: any = {}) {
	        return new FileProperties(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.FPS = source["FPS"];
	    }
	}
	export class FileData {
	    properties: FileProperties;
	    processed_audio_path?: string;
	    silenceDetections?: SilenceInterval[];
	    timelineItems: TimelineItem[];
	    fileSource: FileSource;
	
	    static createFrom(source: any = {}) {
	        return new FileData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.properties = this.convertValues(source["properties"], FileProperties);
	        this.processed_audio_path = source["processed_audio_path"];
	        this.silenceDetections = this.convertValues(source["silenceDetections"], SilenceInterval);
	        this.timelineItems = this.convertValues(source["timelineItems"], TimelineItem);
	        this.fileSource = this.convertValues(source["fileSource"], FileSource);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class GithubAsset {
	    browser_download_url: string;
	    name: string;
	    size: number;
	    content_type: string;
	    digest: string;
	
	    static createFrom(source: any = {}) {
	        return new GithubAsset(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.browser_download_url = source["browser_download_url"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.content_type = source["content_type"];
	        this.digest = source["digest"];
	    }
	}
	export class GithubData {
	    tag_name: string;
	    html_url: string;
	    assets: GithubAsset[];
	
	    static createFrom(source: any = {}) {
	        return new GithubData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tag_name = source["tag_name"];
	        this.html_url = source["html_url"];
	        this.assets = this.convertValues(source["assets"], GithubAsset);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class PrecomputedWaveformData {
	    duration: number;
	    peaks: number[];
	
	    static createFrom(source: any = {}) {
	        return new PrecomputedWaveformData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.duration = source["duration"];
	        this.peaks = source["peaks"];
	    }
	}
	export class Timeline {
	    name: string;
	    fps: number;
	    project_fps: number;
	    start_timecode: string;
	    curr_timecode: string;
	    video_track_items: TimelineItem[];
	    audio_track_items: TimelineItem[];
	
	    static createFrom(source: any = {}) {
	        return new Timeline(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fps = source["fps"];
	        this.project_fps = source["project_fps"];
	        this.start_timecode = source["start_timecode"];
	        this.curr_timecode = source["curr_timecode"];
	        this.video_track_items = this.convertValues(source["video_track_items"], TimelineItem);
	        this.audio_track_items = this.convertValues(source["audio_track_items"], TimelineItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectDataPayload {
	    project_name: string;
	    timeline: Timeline;
	    files: Record<string, FileData>;
	
	    static createFrom(source: any = {}) {
	        return new ProjectDataPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.project_name = source["project_name"];
	        this.timeline = this.convertValues(source["timeline"], Timeline);
	        this.files = this.convertValues(source["files"], FileData, true);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PythonCommandResponse {
	    status: string;
	    message: string;
	    data?: any;
	    shouldShowAlert?: boolean;
	    alertTitle?: string;
	    alertMessage?: string;
	    alertSeverity?: string;
	    alertIssued?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PythonCommandResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.message = source["message"];
	        this.data = source["data"];
	        this.shouldShowAlert = source["shouldShowAlert"];
	        this.alertTitle = source["alertTitle"];
	        this.alertMessage = source["alertMessage"];
	        this.alertSeverity = source["alertSeverity"];
	        this.alertIssued = source["alertIssued"];
	    }
	}
	
	export class SilencePeriod {
	    start: number;
	    end: number;
	
	    static createFrom(source: any = {}) {
	        return new SilencePeriod(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.start = source["start"];
	        this.end = source["end"];
	    }
	}
	
	
	export class UpdateResponseV1 {
	    schema_version: number;
	    latest_version: string;
	    url: string;
	    update_label: string;
	    show_alert: boolean;
	    alert_content: AlertContent;
	    alert_severity: string;
	    github_data: GithubData;
	    signature: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateResponseV1(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema_version = source["schema_version"];
	        this.latest_version = source["latest_version"];
	        this.url = source["url"];
	        this.update_label = source["update_label"];
	        this.show_alert = source["show_alert"];
	        this.alert_content = this.convertValues(source["alert_content"], AlertContent);
	        this.alert_severity = source["alert_severity"];
	        this.github_data = this.convertValues(source["github_data"], GithubData);
	        this.signature = source["signature"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

