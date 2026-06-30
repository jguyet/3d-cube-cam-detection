// Shared types for the real-time Rubik's cube detector.

export type Point2 = { x: number; y: number };

export type Quad = {
  points: [Point2, Point2, Point2, Point2];
  area: number;
  perimeter: number;
  score: number;
};

export type FaceCandidate = {
  quad: Quad;
  confidence: number;
};

export type StickerColor =
  | "white"
  | "yellow"
  | "red"
  | "orange"
  | "blue"
  | "green"
  | "unknown";

export type StickerSample = {
  row: number;
  col: number;
  color: StickerColor;
  rgb: [number, number, number];
  hsv: [number, number, number];
  confidence: number;
};

export type CubePose = {
  rotationVector: [number, number, number];
  translationVector: [number, number, number];
  confidence: number;
};

export type Face = [Point2, Point2, Point2, Point2];

export type DetectionDebug = {
  corners: number;
  balance: number;
  sup2: number;
  weak2: number;
  fillFrac: number;
  smoothed?: boolean;
};

// Raw per-frame analysis (before temporal smoothing by CubeTracker).
export type FrameResult = {
  hull: Point2[] | null;
  fillFrac: number;
  corners: number;
  balance: number;
  sup2: number;
  weak2: number;
  cand1: Face[];
  cand2: Face[] | null;
  cand3: { faces: Face[]; center: Point2 } | null;
};

export type CubeDetection = {
  hull: Point2[] | null;
  faces: Face[];        // 1, 2 or 3 visible faces
  nFaces: number;
  center: Point2 | null; // shared near-corner when 3 faces are visible
  confidence: number;
  debug?: DetectionDebug;
};
