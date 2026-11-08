"""
Automated unit tests for HushCut Python backend unification and linking logic.
These tests run standalone without requiring DaVinci Resolve to be running.
"""

import copy
import json
import os
import sys
import tempfile
import unittest

# Ensure python-backend/src is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import HushCut


class TestHushCutUnification(unittest.TestCase):
    def setUp(self):
        # Reset global state
        HushCut.PROJECT_DATA = None

    def test_unlinked_clips_not_unified_or_grouped(self):
        """
        Unlinked clips (link_group_id is None) must NEVER have their edits
        overwritten, must NOT receive synthetic group IDs, and must NOT be linked.
        """
        pd = {
            "timeline": {
                "name": "Test Timeline",
                "fps": 60.0,
                "project_fps": 60.0,
                "video_track_items": [],
                "audio_track_items": [
                    {
                        "id": "a1_unlinked",
                        "name": "mic.wav",
                        "track_index": 1,
                        "track_type": "audio",
                        "start_frame": 0,
                        "end_frame": 1000,
                        "source_start_frame": 0,
                        "source_end_frame": 1000,
                        "source_fps": 60.0,
                        "link_group_id": None,
                        "edit_instructions": [
                            {"start_frame": 0, "end_frame": 100, "source_start_frame": 0, "source_end_frame": 100, "enabled": True},
                            {"start_frame": 100, "end_frame": 200, "source_start_frame": 100, "source_end_frame": 200, "enabled": False},
                            {"start_frame": 200, "end_frame": 1000, "source_start_frame": 200, "source_end_frame": 1000, "enabled": True},
                        ],
                    },
                    {
                        "id": "a2_unlinked",
                        "name": "mic.wav",
                        "track_index": 2,
                        "track_type": "audio",
                        "start_frame": 0,
                        "end_frame": 1000,
                        "source_start_frame": 0,
                        "source_end_frame": 1000,
                        "source_fps": 60.0,
                        "link_group_id": None,
                        "edit_instructions": [],
                    },
                ],
            }
        }
        HushCut.PROJECT_DATA = copy.deepcopy(pd)

        # Create dummy OTIO with unlinked items
        otio_dummy = {
            "global_start_time": {"rate": 60, "value": 0},
            "tracks": {
                "children": [
                    {
                        "kind": "Audio",
                        "children": [
                            {"name": "mic.wav", "source_range": {"duration": {"value": 1000, "rate": 60}}},
                            {"name": "mic.wav", "source_range": {"duration": {"value": 1000, "rate": 60}}},
                        ],
                    }
                ]
            },
        }

        with tempfile.NamedTemporaryFile("w", suffix=".otio", delete=False) as f:
            json.dump(otio_dummy, f)
            otio_path = f.name

        try:
            HushCut.unify_linked_items_in_project_data(otio_path)
            result = HushCut.PROJECT_DATA

            # 1. link_group_id must remain None
            self.assertIsNone(result["timeline"]["audio_track_items"][0].get("link_group_id"))
            self.assertIsNone(result["timeline"]["audio_track_items"][1].get("link_group_id"))

            # 2. a1 edits must be untouched
            self.assertEqual(len(result["timeline"]["audio_track_items"][0]["edit_instructions"]), 3)

            # 3. a2 must NOT have received a1's edits
            self.assertEqual(len(result["timeline"]["audio_track_items"][1].get("edit_instructions") or []), 0)
        finally:
            os.remove(otio_path)

    def test_linked_clips_preserve_silences_through_edit_continuity(self):
        """
        In Preserve Silences mode, linked video and audio tracks must both receive
        all edits, with silent regions marked enabled=False, zero timeline gaps,
        and bit-exact through-edit adjacent source frames (join test passing).
        """
        pd = {
            "timeline": {
                "name": "Test Timeline",
                "fps": 60.0,
                "project_fps": 60.0,
                "video_track_items": [
                    {
                        "id": "v1_linked",
                        "name": "camera.mov",
                        "track_index": 1,
                        "track_type": "video",
                        "start_frame": 500,
                        "end_frame": 2500,
                        "source_start_frame": 0,
                        "source_end_frame": 2000,
                        "source_fps": 60.0,
                        "link_group_id": 42,
                        "edit_instructions": [],
                    }
                ],
                "audio_track_items": [
                    {
                        "id": "a1_linked",
                        "name": "camera.mov",
                        "track_index": 1,
                        "track_type": "audio",
                        "start_frame": 500,
                        "end_frame": 2500,
                        "source_start_frame": 0,
                        "source_end_frame": 2000,
                        "source_fps": 60.0,
                        "link_group_id": 42,
                        "edit_instructions": [
                            {"start_frame": 500, "end_frame": 700, "source_start_frame": 0, "source_end_frame": 200, "enabled": True},
                            {"start_frame": 700, "end_frame": 1000, "source_start_frame": 200, "source_end_frame": 500, "enabled": False},
                            {"start_frame": 1000, "end_frame": 1500, "source_start_frame": 500, "source_end_frame": 1000, "enabled": True},
                            {"start_frame": 1500, "end_frame": 1800, "source_start_frame": 1000, "source_end_frame": 1300, "enabled": False},
                            {"start_frame": 1800, "end_frame": 2500, "source_start_frame": 1300, "source_end_frame": 2000, "enabled": True},
                        ],
                    }
                ],
            }
        }
        HushCut.PROJECT_DATA = copy.deepcopy(pd)

        # Create dummy OTIO with link group 42
        otio_dummy = {
            "global_start_time": {"rate": 60, "value": 0},
            "tracks": {
                "children": [
                    {
                        "kind": "Video",
                        "children": [
                            {
                                "name": "camera.mov",
                                "source_range": {"duration": {"value": 2000, "rate": 60}},
                                "metadata": {"Resolve_OTIO": {"Link Group ID": 42}},
                            }
                        ],
                    },
                    {
                        "kind": "Audio",
                        "children": [
                            {
                                "name": "camera.mov",
                                "source_range": {"duration": {"value": 2000, "rate": 60}},
                                "metadata": {"Resolve_OTIO": {"Link Group ID": 42}},
                            }
                        ],
                    },
                ]
            },
        }

        with tempfile.NamedTemporaryFile("w", suffix=".otio", delete=False) as f:
            json.dump(otio_dummy, f)
            otio_path = f.name

        try:
            HushCut.unify_linked_items_in_project_data(otio_path)
            result = HushCut.PROJECT_DATA

            v1 = result["timeline"]["video_track_items"][0]
            a1 = result["timeline"]["audio_track_items"][0]

            # Both items must have all 5 edits
            self.assertEqual(len(v1["edit_instructions"]), 5)
            self.assertEqual(len(a1["edit_instructions"]), 5)

            # Check through-edit contiguity on BOTH tracks
            for item in [v1, a1]:
                edits = item["edit_instructions"]
                for i in range(len(edits) - 1):
                    # Zero timeline gap
                    self.assertEqual(
                        edits[i]["end_frame"],
                        edits[i + 1]["start_frame"],
                        f"Timeline gap between edit {i} and {i+1} on {item['id']}",
                    )
                    # Adjacent source frames (bit-exact for Join Test!)
                    self.assertEqual(
                        edits[i]["source_end_frame"],
                        edits[i + 1]["source_start_frame"],
                        f"Source adjacency broken between edit {i} and {i+1} on {item['id']}",
                    )

                # Check Enabled flags (alternating Sound/Silence)
                self.assertTrue(edits[0]["enabled"])
                self.assertFalse(edits[1]["enabled"])
                self.assertTrue(edits[2]["enabled"])
                self.assertFalse(edits[3]["enabled"])
                self.assertTrue(edits[4]["enabled"])

                # Check total duration preserved
                total_dur = edits[-1]["end_frame"] - edits[0]["start_frame"]
                self.assertEqual(total_dur, 2000)
        finally:
            os.remove(otio_path)


if __name__ == "__main__":
    unittest.main()
