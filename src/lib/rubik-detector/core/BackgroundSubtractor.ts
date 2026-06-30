// Motion-based background removal, shared across detectors.
//
// Learns the STATIC scene (per-pixel YCbCr running average) and reports the
// MOVING foreground. The cube is handheld → always moving → foreground; the
// static scene (walls, cabinets, magnets) converges into the model and is
// dropped. `maskImage` greys out the static pixels so a downstream colour/
// saturation detector simply never sees the background.

export class BackgroundSubtractor {
  private bgY: Float32Array | null = null;
  private bgCb: Float32Array | null = null;
  private bgCr: Float32Array | null = null;

  // Returns the dilated foreground mask, or null on the first frame (model
  // seeding). Updates the background only where there is no motion.
  update(img: ImageData, threshold = 26, alpha = 0.06): Uint8Array | null {
    const w = img.width, h = img.height, d = img.data, n = w * h;
    const luma = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      luma[j] = 0.299 * r + 0.587 * g + 0.114 * b;
      cb[j] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[j] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    if (!this.bgY || this.bgY.length !== n) {
      this.bgY = Float32Array.from(luma);
      this.bgCb = Float32Array.from(cb);
      this.bgCr = Float32Array.from(cr);
      return null;
    }
    const bgY = this.bgY, bgCb = this.bgCb!, bgCr = this.bgCr!;
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const delta = Math.abs(luma[i] - bgY[i]) + 0.6 * Math.abs(cb[i] - bgCb[i]) + 0.6 * Math.abs(cr[i] - bgCr[i]);
      if (delta > threshold) {
        fg[i] = 1;
      } else {
        bgY[i] += alpha * (luma[i] - bgY[i]);
        bgCb[i] += alpha * (cb[i] - bgCb[i]);
        bgCr[i] += alpha * (cr[i] - bgCr[i]);
      }
    }
    return this.dilate(fg, w, h, 3);
  }

  // Grey out static pixels: foreground keeps its colour, the rest becomes a
  // neutral grey (low saturation → ignored by a saturation/colour detector).
  // `expand` widens the kept region so the moving cube isn't clipped.
  maskImage(img: ImageData, fg: Uint8Array, expand = 6): ImageData {
    const w = img.width, h = img.height, d = img.data;
    const keep = this.dilate(fg, w, h, expand);
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      if (keep[j]) {
        out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = 255;
      } else {
        out[i] = 128; out[i + 1] = 128; out[i + 2] = 128; out[i + 3] = 255;
      }
    }
    return { width: w, height: h, data: out } as unknown as ImageData;
  }

  reset(): void {
    this.bgY = null;
    this.bgCb = null;
    this.bgCr = null;
  }

  private dilate(m: Uint8Array, w: number, h: number, iters: number): Uint8Array {
    for (let it = 0; it < iters; it++) {
      const o = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (m[i] || m[i - 1] || m[i + 1] || m[i - w] || m[i + w]) o[i] = 1;
        }
      m = o;
    }
    return m;
  }
}
