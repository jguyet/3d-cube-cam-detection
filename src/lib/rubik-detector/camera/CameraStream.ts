// Owns the getUserMedia stream and binds it to a <video> element.

export class CameraStream {
  private stream: MediaStream | null = null;

  async start(video: HTMLVideoElement): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    this.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get active(): boolean {
    return !!this.stream;
  }
}
