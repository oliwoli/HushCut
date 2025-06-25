import BasePlugin, {
  type BasePluginEvents,
} from 'wavesurfer.js/dist/base-plugin.js';
import type WaveSurfer from 'wavesurfer.js';

export type OutlinePluginOptions = {
  lineWidth?: number;
};
export type OutlinePluginEvents = BasePluginEvents;

export class OutlinePlugin extends BasePlugin<
  OutlinePluginEvents,
  OutlinePluginOptions
> {
  private originalDrawWave?: (...args: any[]) => void;
  private patched = false;

  static defaultOptions: OutlinePluginOptions = {
    lineWidth: 1,
  };

  onInit() {
    if (!this.wavesurfer) return;

    this.subscriptions.push(
      this.wavesurfer.on('decode', () => {
        console.log('[OutlinePlugin] Decode event fired. Scheduling patch.');
        requestAnimationFrame(() => {
          console.log('[OutlinePlugin] requestAnimationFrame callback triggered.');
          this.patchRenderer();
        });
      }),
    );
  }

  private patchRenderer() {
    console.log('[OutlinePlugin] Attempting to patch renderer...');
    if (this.patched || !this.wavesurfer) {
      console.log(
        '[OutlinePlugin] Patching skipped (already patched or no wavesurfer). Patched:',
        this.patched,
      );
      return;
    }

    // @ts-ignore
    const renderer = this.wavesurfer.renderer;

    // The most important log: Let's see what the renderer object actually looks like
    console.log('[OutlinePlugin] Renderer object:', renderer);

    if (renderer && typeof renderer.drawWave === 'function') {
      console.log('%c[OutlinePlugin] SUCCESS: renderer.drawWave found. Patching now.', 'color: green');
      // @ts-ignore
      this.originalDrawWave = renderer.drawWave.bind(renderer);
      // @ts-ignore
      renderer.drawWave = this.drawOutline.bind(this);
      this.patched = true;
    } else {
      console.error('%c[OutlinePlugin] FAILED: renderer.drawWave not found or not a function.', 'color: red');
      // Let's log the type to be sure
      if (renderer) {
        console.log('[OutlinePlugin] typeof renderer.drawWave:', typeof renderer.drawWave);
      } else {
        console.log('[OutlinePlugin] Renderer itself is not available.');
      }
    }
  }

  destroy() {
    // @ts-ignore
    if (this.patched && this.wavesurfer?.renderer && this.originalDrawWave) {
      // @ts-ignore
      this.wavesurfer.renderer.drawWave = this.originalDrawWave;
      this.patched = false;
    }
    super.destroy();
  }

  private drawOutline(
    peaks: number[][],
    channelIndex: number,
    ctx: CanvasRenderingContext2D,
    params: any,
  ) {
    console.log('[OutlinePlugin] drawOutline function is executing.');

    const { width, height } = ctx.canvas;
    const topPeaks = peaks[channelIndex];
    ctx.strokeStyle = params.color;
    ctx.lineWidth = this.options.lineWidth || 1;
    ctx.beginPath();
    ctx.moveTo(params.start, height);
    for (let i = params.start; i < params.end; i++) {
      const peak = topPeaks[i] || 0;
      const y = height * (1 - peak);
      ctx.lineTo(i, y);
    }
    ctx.lineTo(params.end, height);
    ctx.stroke();
  }
}