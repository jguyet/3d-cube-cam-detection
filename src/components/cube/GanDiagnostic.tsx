"use client";

import { useEffect, useState } from "react";

// GAN BLE constants (mirrors gan-web-bluetooth internals).
const GAN_SERVICES = [
  "6e400001-b5a3-f393-e0a9-e50e24dc4179", // Gen2 (also Nordic UART)
  "8653000a-43e6-47b7-9cb0-5fc21d4ae340", // Gen3
  "00000010-0000-fff7-fff6-fff5fff4fff0", // Gen4
];

// Known service UUIDs across smart-cube brands, to identify the protocol.
const KNOWN_SERVICES: Record<string, string> = {
  "6e400001-b5a3-f393-e0a9-e50e24dc4179": "GAN Gen2 / Nordic UART",
  "8653000a-43e6-47b7-9cb0-5fc21d4ae340": "GAN Gen3",
  "00000010-0000-fff7-fff6-fff5fff4fff0": "GAN Gen4",
  "0000aadb-0000-1000-8000-00805f9b34fb": "Giiker",
  "0000fff0-0000-1000-8000-00805f9b34fb": "QiYi / générique FFF0",
  "0000ffe0-0000-1000-8000-00805f9b34fb": "Module générique (HM-10)",
  "0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
  "0000180f-0000-1000-8000-00805f9b34fb": "Battery",
  "00001800-0000-1000-8000-00805f9b34fb": "Generic Access",
};

const INSPECT_SERVICES = [
  ...GAN_SERVICES,
  "device_information",
  "battery_service",
  "generic_access",
  "0000aadb-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
];
// Company identifier codes used by GAN: (i << 8) | 0x01 for i in 0..255.
const GAN_CIC_LIST = Array.from({ length: 256 }, (_v, i) => (i << 8) | 0x01);
// Full 16-bit range, to detect ANY manufacturer data this cube emits.
const ALL_CIC = Array.from({ length: 0x10000 }, (_v, i) => i);

function hexDump(dv: DataView): string {
  const out: string[] = [];
  for (let i = 0; i < dv.byteLength; i++) {
    out.push(dv.getUint8(i).toString(16).toUpperCase().padStart(2, "0"));
  }
  return out.join(" ");
}

/** Extract a MAC from the last 6 bytes (reversed) of whatever manufacturer data is present. */
function extractMAC(md: BluetoothManufacturerData): { mac: string; cic: number } | null {
  for (const id of md.keys()) {
    const dv = md.get(id);
    if (dv && dv.byteLength >= 6) {
      const mac: string[] = [];
      for (let i = 1; i <= 6; i++) {
        mac.push(dv.getUint8(dv.byteLength - i).toString(16).toUpperCase().padStart(2, "0"));
      }
      return { mac: mac.join(":"), cic: id };
    }
  }
  return null;
}

interface Caps {
  hasBluetooth: boolean;
  hasWatchAdv: boolean;
  available: boolean | null;
  chrome: string;
}

export default function GanDiagnostic() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [mac, setMac] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);

  const addLog = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    const hasBluetooth = typeof navigator !== "undefined" && "bluetooth" in navigator;
    const hasWatchAdv =
      typeof window !== "undefined" &&
      typeof (window as unknown as { BluetoothDevice?: unknown }).BluetoothDevice === "function" &&
      "watchAdvertisements" in
        (window as unknown as { BluetoothDevice: { prototype: object } }).BluetoothDevice.prototype;
    const m = typeof navigator !== "undefined" ? navigator.userAgent.match(/Chrome\/(\d+)/) : null;
    const chrome = m ? `Chrome ${m[1]}` : "Navigateur non-Chrome";

    const init: Caps = { hasBluetooth, hasWatchAdv, available: null, chrome };
    setCaps(init);
    if (hasBluetooth && navigator.bluetooth.getAvailability) {
      navigator.bluetooth
        .getAvailability()
        .then((a) => setCaps((c) => (c ? { ...c, available: a } : c)))
        .catch(() => {});
    }
  }, []);

  const scan = async () => {
    setLog([]);
    setMac(null);
    setScanning(true);
    try {
      addLog("Ouverture du sélecteur Bluetooth…");
      let device: BluetoothDevice;
      try {
        // Ask for the FULL company-ID range to catch any manufacturer data.
        device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "GAN" }, { namePrefix: "MG" }, { namePrefix: "AiCube" }],
          optionalServices: GAN_SERVICES,
          optionalManufacturerData: ALL_CIC,
        });
        addLog("Demande de TOUS les company IDs acceptée.");
      } catch (err) {
        // Some Chrome builds reject a 65536-long list — fall back to the GAN set.
        addLog("Liste complète refusée, repli sur les IDs GAN. (" + (err as Error).message + ")");
        device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: "GAN" }, { namePrefix: "MG" }, { namePrefix: "AiCube" }],
          optionalServices: GAN_SERVICES,
          optionalManufacturerData: GAN_CIC_LIST,
        });
      }
      addLog(`Cube sélectionné : « ${device.name ?? "?"} »`);

      if (typeof device.watchAdvertisements !== "function") {
        addLog("❌ watchAdvertisements() indisponible → le flag expérimental n'est PAS actif.");
        addLog(
          "Active chrome://flags/#enable-experimental-web-platform-features puis RELAUNCH Chrome.",
        );
        setScanning(false);
        return;
      }
      addLog("✅ watchAdvertisements() disponible. Écoute des trames (12 s)…");
      addLog("➡️ Tourne une face du cube SANS T'ARRÊTER pour qu'il émette.");

      const ac = new AbortController();
      let got = false;

      const onAdv = (evt: Event) => {
        const e = evt as BluetoothAdvertisingEvent;
        const ids = Array.from(e.manufacturerData.keys());
        if (ids.length === 0) {
          addLog(`Trame · RSSI ${e.rssi ?? "?"} · company IDs: aucun`);
        } else {
          for (const id of ids) {
            const dv = e.manufacturerData.get(id);
            addLog(
              `Trame · RSSI ${e.rssi ?? "?"} · 0x${id.toString(16)} (${dv?.byteLength ?? 0} octets): ${
                dv ? hexDump(dv) : "—"
              }`,
            );
          }
        }
        const res = extractMAC(e.manufacturerData);
        if (res) {
          got = true;
          device.removeEventListener("advertisementreceived", onAdv);
          ac.abort();
          addLog(`🎉 MAC trouvée (CIC 0x${res.cic.toString(16)}) : ${res.mac}`);
          setMac(res.mac);
          setScanning(false);
        }
      };

      device.addEventListener("advertisementreceived", onAdv);
      device.watchAdvertisements({ signal: ac.signal }).catch((err) => {
        addLog("⚠️ watchAdvertisements a échoué : " + (err?.message ?? err));
      });

      setTimeout(() => {
        if (!got) {
          device.removeEventListener("advertisementreceived", onAdv);
          ac.abort();
          addLog("⏱️ Aucune MAC extraite. Le cube n'a peut-être pas émis (réveille-le et réessaie).");
          setScanning(false);
        }
      }, 12000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|user/i.test(msg)) addLog("Sélection annulée.");
      else addLog("Erreur : " + msg);
      setScanning(false);
    }
  };

  const inspect = async () => {
    setLog([]);
    setMac(null);
    setScanning(true);
    try {
      addLog("Ouverture du sélecteur Bluetooth…");
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "GAN" }, { namePrefix: "MG" }, { namePrefix: "AiCube" }],
        optionalServices: INSPECT_SERVICES,
      });
      addLog(`Cube : « ${device.name ?? "?"} ». Connexion GATT…`);
      const gatt = await device.gatt!.connect();
      addLog("✅ Connecté. Énumération des services…");

      const services = await gatt.getPrimaryServices();
      for (const svc of services) {
        const name = KNOWN_SERVICES[svc.uuid.toLowerCase()] ?? "inconnu";
        addLog(`• Service ${svc.uuid} — ${name}`);
        try {
          const chars = await svc.getCharacteristics();
          for (const ch of chars) {
            const p: string[] = [];
            if (ch.properties.read) p.push("read");
            if (ch.properties.write) p.push("write");
            if (ch.properties.writeWithoutResponse) p.push("writeNR");
            if (ch.properties.notify) p.push("notify");
            addLog(`   – ${ch.uuid} [${p.join(", ")}]`);
          }
        } catch {
          addLog("   (caractéristiques illisibles)");
        }
      }

      // A genuine cube often exposes its MAC via Device Information / System ID.
      try {
        const di = await gatt.getPrimaryService("device_information");
        const fields = [
          "system_id",
          "serial_number_string",
          "manufacturer_name_string",
          "model_number_string",
          "hardware_revision_string",
          "firmware_revision_string",
        ];
        for (const f of fields) {
          try {
            const c = await di.getCharacteristic(f);
            const v = await c.readValue();
            let text = "";
            try {
              text = new TextDecoder().decode(v).replace(/\0/g, "");
            } catch {}
            addLog(`   DI ${f}: ${hexDump(v)}${text ? `  ("${text}")` : ""}`);
            if (f === "system_id" && v.byteLength >= 8) {
              const b: number[] = [];
              for (let i = 0; i < v.byteLength; i++) b.push(v.getUint8(i));
              const hx = (x: number) => x.toString(16).toUpperCase().padStart(2, "0");
              // System ID = 5-byte manufacturer id (LE) + 3-byte OUI. Reconstruct MAC.
              const cand = [b[7], b[6], b[5], b[2], b[1], b[0]].map(hx).join(":");
              addLog(`   → MAC candidate (System ID): ${cand}`);
              setMac(cand);
            }
          } catch {
            /* field absent */
          }
        }
      } catch {
        addLog("Pas de service Device Information exposé.");
      }

      await device.gatt!.disconnect();
      addLog("Inspection terminée.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|user/i.test(msg)) addLog("Sélection annulée.");
      else addLog("Erreur : " + msg);
    }
    setScanning(false);
  };

  const copyMac = () => {
    if (!mac) return;
    navigator.clipboard?.writeText(mac).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const Row = ({ ok, label, value }: { ok: boolean | null; label: string; value: string }) => (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <span className="flex items-center gap-1.5 font-medium">
        {ok === null ? (
          <span className="text-slate-400">{value}</span>
        ) : (
          <>
            <span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "●" : "●"}</span>
            <span>{value}</span>
          </>
        )}
      </span>
    </div>
  );

  return (
    <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h2 className="text-lg font-bold">Diagnostic Bluetooth</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Vérifie ce que ton navigateur supporte, et tente de lire la MAC du cube (à coller ensuite
        dans le prompt — elle ne change jamais).
      </p>

      {caps && (
        <div className="mt-4 rounded-xl bg-slate-50 px-4 py-2 ring-1 ring-slate-200 dark:bg-slate-950 dark:ring-slate-800">
          <Row ok={null} label="Navigateur" value={caps.chrome} />
          <Row ok={caps.hasBluetooth} label="Web Bluetooth" value={caps.hasBluetooth ? "OK" : "Absent"} />
          <Row
            ok={caps.available}
            label="Adaptateur Bluetooth"
            value={caps.available === null ? "…" : caps.available ? "Disponible" : "Indisponible"}
          />
          <Row
            ok={caps.hasWatchAdv}
            label="watchAdvertisements (flag expérimental)"
            value={caps.hasWatchAdv ? "Actif ✅" : "Inactif — flag à activer"}
          />
        </div>
      )}

      {caps && !caps.hasWatchAdv && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          Le flag n&apos;est pas actif. Ouvre <code className="font-mono">chrome://flags/#enable-experimental-web-platform-features</code>,
          mets-le sur <strong>Enabled</strong>, puis clique <strong>Relaunch</strong>. Cette ligne
          repassera au vert.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={scan}
          disabled={scanning || !caps?.hasBluetooth}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {scanning ? "En cours…" : "Lire la MAC (advertising)"}
        </button>
        <button
          onClick={inspect}
          disabled={scanning || !caps?.hasBluetooth}
          className="inline-flex items-center gap-2 rounded-xl bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-600 disabled:opacity-50"
        >
          {scanning ? "En cours…" : "Inspecter les services (GATT)"}
        </button>
      </div>

      {mac && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
          <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Adresse MAC :
          </span>
          <code className="font-mono text-base font-bold text-emerald-900 dark:text-emerald-200">
            {mac}
          </code>
          <button
            onClick={copyMac}
            className="ml-auto rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
          >
            {copied ? "Copié !" : "Copier"}
          </button>
        </div>
      )}

      {log.length > 0 && (
        <pre className="mt-4 max-h-64 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-200">
          {log.join("\n")}
        </pre>
      )}
    </section>
  );
}
