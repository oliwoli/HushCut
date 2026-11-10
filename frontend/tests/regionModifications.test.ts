import assert from "node:assert";
import {
  postProcessSilencesWithModifications,
  intersectMultipleSilenceLists,
} from "../src/lib/clipUtils.ts";
import { useClipStore } from "../src/stores/clipStore.ts";

console.log("Running regionModifications unit tests...");

const rawSilences = [
  { start: 0.02, end: 0.4 },
  { start: 1.0, end: 2.2 },
  { start: 2.35, end: 3.1 },
  { start: 5.0, end: 5.12 },
  { start: 7.0, end: 8.5 },
  { start: 9.85, end: 9.98 },
];

// 1. Parity test with Go's DetectSilences post-processing when no modifications exist
{
  const result = postProcessSilencesWithModifications(
    rawSilences,
    {
      minSilenceDurationSeconds: 0.25,
      paddingLeftSeconds: 0.05,
      paddingRightSeconds: 0.05,
      minContent: 0.3,
    },
    0.0,
    10.0
  );

  // Expected:
  // - [0.02, 0.40] -> padded [0.07, 0.35] (dur 0.28 >= 0.25), snaps start to 0.0 because 0.07 < minContent(0.30) -> [0.0, 0.35]
  // - [1.00, 2.20] -> padded [1.05, 2.15] (dur 1.10 >= 0.25)
  // - [2.35, 3.10] -> padded [2.40, 3.05] (dur 0.65 >= 0.25), merges with [1.05, 2.15] because gap (2.40 - 2.15 = 0.25) < minContent(0.30) -> [1.05, 3.05]
  // - [5.00, 5.12] -> padded [5.05, 5.07] (dur 0.02 < 0.25) -> filtered out
  // - [7.00, 8.50] -> padded [7.05, 8.45] (dur 1.40 >= 0.25)
  // - [9.85, 9.98] -> padded [9.90, 9.93] (dur 0.03 < 0.25) -> filtered out
  assert.strictEqual(result.length, 3);
  assert(Math.abs(result[0].start - 0.0) < 1e-6 && Math.abs(result[0].end - 0.35) < 1e-6);
  assert(Math.abs(result[1].start - 1.05) < 1e-6 && Math.abs(result[1].end - 3.05) < 1e-6);
  assert(Math.abs(result[2].start - 7.05) < 1e-6 && Math.abs(result[2].end - 8.45) < 1e-6);
  assert(result.every((r) => !r.isModified));
  console.log("✓ Split raw detection + post-processing matches legacy single-pass output");
}

// 2. Modified region responds to Padding and Minimum Duration
{
  // Region [7.0, 8.5] has centerTime = 7.75. Shift start by -0.2s and end by +0.3s.
  const mods = [{ id: "mod_1", centerTime: 7.75, deltaStart: -0.2, deltaEnd: 0.3 }];

  const withZeroPadding = postProcessSilencesWithModifications(
    [{ start: 7.0, end: 8.5 }],
    {
      minSilenceDurationSeconds: 0.2,
      paddingLeftSeconds: 0,
      paddingRightSeconds: 0,
      minContent: 0,
    },
    0,
    10,
    mods
  );
  assert.strictEqual(withZeroPadding.length, 1);
  assert(Math.abs(withZeroPadding[0].start - 6.8) < 1e-6);
  assert(Math.abs(withZeroPadding[0].end - 8.8) < 1e-6);
  assert.strictEqual(withZeroPadding[0].isModified, true);
  assert.strictEqual(withZeroPadding[0].startModified, true);
  assert.strictEqual(withZeroPadding[0].endModified, true);

  // Increase padding to 0.1s on both sides -> [6.9, 8.7]
  const withPadding = postProcessSilencesWithModifications(
    [{ start: 7.0, end: 8.5 }],
    {
      minSilenceDurationSeconds: 0.2,
      paddingLeftSeconds: 0.1,
      paddingRightSeconds: 0.1,
      minContent: 0,
    },
    0,
    10,
    mods
  );
  assert(Math.abs(withPadding[0].start - 6.9) < 1e-6);
  assert(Math.abs(withPadding[0].end - 8.7) < 1e-6);
  assert.strictEqual(withPadding[0].isModified, true);

  // Increase minSilenceDurationSeconds beyond modified duration (1.8s < 2.0s) -> filtered out
  const filteredOut = postProcessSilencesWithModifications(
    [{ start: 7.0, end: 8.5 }],
    {
      minSilenceDurationSeconds: 2.0,
      paddingLeftSeconds: 0.1,
      paddingRightSeconds: 0.1,
      minContent: 0,
    },
    0,
    10,
    mods
  );
  assert.strictEqual(filteredOut.length, 0);
  console.log("✓ Modified region is dynamically affected by Padding and Minimum Duration");
}

// 3. Silence Threshold change preserves modification via midpoint epsilon logic
{
  // Original raw silence was [7.0, 8.5] (midpoint 7.75).
  // After threshold change, FFmpeg detects raw silence [7.15, 8.35] (midpoint 7.75) or [7.2, 8.6] (midpoint 7.9, within 0.75s leeway).
  const mods = [{ id: "mod_thresh", centerTime: 7.75, deltaStart: 0.15, deltaEnd: -0.1 }];
  const newRawAfterThresholdChange = [{ start: 7.2, end: 8.6 }];

  const result = postProcessSilencesWithModifications(
    newRawAfterThresholdChange,
    {
      minSilenceDurationSeconds: 0.1,
      paddingLeftSeconds: 0.05,
      paddingRightSeconds: 0.05,
      minContent: 0,
    },
    0,
    10,
    mods
  );
  assert.strictEqual(result.length, 1);
  // baseStart = 7.2 + 0.05 = 7.25; + deltaStart(0.15) = 7.40
  // baseEnd = 8.6 - 0.05 = 8.55; + deltaEnd(-0.10) = 8.45
  assert(Math.abs(result[0].start - 7.4) < 1e-6);
  assert(Math.abs(result[0].end - 8.45) < 1e-6);
  assert.strictEqual(result[0].isModified, true);
  console.log("✓ Midpoint epsilon logic preserves modification across Silence Threshold changes");
}

// 4. Silence Merge (minContent) directional modification inheritance rules
{
  const twoRegions = [
    { start: 1.0, end: 2.0 }, // midpoint 1.5
    { start: 2.2, end: 3.2 }, // midpoint 2.7 (gap = 0.2s)
  ];

  // Case 4a: Left region has startModified=true, endModified=false; merges with unmodified right region
  // -> Inherits start modification, merged region is violet (isModified = true)
  const mergedLeftStartMod = postProcessSilencesWithModifications(
    twoRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.5 },
    0,
    10,
    [{ id: "m_left_start", centerTime: 1.5, deltaStart: -0.25, deltaEnd: 0 }]
  );
  assert.strictEqual(mergedLeftStartMod.length, 1);
  assert(Math.abs(mergedLeftStartMod[0].start - 0.75) < 1e-6);
  assert(Math.abs(mergedLeftStartMod[0].end - 3.2) < 1e-6);
  assert.strictEqual(mergedLeftStartMod[0].startModified, true);
  assert.strictEqual(mergedLeftStartMod[0].endModified, false);
  assert.strictEqual(mergedLeftStartMod[0].isModified, true);
  assert.deepStrictEqual(mergedLeftStartMod[0].modificationIds, ["m_left_start"]);

  // Case 4b: Left region has startModified=false, endModified=true; merges with right region
  // -> Since it is a user modification, the whole merged silence region becomes modified (isModified = true)
  const mergedLeftEndModOnly = postProcessSilencesWithModifications(
    twoRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.5 },
    0,
    10,
    [{ id: "m_left_end", centerTime: 1.5, deltaStart: 0, deltaEnd: 0.05 }]
  );
  assert.strictEqual(mergedLeftEndModOnly.length, 1);
  assert(Math.abs(mergedLeftEndModOnly[0].start - 1.0) < 1e-6);
  assert(Math.abs(mergedLeftEndModOnly[0].end - 3.2) < 1e-6);
  assert.strictEqual(mergedLeftEndModOnly[0].isModified, true);
  assert.deepStrictEqual(mergedLeftEndModOnly[0].modificationIds, ["m_left_end"]);

  // Case 4c: Unmodified left region merges with right region that has startModified=false, endModified=true
  // -> Inherits end modification, merged region is violet (isModified = true)
  const mergedRightEndMod = postProcessSilencesWithModifications(
    twoRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.5 },
    0,
    10,
    [{ id: "m_right_end", centerTime: 2.7, deltaStart: 0, deltaEnd: 0.4 }]
  );
  assert.strictEqual(mergedRightEndMod.length, 1);
  assert(Math.abs(mergedRightEndMod[0].start - 1.0) < 1e-6);
  assert(Math.abs(mergedRightEndMod[0].end - 3.6) < 1e-6);
  assert.strictEqual(mergedRightEndMod[0].endModified, true);
  assert.strictEqual(mergedRightEndMod[0].isModified, true);
  assert.deepStrictEqual(mergedRightEndMod[0].modificationIds, ["m_right_end"]);

  // Case 4d: Multi-region merge: dragging region 1's end handle past region 2 into region 3 merges all 3 at once
  const threeRegions: SilencePeriod[] = [
    { start: 1.0, end: 2.0 },
    { start: 3.0, end: 4.0 },
    { start: 5.0, end: 6.0 },
  ];
  // Drag region 1 end handle from 2.0 all the way to 5.2 (past region 2 and into region 3)
  const mergedMulti = postProcessSilencesWithModifications(
    threeRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.2 },
    0,
    10,
    [{ id: "m_drag_past_all", centerTime: 1.5, deltaStart: 0, deltaEnd: 3.2 }] // 2.0 + 3.2 = 5.2
  );
  assert.strictEqual(mergedMulti.length, 1);
  assert(Math.abs(mergedMulti[0].start - 1.0) < 1e-6);
  assert(Math.abs(mergedMulti[0].end - 6.0) < 1e-6);
  assert.strictEqual(mergedMulti[0].isModified, true);
  assert.deepStrictEqual(mergedMulti[0].modificationIds, ["m_drag_past_all"]);

  // Case 4e: Unmodified regions merging solely due to minContent slider stays unmodified (isModified = false)
  const mergedUnmodified = postProcessSilencesWithModifications(
    twoRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.5 },
    0,
    10,
    []
  );
  assert.strictEqual(mergedUnmodified.length, 1);
  assert.strictEqual(mergedUnmodified[0].isModified, false);
  assert.deepStrictEqual(mergedUnmodified[0].modificationIds, []);
  assert(Math.abs(mergedRightEndMod[0].end - 3.6) < 1e-6);
  assert.strictEqual(mergedRightEndMod[0].startModified, false);
  assert.strictEqual(mergedRightEndMod[0].endModified, true);
  assert.strictEqual(mergedRightEndMod[0].isModified, true);
  assert.deepStrictEqual(mergedRightEndMod[0].modificationIds, ["m_right_end"]);

  // Case 4d2: Unmodified left region merges with right region that has startModified=true, endModified=false
  // -> Since right region was modified by user, merged region becomes violet (isModified = true)
  const mergedRightStartModOnly = postProcessSilencesWithModifications(
    twoRegions,
    { minSilenceDurationSeconds: 0.1, paddingLeftSeconds: 0, paddingRightSeconds: 0, minContent: 0.5 },
    0,
    10,
    [{ id: "m_right_start", centerTime: 2.7, deltaStart: -0.05, deltaEnd: 0 }]
  );
  assert.strictEqual(mergedRightStartModOnly.length, 1);
  assert(Math.abs(mergedRightStartModOnly[0].start - 1.0) < 1e-6);
  assert(Math.abs(mergedRightStartModOnly[0].end - 3.2) < 1e-6);
  assert.strictEqual(mergedRightStartModOnly[0].isModified, true);
  assert.deepStrictEqual(mergedRightStartModOnly[0].modificationIds, ["m_right_start"]);

  console.log("✓ Silence Merge (minContent) directional modification inheritance works as specified");
}

// 5. Store operations: upsert, remove single region modification, and global reset
{
  const store = useClipStore.getState();
  store.clearRegionModifications("clip_1");

  store.upsertRegionModification("clip_1", {
    id: "mod_a",
    centerTime: 2.5,
    deltaStart: -0.15,
  });
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1").length, 1);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1")[0].deltaStart, -0.15);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1")[0].deltaEnd, 0);

  // Update end delta on same region
  store.upsertRegionModification("clip_1", {
    id: "mod_a",
    centerTime: 2.5,
    deltaEnd: 0.25,
  });
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1").length, 1);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1")[0].deltaStart, -0.15);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1")[0].deltaEnd, 0.25);

  // Add second region modification
  store.upsertRegionModification("clip_1", {
    id: "mod_b",
    centerTime: 8.0,
    deltaStart: 0.1,
  });
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1").length, 2);

  // Right-click "Reset Region" removes only mod_a
  store.removeRegionModifications("clip_1", ["mod_a"]);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1").length, 1);
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1")[0].id, "mod_b");

  // Global reset on clip_1 clears remaining region modifications
  store.resetAllParametersToDefault("clip_1");
  assert.strictEqual(useClipStore.getState().getRegionModifications("clip_1").length, 0);

  console.log("✓ ClipStore region modification upsert, per-region reset, and global reset work properly");
}

console.log("All regionModifications unit tests passed successfully!");
