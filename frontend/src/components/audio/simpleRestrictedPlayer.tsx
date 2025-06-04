import React, { useEffect, useRef, useState, useCallback } from "react";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";

interface SimpleRestrictedPlayerProps {
  audioUrl: string;
  startFrame: number;
  endFrame: number;
  frameRate: number;
}

export const SimpleRestrictedPlayer: React.FC<SimpleRestrictedPlayerProps> = ({
  audioUrl,
  startFrame,
  endFrame,
  frameRate,
}) => {
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // 'progress' will store time relative to the clip's start (0 to clipDuration)
  const [progress, setProgress] = useState(0);
  const [isWaveSurferReady, setIsWaveSurferReady] = useState(false);

  const startSeconds = startFrame / frameRate;
  const endSeconds = endFrame / frameRate;
  // Ensure clipDuration is not negative if endFrame < startFrame for some reason
  const clipDuration = Math.max(0, endSeconds - startSeconds);

  useEffect(() => {
    if (!waveformRef.current || !audioUrl || frameRate <= 0) {
      console.log("SimpleRestrictedPlayer: Invalid props");
      return;
    }

    console.log(
      `Initializing Minimal WaveSurfer. Clip: ${startSeconds.toFixed(
        2
      )}s - ${endSeconds.toFixed(2)}s. Duration: ${clipDuration.toFixed(2)}s`
    );

    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "#A8DBA8",
      progressColor: "#3B8686",
      cursorColor: "#FF0000", // Make cursor very visible
      height: 100,
      normalize: true,
      backend: "MediaElement",
      hideScrollbar: false,
      url: audioUrl,
    });
    wavesurferRef.current = wavesurfer;

    console.log("audio url for restricted player:", audioUrl);
    //wavesurfer.load(audioUrl);

    wavesurfer.on("ready", () => {
      // console.log("WaveSurfer ready. Full duration:", wavesurfer.getDuration().toFixed(2));
      // Set the actual audio element's time to the clip's start.
      // WaveSurfer's setTime also often does this for the MediaElement backend.
      wavesurfer.setTime(startSeconds);
      setProgress(0); // Clip starts at 0 progress
      setIsWaveSurferReady(true);
    });

    wavesurfer.on("audioprocess", () => {
      if (!wavesurferRef.current) return;
      const currentAbsoluteTime = wavesurferRef.current.getCurrentTime();
      const currentClipRelativeTime = currentAbsoluteTime - startSeconds;

      if (currentAbsoluteTime >= endSeconds - 0.05) {
        // Added small buffer
        wavesurferRef.current.pause(); // Pause before or exactly at endSeconds
        // wavesurferRef.current.setTime(endSeconds); // Optionally snap to end
        setProgress(clipDuration);
        setIsPlaying(false);
      } else if (currentAbsoluteTime < startSeconds) {
        // This might happen if user somehow seeks before start via WS internal means
        // Forcibly correct it if playing
        if (wavesurferRef.current.isPlaying()) {
          wavesurferRef.current.setTime(startSeconds);
          setProgress(0);
        } else {
          // If paused and before start, reflect 0 progress
          setProgress(0);
        }
      } else {
        setProgress(currentClipRelativeTime);
      }
    });

    wavesurfer.on("pause", () => {
      setIsPlaying(false);
    });
    wavesurfer.on("play", () => {
      setIsPlaying(true);
    });
    wavesurfer.on("seeking", () => {
      // Fired when a seek operation is performed
      if (!wavesurferRef.current) return;
      const currentAbsoluteTime = wavesurferRef.current.getCurrentTime();
      const currentClipRelativeTime = currentAbsoluteTime - startSeconds;
      // Update progress immediately on seek for better responsiveness of the range input
      setProgress(Math.max(0, Math.min(currentClipRelativeTime, clipDuration)));
    });

    return () => {
      // console.log("Destroying WaveSurfer instance");
      wavesurfer.destroy();
      wavesurferRef.current = null;
      setIsWaveSurferReady(false);
    };
  }, [audioUrl, startFrame, endFrame, frameRate]); // Re-init if these key props change

  const togglePlay = useCallback(() => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || !isWaveSurferReady || clipDuration <= 0) return;

    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
    } else {
      const currentAbsoluteTime = wavesurfer.getCurrentTime();
      // If current playhead is outside our clip, or at the very end of our clip, restart from clip's beginning
      if (
        currentAbsoluteTime < startSeconds ||
        currentAbsoluteTime >= endSeconds - 0.05
      ) {
        // console.log(`Play: Current time ${currentAbsoluteTime.toFixed(2)} is outside clip or at end. Resetting to ${startSeconds.toFixed(2)}`);
        wavesurfer.setTime(startSeconds);
        setProgress(0); // Visual progress reset
      }
      // If paused within the clip, just resume from there.
      // The media element's currentTime is already set by wavesurfer.setTime or previous playback.
      wavesurfer.play();
    }
  }, [isWaveSurferReady, startSeconds, endSeconds, clipDuration]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const wavesurfer = wavesurferRef.current;
      if (!wavesurfer || !isWaveSurferReady) return;

      const newClipRelativeTime = parseFloat(e.target.value);
      const newAbsoluteTime = startSeconds + newClipRelativeTime;

      // Ensure seeking stays within the logical clip boundaries for the audio element
      const clampedAbsoluteTime = Math.max(
        startSeconds,
        Math.min(newAbsoluteTime, endSeconds)
      );

      wavesurfer.setTime(clampedAbsoluteTime);
      // setProgress will be updated by the 'audioprocess' or 'seeking' event for consistency
      // but for immediate UI feedback on slider drag, you could set it here too:
      setProgress(clampedAbsoluteTime - startSeconds);
    },
    [isWaveSurferReady, startSeconds, endSeconds]
  );

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    // Ensure seconds is not negative if progress becomes slightly < 0 due to float issues
    return `${m.toString().padStart(1, "0")}:${Math.max(0, s)
      .toString()
      .padStart(2, "0")}`;
  };

  // Disable controls if clipDuration is zero or negative, or if WS not ready
  const controlsDisabled = !isWaveSurferReady || clipDuration <= 0;

  return (
    <div
      style={{
        width: "600px",
        margin: "20px auto",
        border: "1px solid #ccc",
        padding: "10px",
      }}
    >
      <div
        ref={waveformRef}
        style={{ borderBottom: "1px solid #eee", marginBottom: "10px" }}
      />
      <button
        onClick={togglePlay}
        disabled={controlsDisabled}
        style={{ marginTop: "10px", marginRight: "10px" }}
      >
        {isPlaying ? "Pause" : "Play"}
      </button>
      <span>
        {formatTime(progress)} / {formatTime(clipDuration)}
      </span>
      <input
        type="range"
        min={0}
        max={clipDuration}
        value={progress}
        onChange={handleSeek}
        step={0.01} // Finer step for smoother seeking
        disabled={controlsDisabled}
        style={{ width: "100%", marginTop: "5px" }}
      />

      {/* default audio player to make sure file works */}
      <audio controls src={audioUrl} />
      {/* For debugging:
      <div>StartSec: {startSeconds.toFixed(2)}, EndSec: {endSeconds.toFixed(2)}, ClipDur: {clipDuration.toFixed(2)}</div>
      <div>WS CurrentTime (abs): {wavesurferRef.current?.getCurrentTime().toFixed(2)}</div>
      */}
    </div>
  );
};

export default SimpleRestrictedPlayer;
