// src/components/audio/MinimalPlayer.tsx (or wherever you place it)
import WaveSurfer from "wavesurfer.js";
import React, { useEffect, useRef } from "react"; // Removed useState, not used in this version

interface MinimalPlayerProps {
  audioUrl: string | null; // Allow null if the URL might not be ready immediately
}

const MinimalPlayer: React.FC<MinimalPlayerProps> = ({ audioUrl }) => {
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const wavesurferInstanceRef = useRef<WaveSurfer | null>(null); // To keep track of the instance for cleanup

  useEffect(() => {
    // Guard against no container or no URL
    if (!waveformRef.current || !audioUrl) {
      // If an old instance exists, destroy it
      if (wavesurferInstanceRef.current) {
        console.log(
          "MinimalPlayer: No URL or container, destroying existing instance."
        );
        wavesurferInstanceRef.current.destroy();
        wavesurferInstanceRef.current = null;
      }
      return;
    }

    // If audioUrl changes, a new instance will be created,
    // so ensure the old one is destroyed. The key prop on this component
    // in App.tsx would also handle this by remounting.
    if (wavesurferInstanceRef.current) {
      console.log(
        "MinimalPlayer: audioUrl changed, destroying previous instance."
      );
      wavesurferInstanceRef.current.destroy();
      wavesurferInstanceRef.current = null;
    }

    console.log(`MinimalPlayer: Initializing WaveSurfer with URL: ${audioUrl}`);

    try {
      const wavesurfer = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "violet",
        progressColor: "purple",
        cursorColor: "red", // Added for visibility
        url: audioUrl, // This tells WaveSurfer to load this URL
        // backend: 'MediaElement', // You can toggle this for testing if default (WebAudio) has issues
      });
      wavesurferInstanceRef.current = wavesurfer;

      wavesurfer.on("ready", () => {
        console.log(
          "MinimalPlayer: WaveSurfer ready. Duration:",
          wavesurfer.getDuration().toFixed(2)
        );
        // You could enable a play button or auto-play here if desired
      });

      wavesurfer.on("error", (err: Error) => {
        // Catch WaveSurfer's own error events
        console.error(
          "MinimalPlayer: WaveSurfer internal error event:",
          err.message,
          err
        );
      });

      // Original interaction logic from your example
      const onInteraction = () => {
        if (wavesurferInstanceRef.current) {
          console.log(
            "MinimalPlayer: Interaction detected, attempting to play."
          );
          wavesurferInstanceRef.current.play().catch((playError) => {
            console.error(
              "MinimalPlayer: Error on explicit play after interaction:",
              playError
            );
          });
        }
      };
      wavesurfer.once("interaction", onInteraction);

      // Cleanup function to destroy WaveSurfer instance on component unmount or when audioUrl changes
      return () => {
        console.log(
          "MinimalPlayer: Cleaning up WaveSurfer instance for URL:",
          audioUrl
        );
        // wavesurfer.un('interaction', onInteraction); // 'once' removes itself, but good practice for 'on'
        if (wavesurferInstanceRef.current) {
          wavesurferInstanceRef.current.destroy();
          wavesurferInstanceRef.current = null;
        }
      };
    } catch (error) {
      console.error(
        "MinimalPlayer: Error creating WaveSurfer instance:",
        error
      );
    }
  }, [audioUrl]); // Key dependency: re-run if audioUrl changes

  return (
    <div style={{ border: "3px solid teal", padding: "15px", margin: "10px" }}>
      <h4>True Minimal WaveSurfer Test</h4>
      <div
        ref={waveformRef}
        style={{
          minHeight: "100px",
          background: "#f0f0f0",
          border: "1px solid #ccc",
        }}
      />
      {audioUrl ? (
        <p>Attempting to load: {audioUrl}</p>
      ) : (
        <p>No audio URL provided.</p>
      )}
      <hr style={{ margin: "15px 0" }} />
      <p>Direct HTML Audio Tag for Comparison (same URL):</p>
      {audioUrl && (
        <audio controls src={audioUrl} style={{ width: "100%" }}>
          Your browser does not support the audio element.
        </audio>
      )}
    </div>
  );
};

export default MinimalPlayer;
