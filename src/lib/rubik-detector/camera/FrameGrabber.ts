// Draws the current video frame into a working canvas at a fixed processing
// width and returns its ImageData. Classic vision is faster and no less
// accurate at 480px than at full HD.

export class FrameGrabber {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly width: number;
  height = 0;

  constructor(width = 480) {
    this.width = width;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  grab(video: HTMLVideoElement): ImageData | null {
    if (!video.videoWidth) return null;
    this.height = Math.round((this.width * video.videoHeight) / video.videoWidth);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.drawImage(video, 0, 0, this.width, this.height);
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }
}
