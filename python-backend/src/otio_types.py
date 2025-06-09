from __future__ import annotations
from typing import TypedDict, Any, NotRequired, List, Union


DefaultMedia = TypedDict(
    "DefaultMedia",
    {
        "OTIO_SCHEMA": str,
        "metadata": Any,
        "name": str,
        "available_range": "SourceRangeOrAvailableRange",
        "available_image_bounds": None,
        "target_url": str,
    },
)

MediaReferences = TypedDict("MediaReferences", {"DEFAULT_MEDIA": DefaultMedia})

Effect = TypedDict(
    "Effect",
    {"OTIO_SCHEMA": str, "metadata": "Metadata", "name": str, "effect_name": str},
)

UnnammedUnion43A810 = Union[Effect, Any]

SourceRangeOrAvailableRange = TypedDict(
    "SourceRangeOrAvailableRange",
    {
        "OTIO_SCHEMA": str,
        "duration": "RationalTime",
        "start_time": "RationalTime",
    },
)

UnnammedUnion438F20 = Union[Any, "Metadata"]


ClipOrGap = TypedDict(
    "ClipOrGap",
    {
        "OTIO_SCHEMA": str,
        "metadata": UnnammedUnion438F20,
        "name": str,
        "source_range": SourceRangeOrAvailableRange,
        "effects": List[UnnammedUnion43A810],
        "markers": List[Any],
        "enabled": bool,
        "media_references": NotRequired[MediaReferences],
        "active_media_reference_key": NotRequired[str],
    },
)

TrackChildren = Union["TracksOrChildren", ClipOrGap]

TracksOrChildren = TypedDict(
    "TracksOrChildren",
    {
        "OTIO_SCHEMA": str,
        "metadata": "Metadata",
        "name": str,
        "source_range": None,
        "effects": List[Any],
        "markers": List[Any],
        "enabled": bool,
        "children": List[TrackChildren],
        "kind": NotRequired[str],
    },
)

RationalTime = TypedDict(
    "RationalTime",
    {"OTIO_SCHEMA": str, "rate": float, "value": float},
)

UnnammedUnion438740 = Union[List[float], float]

UnnammedUnion439A80 = Union[List[float], float]

KeyframeAttribute = TypedDict(
    "KeyframeAttribute", {"Value": UnnammedUnion439A80, "Variant Type": str}
)

KeyFrames = TypedDict(
    "KeyFrames",
    {
        "0": NotRequired[KeyframeAttribute],
        "1000": NotRequired[KeyframeAttribute],
        "-295": NotRequired[KeyframeAttribute],
        "705": NotRequired[KeyframeAttribute],
        "-390": NotRequired[KeyframeAttribute],
        "610": NotRequired[KeyframeAttribute],
    },
)

UnnammedUnion4389E0 = Union[float, List[float]]

Parameter = TypedDict(
    "Parameter",
    {
        "Default Parameter Value": UnnammedUnion4389E0,
        "Key Frames": NotRequired[KeyFrames],
        "Parameter ID": str,
        "Parameter Value": UnnammedUnion438740,
        "Variant Type": str,
        "maxValue": NotRequired[float],
        "minValue": NotRequired[float],
    },
)

UnnammedUnion438CF0 = Union[Any, Parameter]

Channel = TypedDict("Channel", {"Source Channel ID": int, "Source Track ID": int})

ResolveOTIO = TypedDict(
    "ResolveOTIO",
    {
        "Channels": NotRequired[List[Channel]],
        "Link Group ID": NotRequired[int],
        "Effect Name": NotRequired[str],
        "Enabled": NotRequired[bool],
        "Name": NotRequired[str],
        "Parameters": NotRequired[List[UnnammedUnion438CF0]],
        "Type": NotRequired[int],
        "Resolve OTIO Meta Version": NotRequired[str],
        "Audio Type": NotRequired[str],
        "Locked": NotRequired[bool],
        "SoloOn": NotRequired[bool],
    },
)

Metadata = TypedDict("Metadata", {"Resolve_OTIO": ResolveOTIO})

Timeline = TypedDict(
    "Timeline",
    {
        "OTIO_SCHEMA": str,
        "metadata": Metadata,
        "name": str,
        "global_start_time": RationalTime,
        "tracks": TracksOrChildren,
    },
)

ClipMetadata = TypedDict("ClipMetadata", {"Resolve_OTIO": NotRequired[ResolveOTIO]})


# 💡 Starting from Python 3.10 (PEP 604), `Union[A, B]` can be simplified as `A | B`

# 💡 `NotRequired` or `Missing` are introduced since Python 3.11 (PEP 655).
#   `typing_extensions` is imported above for backwards compatibility.
#   For Python < 3.11, pip install typing_extensions. O.W., just change it to `typing`\n
