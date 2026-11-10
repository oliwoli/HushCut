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

// 4. Combined Overview reflects the average of constituent clips: (-25 + -40) / 2 = -32.5
const avgThreshold = store.getParameter(groupId, "threshold");
assert.strictEqual(avgThreshold, -32.5);
console.log("✓ Combined Overview displays the average of constituent clips with full precision");

// 5. Adjusting Combined Overview shifts all clips by delta while preserving the relative offset
// Average is -32.5. Let's set it to -30 (delta = +2.5).
store.setParameter(groupId, "threshold", -30);
// In setParameter:
// currentAvg = (-25 + -40) / 2 = -32.5
// delta = -30 - (-32.5) = +2.5
// clip1: -25 + 2.5 = -22.5
// clip2: -40 + 2.5 = -37.5
assert.strictEqual(store.getParameter(clip1, "threshold"), -22.5);
assert.strictEqual(store.getParameter(clip2, "threshold"), -37.5);
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

// 7. Bypassing the linked group globally does NOT change parameters in Combined Overview
const group3 = "linkgroup_3";
const g1 = "item_g1";
const g2 = "item_g2";
const g3 = "item_g3";
store.setClipToGroupMapping(
  { [g1]: group3, [g2]: group3, [g3]: group3 },
  { [group3]: [g1, g2, g3] }
);

// g1 is default (-30 dB), g2 is custom (-10 dB), g3 is custom (-20 dB)
store.setParameter(g2, "threshold", -10);
store.setParameter(g3, "threshold", -20);

// Initial average is (-30 + -10 + -20) / 3 = -20 dB
assert.strictEqual(store.getParameter(group3, "threshold"), -20);

// Bypassing the group globally must NOT cause g1 (un-customized) to inherit bypassed=true
// and get excluded from the Combined Overview calculation!
store.setParameter(group3, "bypassed", true);
assert.strictEqual(
  store.getParameter(group3, "threshold"),
  -20,
  "Bypassing the group globally must keep Combined Overview parameters unchanged"
);
assert.strictEqual(
  store.getParameter(g1, "bypassed"),
  false,
  "Un-customized local clip must not appear locally bypassed when group is bypassed globally"
);

// Un-bypassing the group globally keeps Combined Overview unchanged
store.setParameter(group3, "bypassed", false);
assert.strictEqual(store.getParameter(group3, "threshold"), -20);
console.log("✓ Bypassing/un-bypassing the group globally keeps Combined Overview parameters unchanged");

// 8. Locally bypassed clips are excluded from Combined Overview calculations
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

// Locally bypass 4 out of 5 clips
store.setParameter(c1, "bypassed", true);
store.setParameter(c2, "bypassed", true);
store.setParameter(c3, "bypassed", true);
store.setParameter(c5, "bypassed", true);

// Set the only active clip (c4) to -60 dB
store.setParameter(c4, "threshold", -60);

// Combined Overview reflects ONLY active local clips: (-60) / 1 = -60 dB (NOT -23 dB!)
assert.strictEqual(store.getParameter(group5, "threshold"), -60);
console.log("✓ Locally bypassed clips excluded from Combined Overview calculation (returns -60 dB, not -23 dB)");

// Adjusting Combined Overview in this state shifts c4 accordingly
store.setParameter(group5, "threshold", -50);
assert.strictEqual(store.getParameter(c4, "threshold"), -50);
assert.strictEqual(store.getParameter(group5, "threshold"), -50);
console.log("✓ Adjusting Combined Overview with locally bypassed clips shifts active clip");

// 9. Toggling group bypass preserves per-clip local bypass states
store.setParameter(c4, "bypassed", true);
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

// 10. Global reset (resetAllParametersToDefault) for standalone, local, and group clips
const soloClip = "solo_1";
store.setParameter(soloClip, "threshold", -45);
store.setParameter(soloClip, "minDuration", 1.2);
store.setParameter(soloClip, "paddingLeft", 0.3);
store.setParameter(soloClip, "paddingRight", 0.4);
store.setParameter(soloClip, "minContent", 0.5);
store.setParameter(soloClip, "paddingLocked", false);
store.setParameter(soloClip, "bypassed", true);

store.resetAllParametersToDefault(soloClip);
assert.strictEqual(store.getParameter(soloClip, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(soloClip, "minDuration"), defaultParameters.minDuration);
assert.strictEqual(store.getParameter(soloClip, "paddingLeft"), defaultParameters.paddingLeft);
assert.strictEqual(store.getParameter(soloClip, "paddingRight"), defaultParameters.paddingRight);
assert.strictEqual(store.getParameter(soloClip, "minContent"), defaultParameters.minContent);
assert.strictEqual(store.getParameter(soloClip, "paddingLocked"), defaultParameters.paddingLocked);
assert.strictEqual(store.getParameter(soloClip, "bypassed"), true, "Bypassed state should be preserved on global reset");
console.log("✓ Global reset on standalone clip resets all parameters to default while preserving bypass");

// Resetting a local constituent clip resets its parameters to defaultParameters
const groupReset = "linkgroup_reset";
const r1 = "item_r1";
const r2 = "item_r2";
store.setClipToGroupMapping(
  { [r1]: groupReset, [r2]: groupReset },
  { [groupReset]: [r1, r2] }
);
store.setParameter(r1, "threshold", -15);
store.setParameter(r1, "minDuration", 1.1);
assert.strictEqual(isConstituentClipOverridden(r1, useClipStore.getState().parameters), true);

store.resetAllParametersToDefault(r1);
assert.strictEqual(store.getParameter(r1, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(r1, "minDuration"), defaultParameters.minDuration);
assert.strictEqual(isConstituentClipOverridden(r1, useClipStore.getState().parameters), false);
console.log("✓ Global reset on local clip resets its parameters to default and clears override");

// Resetting a group resets group and all constituent clips to default while preserving bypass flags
store.setParameter(r1, "threshold", -12);
store.setParameter(r2, "minDuration", 1.5);
store.setParameter(r2, "bypassed", true);
assert.strictEqual(isConstituentClipOverridden(r1, useClipStore.getState().parameters), true);
assert.strictEqual(isConstituentClipOverridden(r2, useClipStore.getState().parameters), true);

store.resetAllParametersToDefault(groupReset);
assert.strictEqual(store.getParameter(groupReset, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(groupReset, "minDuration"), defaultParameters.minDuration);
assert.strictEqual(store.getParameter(r1, "threshold"), defaultParameters.threshold);
assert.strictEqual(store.getParameter(r2, "minDuration"), defaultParameters.minDuration);
assert.strictEqual(store.getParameter(r2, "bypassed"), true, "Local bypass preserved after group global reset");
assert.strictEqual(isConstituentClipOverridden(r1, useClipStore.getState().parameters), false);
assert.strictEqual(
  isConstituentClipOverridden(r2, useClipStore.getState().parameters),
  false,
  "Bypassed-only constituent clip is not marked as custom overridden"
);
console.log("✓ Global reset on group resets all parameters and clears local custom overrides");

console.log("All clipStore unit tests passed successfully!");
