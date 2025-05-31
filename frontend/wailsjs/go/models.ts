export namespace main {
	
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
	export class TimelineItem {
	    bmd_item: any;
	    name: string;
	    id: string;
	    track_type: string;
	    track_index: number;
	    source_file_path: string;
	    processed_file_name: string;
	    start_frame: number;
	    end_frame: number;
	    source_start_frame: number;
	    source_end_frame: number;
	    duration: number;
	    edit_instructions: EditInstruction[];
	
	    static createFrom(source: any = {}) {
	        return new TimelineItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.bmd_item = source["bmd_item"];
	        this.name = source["name"];
	        this.id = source["id"];
	        this.track_type = source["track_type"];
	        this.track_index = source["track_index"];
	        this.source_file_path = source["source_file_path"];
	        this.processed_file_name = source["processed_file_name"];
	        this.start_frame = source["start_frame"];
	        this.end_frame = source["end_frame"];
	        this.source_start_frame = source["source_start_frame"];
	        this.source_end_frame = source["source_end_frame"];
	        this.duration = source["duration"];
	        this.edit_instructions = this.convertValues(source["edit_instructions"], EditInstruction);
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
	    silenceDetections?: SilenceInterval[];
	    timelineItems: TimelineItem[];
	    fileSource: FileSource;
	
	    static createFrom(source: any = {}) {
	        return new FileData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.properties = this.convertValues(source["properties"], FileProperties);
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
	    video_track_items: TimelineItem[];
	    audio_track_items: TimelineItem[];
	
	    static createFrom(source: any = {}) {
	        return new Timeline(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fps = source["fps"];
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
	
	    static createFrom(source: any = {}) {
	        return new PythonCommandResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.message = source["message"];
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
	

}

