import assert from "node:assert";
import {
  buildDisplayClips,
  formatTrackIndices,
  createActiveFileFromDisplayClip,
  deriveAllClipDetectionParams,
} from "../src/lib/clipUtils.ts";

console.log("Running clipUtils unit tests...");

// 1. Test formatTrackIndices
assert.strictEqual(formatTrackIndices([]), "");
assert.strictEqual(formatTrackIndices([1]), "A1");
assert.strictEqual(formatTrackIndices([1, 2]), "A1, A2");
assert.strictEqual(formatTrackIndices([2, 1]), "A1, A2");
assert.strictEqual(formatTrackIndices([1, 3]), "A1, A3");
assert.strictEqual(formatTrackIndices([1, 2, 3]), "A1–A3");
assert.strictEqual(formatTrackIndices([1, 2, 3, 4]), "A1–A4");
console.log("✓ formatTrackIndices passed");

// 2. Test buildDisplayClips: Multi-audio linked group vs single audio clip linked to video
const itemA1: any = {
  id: "item_a1",
  name: "Interview Shot",
  start_frame: 100,
  end_frame: 200,
  duration: 100,
  source_start_frame: 50,
  source_end_frame: 150,
  track_index: 1,
  link_group_id: 10,
  processed_file_name: "item_a1.wav",
  source_file_path: "/media/video.mp4",
};

const itemA2: any = {
  id: "item_a2",
  name: "Interview Shot - Lav",
  start_frame: 100,
  end_frame: 200,
  duration: 100,
  source_start_frame: 50,
  source_end_frame: 150,
  track_index: 2,
  link_group_id: 10,
  processed_file_name: "item_a2.wav",
  source_file_path: "/media/video.mp4",
};

// Single audio linked to video track only (group 20 has only 1 audio item)
const itemSingleAudioLinked: any = {
  id: "item_single",
  name: "B-Roll Audio",
  start_frame: 250,
  end_frame: 350,
  duration: 100,
  source_start_frame: 0,
  source_end_frame: 100,
  track_index: 1,
  link_group_id: 20, // Linked to V1 only
  processed_file_name: "item_single.wav",
  source_file_path: "/media/broll.mp4",
};

// Unlinked audio clip
const itemUnlinked: any = {
  id: "item_unlinked",
  name: "Sound FX",
  start_frame: 400,
  end_frame: 450,
  duration: 50,
  source_start_frame: 0,
  source_end_frame: 50,
  track_index: 3,
  link_group_id: null,
  processed_file_name: "item_unlinked.wav",
  source_file_path: "/media/sfx.wav",
};

const linkedAudioGroups: any = {
  "10": {
    group_id: 10,
    processed_file_name: "linkgroup_10_abc123.wav",
    start_frame: 100,
    end_frame: 200,
    duration: 100,
    track_indices: [1, 2],
    item_ids: ["item_a1", "item_a2"],
  },
  // Notice group 20 is NOT in linkedAudioGroups because it only has 1 audio item!
};

const rawAudioItems = [itemA1, itemA2, itemSingleAudioLinked, itemUnlinked];
const displayClips = buildDisplayClips(rawAudioItems, linkedAudioGroups);

// Expected: 3 display clips total (itemA1 and itemA2 collapsed into 1; itemSingleAudioLinked is 1; itemUnlinked is 1)
assert.strictEqual(displayClips.length, 3);

// First display clip: Combined multi-audio group 10
const groupClip = displayClips[0];
assert.strictEqual(groupClip.id, "linkgroup_10");
assert.strictEqual(groupClip.is_linked_group, true);
assert.strictEqual(groupClip.track_label, "A1, A2");
assert.strictEqual(groupClip.processed_file_name, "linkgroup_10_abc123.wav");
assert.strictEqual(groupClip.source_start_frame, 0);
assert.strictEqual(groupClip.source_end_frame, 100);
assert.deepStrictEqual(groupClip.constituent_item_ids, ["item_a1", "item_a2"]);
assert.deepStrictEqual(groupClip.constituent_processed_file_names, ["item_a1.wav", "item_a2.wav"]);
console.log("✓ multi-audio group collapsed with is_linked_group=true and correct mixdown wav");

// Second display clip: Single audio linked to video track only (Group 20)
const singleLinkedClip = displayClips[1];
assert.strictEqual(singleLinkedClip.id, "item_single");
assert.strictEqual(singleLinkedClip.is_linked_group, false); // Crucial! Must NOT have is_linked_group=true
assert.strictEqual(singleLinkedClip.track_label, "A1");
assert.strictEqual(singleLinkedClip.processed_file_name, "item_single.wav");
assert.deepStrictEqual(singleLinkedClip.constituent_processed_file_names, ["item_single.wav"]);
console.log("✓ single audio linked to video has is_linked_group=false (no ClipLinkIcon)");

// Third display clip: Unlinked audio item
const unlinkedClip = displayClips[2];
assert.strictEqual(unlinkedClip.id, "item_unlinked");
assert.strictEqual(unlinkedClip.is_linked_group, false);
assert.strictEqual(unlinkedClip.track_label, "A3");
console.log("✓ unlinked audio item handled properly");

// 3. Test createActiveFileFromDisplayClip for linked group
const activeFile = createActiveFileFromDisplayClip(groupClip, 9245, 30);
assert.ok(activeFile);
assert.strictEqual(activeFile?.id, "linkgroup_10");
assert.strictEqual(activeFile?.processedFileName, "linkgroup_10_abc123.wav");
assert.strictEqual(activeFile?.sourceStartFrame, 0);
assert.strictEqual(activeFile?.sourceEndFrame, 100);
assert.strictEqual(
  activeFile?.previewUrl,
  `http://localhost:9245/render_clip?file=linkgroup_10_abc123.wav&start=0&end=${100 / 30}`
);
console.log("✓ createActiveFileFromDisplayClip generates correct previewUrl and active clip");

// 4. Test deriveAllClipDetectionParams inheritance from group
const mockClipStoreState: any = {
  parameters: {
    "linkgroup_10": {
      threshold: -45,
      minDuration: 0.8,
      paddingLeft: 0.1,
      paddingRight: 0.1,
      minContent: 0.2,
      paddingLocked: true,
      bypassed: false,
    },
    "item_unlinked": {
      threshold: -25,
      minDuration: 0.3,
      paddingLeft: 0.05,
      paddingRight: 0.05,
      minContent: 0.1,
      paddingLocked: true,
      bypassed: false,
    },
  },
  liveDefaultParameters: {
    threshold: -30,
    minDuration: 0.5,
    paddingLeft: 0.05,
    paddingRight: 0.05,
    minContent: 0.1,
    paddingLocked: true,
    bypassed: false,
  },
};

const derivedParams = deriveAllClipDetectionParams(rawAudioItems, mockClipStoreState);
// Both item_a1 and item_a2 must inherit threshold: -45 from linkgroup_10!
assert.strictEqual(derivedParams["item_a1"]?.loudnessThreshold, -45);
assert.strictEqual(derivedParams["item_a2"]?.loudnessThreshold, -45);
// item_single (linked to video only, no linkgroup_20 params) falls back to live default -30
assert.strictEqual(derivedParams["item_single"]?.loudnessThreshold, -30);
// item_unlinked has its own params (-25)
assert.strictEqual(derivedParams["item_unlinked"]?.loudnessThreshold, -25);
console.log("✓ deriveAllClipDetectionParams propagates group parameters to all constituent items");

// Test group bypass
mockClipStoreState.parameters["linkgroup_10"].bypassed = true;
const bypassedParams = deriveAllClipDetectionParams(rawAudioItems, mockClipStoreState);
assert.strictEqual(bypassedParams["item_a1"], undefined);
assert.strictEqual(bypassedParams["item_a2"], undefined);
assert.ok(bypassedParams["item_single"]);
console.log("✓ group bypass correctly excludes all constituent items from processing");

console.log("All clipUtils unit tests passed successfully!");
