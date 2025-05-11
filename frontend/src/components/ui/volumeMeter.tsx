import React, { useRef, useState, useEffect } from "react";

const VolumeMeter: React.FC = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [smoothing, setSmoothing] = useState(0.8);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const animationId = useRef<number | null>(null);

  useEffect(() => {
    if (!audioSrc) return;

    const context = new AudioContext();
    setAudioContext(context);

    const audioElement = audioRef.current!;
    const source = context.createMediaElementSource(audioElement);

    const splitter = context.createChannelSplitter(2);
    const analyserLeft = context.createAnalyser();
    const analyserRight = context.createAnalyser();

    analyserLeft.fftSize = 256;
    analyserRight.fftSize = 256;
    analyserLeft.smoothingTimeConstant = smoothing;
    analyserRight.smoothingTimeConstant = smoothing;

    source.connect(splitter);
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);
    source.connect(context.destination);

    const bufferLength = analyserLeft.frequencyBinCount;
    const dataArrayLeft = new Uint8Array(bufferLength);
    const dataArrayRight = new Uint8Array(bufferLength);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    const draw = () => {
      animationId.current = requestAnimationFrame(draw);

      analyserLeft.getByteFrequencyData(dataArrayLeft);
      analyserRight.getByteFrequencyData(dataArrayRight);

      const avgLeft =
        dataArrayLeft.reduce((sum, val) => sum + val, 0) / bufferLength;
      const avgRight =
        dataArrayRight.reduce((sum, val) => sum + val, 0) / bufferLength;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // Draw left channel bar
      ctx.fillStyle = "green";
      ctx.fillRect(WIDTH / 4 - 25, HEIGHT - avgLeft, 50, avgLeft);

      // Draw right channel bar
      ctx.fillStyle = "blue";
      ctx.fillRect((3 * WIDTH) / 4 - 25, HEIGHT - avgRight, 50, avgRight);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId.current!);
      analyserLeft.disconnect();
      analyserRight.disconnect();
      splitter.disconnect();
      source.disconnect();
      context.close();
    };
  }, [audioSrc, smoothing]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setAudioSrc(url);
    }
  };

  const handleSmoothingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSmoothing(parseFloat(e.target.value));
  };

  return (
    <div>
      <input type="file" accept="audio/*" onChange={handleFileChange} />
      <br />
      <label>
        Smoothing: {smoothing}
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={smoothing}
          onChange={handleSmoothingChange}
        />
      </label>
      <br />
      <audio ref={audioRef} src={audioSrc || undefined} controls />
      <br />
      <canvas ref={canvasRef} width={600} height={200} />
    </div>
  );
};

export default VolumeMeter;
