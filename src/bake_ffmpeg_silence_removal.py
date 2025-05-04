#!/usr/bin/env python3

import subprocess
import re
import argparse
import sys


def get_silence_segments(input_wav, threshold, min_silence_duration):
    detect_cmd = [
        "ffmpeg",
        "-i",
        input_wav,
        "-af",
        f"silencedetect=n={threshold}:d={min_silence_duration}",
        "-f",
        "null",
        "-",
    ]

    result = subprocess.run(detect_cmd, stderr=subprocess.PIPE, text=True)
    log = result.stderr

    silences = []
    for match in re.finditer(r"silence_(start|end): (\d+(\.\d+)?)", log):
        typ, ts = match.group(1), float(match.group(2))
        silences.append((typ, ts))
    return silences


def get_audio_duration(input_wav):
    duration_cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input_wav,
    ]
    return float(subprocess.check_output(duration_cmd).decode().strip())


def compute_non_silent_segments(silences, duration):
    segments = []
    start_time = 0.0
    for i in range(0, len(silences), 2):
        if i + 1 >= len(silences):
            break
        silence_start = silences[i][1]
        silence_end = silences[i + 1][1]
        if silence_start > start_time:
            segments.append((start_time, silence_start))
        start_time = silence_end
    if start_time < duration:
        segments.append((start_time, duration))
    return segments


def generate_ffmpeg_trim_command(input_wav, output_wav, segments):
    filter_parts = []
    for i, (start, end) in enumerate(segments):
        filter_parts.append(
            f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[seg{i}]"
        )
    concat_inputs = "".join(f"[seg{i}]" for i in range(len(segments)))
    filter_complex = (
        ";".join(filter_parts)
        + f";{concat_inputs}concat=n={len(segments)}:v=0:a=1[out]"
    )

    trim_cmd = [
        "ffmpeg",
        "-y",
        "-i",
        input_wav,
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        output_wav,
    ]
    return trim_cmd


def main():
    parser = argparse.ArgumentParser(
        description="Remove silence from an audio file using ffmpeg."
    )
    parser.add_argument("input", help="Input WAV file")
    parser.add_argument("output", help="Output WAV file")
    parser.add_argument(
        "--threshold", default="-20dB", help="Silence threshold (e.g., -30dB)"
    )
    parser.add_argument(
        "--duration", default="0.5", help="Minimum silence duration in seconds"
    )

    args = parser.parse_args()

    silences = get_silence_segments(args.input, args.threshold, args.duration)
    if not silences:
        print("No silences detected. Copying input to output.")
        subprocess.run(["cp", args.input, args.output])
        sys.exit(0)

    duration = get_audio_duration(args.input)
    segments = compute_non_silent_segments(silences, duration)

    if not segments:
        print("No non-silent segments found.")
        sys.exit(1)

    trim_cmd = generate_ffmpeg_trim_command(args.input, args.output, segments)
    subprocess.run(trim_cmd)


if __name__ == "__main__":
    main()
