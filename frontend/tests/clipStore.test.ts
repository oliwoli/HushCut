import assert from "node:assert";
import { useClipStore, defaultParameters, isConstituentClipOverridden } from "../src/stores/clipStore.ts";

console.log("Running clipStore unit tests...");

const store = useClipStore.getState();

// Setup group mapping
const groupId = "linkgroup_10";
const clip1 = "item_a1";
const clip2 = "item_a2";

store.setClipToGroupMapping(
  { [clip1]: groupId, [clip2]: groupId },
  { [groupId]: [clip1, clip2] }
);

// 1. Initial parameters should match defaultParameters
assert.strictEqual(store.getParameter(groupId, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(clip1, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(clip2, "threshold"), defaultParameters.threshold);
assert.strictEqual(isConstituentClipOverridden(clip1, useClipStore.getState().parameters), false);
assert.strictEqual(isConstituentClipOverridden(clip2, useClipStore.getState().parameters), false);
console.log("✓ Initial group and constituent parameters match defaults");

// 2. Adjusting parameter in Combined Overview shifts all clips uniformly
store.setParameter(groupId, "threshold", -40);
assert.strictEqual(store.getParameter(groupId, "threshold"), -40);
assert.strictEqual(store.getParameter(clip1, "threshold"), -40);
assert.strictEqual(store.getParameter(clip2, "threshold"), -40);
// Neither constituent is overridden individually yet
assert.strictEqual(isConstituentClipOverridden(clip1, useClipStore.getState().parameters), false);
assert.strictEqual(isConstituentClipOverridden(clip2, useClipStore.getState().parameters), false);
console.log("✓ Combined Overview parameter change shifts all constituent clips");

// 3. Modifying clip1 in Local View creates an override for clip1
store.setParameter(clip1, "threshold", -25);
assert.strictEqual(store.getParameter(clip1, "threshold"), -25);
assert.strictEqual(store.getParameter(clip2, "threshold"), -40);
assert.strictEqual(isConstituentClipOverridden(clip1, useClipStore.getState().parameters), true);
assert.strictEqual(isConstituentClipOverridden(clip2, useClipStore.getState().parameters), false);
console.log("✓ Local view override creates per-clip customization");

// 4. Combined Overview reflects the average of constituent clips: (-25 + -40) / 2 = -32.5 -> -32 (Math.round in JS)
const avgThreshold = store.getParameter(groupId, "threshold");
assert.strictEqual(avgThreshold, -32);
console.log("✓ Combined Overview displays the average of constituent clips");

// 5. Adjusting Combined Overview shifts all clips by delta while preserving the relative offset
// Average is -32.5. Let's set it to -30 (delta = +2.5).
store.setParameter(groupId, "threshold", -30);
// In setParameter:
// currentAvg = (-25 + -40) / 2 = -32.5
// delta = -30 - (-32.5) = +2.5
// clip1: -25 + 2.5 = -22.5 -> Math.round(-22.5) = -22 (or clamped)
// clip2: -40 + 2.5 = -37.5 -> Math.round(-37.5) = -37 (or clamped)
assert.strictEqual(store.getParameter(clip1, "threshold"), -22);
assert.strictEqual(store.getParameter(clip2, "threshold"), -37);
// clip1 is still overridden, clip2 is not
assert.strictEqual(isConstituentClipOverridden(clip1, useClipStore.getState().parameters), true);
assert.strictEqual(isConstituentClipOverridden(clip2, useClipStore.getState().parameters), false);
console.log("✓ Adjusting Combined Overview shifts constituent clips relatively and preserves overrides");

// 6. Resetting parameter on group resets all constituents and clears overrides
store.resetParameterToDefault(groupId, "threshold");
assert.strictEqual(store.getParameter(groupId, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(clip1, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(clip2, "threshold"), defaultParameters.threshold);
assert.strictEqual(isConstituentClipOverridden(clip1, useClipStore.getState().parameters), false);
assert.strictEqual(isConstituentClipOverridden(clip2, useClipStore.getState().parameters), false);
console.log("✓ Resetting group resets all constituent clips to default and clears overrides");

// 7. Bypassed clips are excluded from Combined Overview calculations
const group5 = "linkgroup_5";
const c1 = "item_c1";
const c2 = "item_c2";
const c3 = "item_c3";
const c4 = "item_c4";
const c5 = "item_c5";
store.setClipToGroupMapping(
  { [c1]: group5, [c2]: group5, [c3]: group5, [c4]: group5, [c5]: group5 },
  { [group5]: [c1, c2, c3, c4, c5] }
);

// Bypass 4 out of 5 clips
store.setParameter(c1, "bypassed", true);
store.setParameter(c2, "bypassed", true);
store.setParameter(c3, "bypassed", true);
store.setParameter(c5, "bypassed", true);

// Set the only active clip (c4) to -60 dB
store.setParameter(c4, "threshold", -60);

// Combined Overview must reflect ONLY active clips: (-60) / 1 = -60 dB (NOT -23 dB!)
assert.strictEqual(store.getParameter(group5, "threshold"), -60);
console.log("✓ Bypassed clips excluded from Combined Overview calculation (returns -60 dB, not -23 dB)");

// Adjusting Combined Overview in this state shifts c4 accordingly
store.setParameter(group5, "threshold", -50);
assert.strictEqual(store.getParameter(c4, "threshold"), -50);
assert.strictEqual(store.getParameter(group5, "threshold"), -50);
console.log("✓ Adjusting Combined Overview with bypassed clips shifts only active clip");

// 8. Toggling group bypass preserves per-clip local bypass states
store.setParameter(c4, "bypassed", true);
// All c1..c5 are now bypassed
for (const cid of [c1, c2, c3, c4, c5]) {
  assert.strictEqual(store.getParameter(cid, "bypassed"), true);
}

// Bypass group, then re-enable group
store.setParameter(group5, "bypassed", true);
assert.strictEqual(store.getParameter(group5, "bypassed"), true);
store.setParameter(group5, "bypassed", false);
assert.strictEqual(store.getParameter(group5, "bypassed"), false);

// All constituent clips must still be bypassed!
for (const cid of [c1, c2, c3, c4, c5]) {
  assert.strictEqual(
    store.getParameter(cid, "bypassed"),
    true,
    `Constituent clip ${cid} should still be bypassed after group is re-enabled`
  );
}
console.log("✓ Toggling group bypass preserves per-clip local bypass states");

console.log("All clipStore unit tests passed successfully!");
