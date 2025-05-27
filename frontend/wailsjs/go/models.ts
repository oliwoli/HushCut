export namespace main {
	
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

