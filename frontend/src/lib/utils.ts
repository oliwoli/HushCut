import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined) {
    value = Math.max(value, min);
  }
  if (max !== undefined) {
    value = Math.min(value, max);
  }
  return value;
}

export function frameToTimecode(
  frame: number,
  fps: number,
  includeFrames: boolean = false
): string {
  if (fps <= 0) {
    throw new Error("FPS must be positive");
  }

  // Total seconds (floating)
  let totalSecondsFloat = frame / fps;

  // Hours
  let hours   = Math.floor(totalSecondsFloat / 3600);
  let  rem      = totalSecondsFloat - hours * 3600;

  // Minutes
  let minutes = Math.floor(rem / 60);
  rem           = rem - minutes * 60;

  // Seconds
  let seconds = Math.floor(rem);

  // Frames: take the fractional leftover seconds * fps, round to nearest int
  let frames = Math.round((rem - seconds) * fps);

  // Handle rare case where rounding up frames === fps
  if (frames >= Math.round(fps)) {
    frames = 0;
    // increment seconds (and roll over minutes/hours if needed)
    if (++seconds === 60) {
      seconds = 0;
      if (++minutes === 60) {
        minutes = 0;
        if (++hours === 24) {
          hours = 0;
        }
      }
    }
  }

  const pad2 = (n: number) => String(n).padStart(2, "0");

  let tc = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  if (includeFrames) {
    tc += `:${pad2(frames)}`;
  }
  return tc;
}


export function timecodeToFrame(timecode: string, fps: number = 30): number {
  if (!timecode || typeof timecode !== 'string') {
    return 0;
  }

  const parts = timecode.split(':');
  if (parts.length < 3) {
    console.error("Invalid timecode format. Expected HH:MM:SS.");
    return 0;
  }

  // Note: Using parseFloat to handle potential floating point values from a timecode source.
  const hours = parseFloat(parts[0]);
  const minutes = parseFloat(parts[1]);
  const seconds = parseFloat(parts[2]);

  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
    console.error("Invalid timecode components. Could not parse numbers.");
    return 0;
  }

  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  const frames = Math.floor(totalSeconds * fps);

  return frames;
}

export function secToFrames(seconds: number, fps: number): number {
  if (fps <= 0) {
    throw new Error("FPS must be positive");
  }
  return Math.ceil(seconds * fps);
}