// mdrelay/src/types.ts
export type DeviceRole = "host" | "remote";

export interface PairingMeta {
  pairingId: string;
  createdAt: number;
  hostDeviceId: "host";
}

export interface DeviceTokenPayload {
  pairingId: string;
  deviceId: string;        // "host" or "remote:<id>"
  role: DeviceRole;
  issuedAt: number;
}

export interface PairingCode {
  code: string;            // 6 blocks of 3 hex chars, separated by -
  pairingId: string;
  expiresAt: number;       // ms
}

export interface BufferedFrame {
  to: string;              // routing destination ("host" or "remote:<id>" or "broadcast")
  from: string;
  pairingId: string;
  bytes: number;           // payload size for accounting
  body: string;            // raw JSON text (what we send over WS)
  ts: number;
}
