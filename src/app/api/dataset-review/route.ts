import { promises as fs } from "fs";
import path from "path";

// Persist the user's dataset review to disk so it can be inspected later:
// - dataset-review/annotations.json  (per-image verdict/validity/cell notes)
// - dataset-review/<key>.png         (the exact annotated overlay the user saw)
// Body: { annotations: object, images: { key: string, dataURL: string }[] }
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const dir = path.join(process.cwd(), "dataset-review");
    await fs.mkdir(dir, { recursive: true });
    const images: { key: string; dataURL: string }[] = Array.isArray(body.images) ? body.images : [];
    const written: string[] = [];
    for (const { key, dataURL } of images) {
      if (typeof key !== "string" || typeof dataURL !== "string") continue;
      const m = dataURL.match(/^data:image\/png;base64,(.+)$/);
      if (!m) continue;
      const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
      await fs.writeFile(path.join(dir, `${safe}.png`), Buffer.from(m[1], "base64"));
      written.push(`${safe}.png`);
    }
    await fs.writeFile(
      path.join(dir, "annotations.json"),
      JSON.stringify({ savedAt: new Date().toISOString(), annotations: body.annotations ?? {}, images: written }, null, 2),
    );
    return Response.json({ ok: true, dir: "dataset-review", images: written.length });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
