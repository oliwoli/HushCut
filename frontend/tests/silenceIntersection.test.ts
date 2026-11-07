import assert from "node:assert";
import { intersectTwoSilenceLists, intersectMultipleSilenceLists } from "../src/lib/clipUtils.ts";

console.log("Running silenceIntersection unit tests...");

// 1. Two non-overlapping silence lists
const a1 = [{ start: 0, end: 5 }];
const b1 = [{ start: 6, end: 10 }];
assert.deepStrictEqual(intersectTwoSilenceLists(a1, b1), []);
console.log("✓ Non-overlapping silences yield empty intersection");

// 2. Overlapping silence lists
const a2 = [{ start: 2, end: 10 }];
const b2 = [{ start: 5, end: 12 }];
assert.deepStrictEqual(intersectTwoSilenceLists(a2, b2), [{ start: 5, end: 10 }]);
console.log("✓ Overlapping silences yield exact overlap");

// 3. One track completely silent, one track talking with pauses
const allSilent = [{ start: 0, end: 100 }];
const talkingWithPauses = [
  { start: 10, end: 20 },
  { start: 50, end: 60 },
];
assert.deepStrictEqual(intersectTwoSilenceLists(allSilent, talkingWithPauses), [
  { start: 10, end: 20 },
  { start: 50, end: 60 },
]);
console.log("✓ Silence intersecting with full silence preserves the pauses");

// 4. One track talking continuously (no silences)
const continuousSound: Array<{ start: number; end: number }> = [];
assert.deepStrictEqual(intersectTwoSilenceLists(talkingWithPauses, continuousSound), []);
console.log("✓ Continuous talking track prevents cuts across the group");

// 5. Multi-track intersection (e.g. 3 tracks)
const track1 = [{ start: 0, end: 30 }];
const track2 = [{ start: 10, end: 40 }];
const track3 = [{ start: 20, end: 50 }];
assert.deepStrictEqual(intersectMultipleSilenceLists([track1, track2, track3]), [{ start: 20, end: 30 }]);
console.log("✓ Multi-track intersection yields common silence across all active tracks");

// 6. Single track list (e.g. only 1 active track, others bypassed)
assert.deepStrictEqual(intersectMultipleSilenceLists([track1]), track1);
console.log("✓ Single active track returns its own silence list identically");

console.log("All silenceIntersection unit tests passed successfully!");
