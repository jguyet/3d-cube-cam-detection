// Reads the tracked facelet state of a GAN 356 i (Gen1) smart cube.
//
// cubing.js can decrypt this cube's state, but its getPattern() throws "Invalid
// Gan cube pattern" because it reuses a sanity check meant for the move stream
// (bytes 13-18 < 0x12) on the facelet payload. We repeat the exact decode (same
// key, same AES) but skip that bogus check and emit a standard 54-char Kociemba
// facelet string (URFDLB), as cstimer does.
//
// Note: the 356 i has no colour sensors — it dead-reckons from its last "solved"
// reference, so this reflects the cube's *tracked* state.

import aesjs from "aes-js";

// Base AES keys, selected by firmware version (verbatim from cubing.js / cstimer).
const KEY10 = [198, 202, 21, 223, 79, 110, 19, 182, 119, 13, 230, 89, 58, 175, 186, 162];
const KEY11 = [67, 226, 91, 214, 125, 220, 120, 216, 7, 96, 163, 218, 130, 60, 1, 241];

const INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
const VERSION_CHAR = "00002a28-0000-1000-8000-00805f9b34fb";
const SYSTEM_ID_CHAR = "00002a23-0000-1000-8000-00805f9b34fb";

/** A minimal view of cubing.js's GanCube instance (private fields at runtime). */
export interface GanCubeInternals {
  server: BluetoothRemoteGATTServer;
  readFaceletStatus1Characteristic: () => Promise<ArrayBufferLike>;
}

export interface ReadInfo {
  raw: string;
  dec: string;
  counts: string;
  ok: boolean;
}

const hex = (a: Uint8Array) =>
  Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(" ");

async function deriveKey(server: BluetoothRemoteGATTServer): Promise<Uint8Array> {
  const info = await server.getPrimaryService(INFO_SERVICE);
  const ver = new Uint8Array((await (await info.getCharacteristic(VERSION_CHAR)).readValue()).buffer);
  const versionValue = (((ver[0] << 8) + ver[1]) << 8) + ver[2];
  const keyXor = versionValue < 0x010100 ? KEY10 : KEY11;
  const systemID = new Uint8Array(
    (await (await info.getCharacteristic(SYSTEM_ID_CHAR)).readValue()).buffer,
  ).reverse();
  const key = new Uint8Array(keyXor);
  for (let i = 0; i < systemID.length; i++) key[i] = (key[i] + systemID[i]) % 256;
  return key;
}

/** GAN's overlapping two-block ECB decryption (AES-128, no IV). */
function decrypt(raw: Uint8Array, key: Uint8Array): Uint8Array {
  const arr = new Uint8Array(raw); // 19 bytes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ecb = () => new (aesjs as any).ModeOfOperation.ecb(key);
  arr.set(ecb().decrypt(arr.slice(arr.length - 16)), arr.length - 16);
  arr.set(ecb().decrypt(arr.slice(0, 16)), 0);
  return arr;
}

/**
 * Read the cube and return a standard 54-char Kociemba facelet string
 * (U1..U9 R1..R9 F1..F9 D1..D9 L1..L9 B1..B9) with letters in "URFDLB".
 */
export async function readGan356iFacelets(
  gan: GanCubeInternals,
): Promise<{ facelets: string; info: ReadInfo }> {
  const key = await deriveKey(gan.server);
  const raw = new Uint8Array(await gan.readFaceletStatus1Characteristic());
  const arr = decrypt(raw, key);

  // 18 bytes → 6 faces × 8 outer stickers (3 bits each, MSB first); insert each
  // face's centre after the 4th sticker to build the standard 54-char string.
  const state: string[] = [];
  for (let i = 0; i < 18; i += 3) {
    const face = (arr[i ^ 1] << 16) | (arr[(i + 1) ^ 1] << 8) | arr[(i + 2) ^ 1];
    for (let j = 21; j >= 0; j -= 3) {
      state.push("URFDLB".charAt((face >> j) & 0x7));
      if (j === 12) state.push("URFDLB".charAt(i / 3));
    }
  }
  const facelets = state.join("");

  const counts = [0, 0, 0, 0, 0, 0];
  for (const ch of facelets) {
    const k = "URFDLB".indexOf(ch);
    if (k >= 0) counts[k]++;
  }
  const ok = counts.every((c) => c === 9);

  return { facelets, info: { raw: hex(raw), dec: hex(arr), counts: counts.join(","), ok } };
}
