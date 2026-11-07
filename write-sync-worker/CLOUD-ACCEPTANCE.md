# Sumi sync cloud acceptance

Validated on2026-11-07 UTC (2026-11-08 Asia/Taipei), using isolated test spaces. This certifies the deployed sync service; it does not certify publication of the host or plugin, other OS implementations, or completed physical IME acceptance.

## Frozen deployment

- Service: `https://sumi-sync.oldbruce.workers.dev`
- Worker version: `1cbee039-dcb3-4434-a0dc-03c43687ab9b` (100%).
- Deployment: `37f32856-5ff9-437c-9c38-949437d39035`.
- Runtime/package/config source manifest SHA-256: `65f0467e6a102ca408aee49d90cd4cb4eb87193e0c52ae4b48834012b4be1542`.
- Downloaded deployed `index.js` SHA-256: `d6b01865e6f87224fb80d7e4f092fa5573b64690c3047836ea57776c9febbc64`; exact match to fresh Wrangler3 dry-run output.
- Packed validator source SHA-256: `1c8b20579d18cf8092d06da95a2becba5fbd35f1986257f71dd2340e0caa3f7a`.
- Existing repository Wrangler3.114.17 / Account API Token used; no OAuth, Wrangler upgrade, or paid-plan upgrade. Runtime source was uncommitted at deployment; the enclosing Git commit records its verified source. Documentation/acceptance-script updates do not change the deployed module.

## Passed behavior

The50-test Worker suite and TypeScript check pass, including14 packed-validator real-DO tests and legacy/new-space routing. A populated legacy test space still passes nativeHTTP/WSS replay after the packed deployment.

A real native100,000-sequential-key history is13,258,603 bytes /200,004 structs, fixture SHA-256 `76e9c78a1a2789b7eae6455b235d0f4cba0491fe62a4a6e85335ef2cd5e790af`. The real cloud tests passed:

- Private authentication and one-use device pairing.
- Durable exact update ACK and same-operation retry.
-13-page checksummed HTTP replay and full WebSocket journal replay.
- Same authenticated WebSocket survives actual45-second hibernation: instance nonce changes, then live delivery continues.
- Two devices' concurrent offline edits merge without replacing either draft.
- Frozen R2 backup restored into a new credential-isolated space; the later AFTER edit is absent from that frozen revision.
- Revocation closes a fresh connected device socket with4001 and rejects its access, refresh, and outstanding invitation.
- Dedicated R2 bucket is private, without public custom domains;30-day retention verified. Secrets remain only in dedicated Worker bindings and local Keychain/private0600 bootstrap files.

Final actual host-Rust transport, with production dependencies (reqwest0.12.28, async-compression0.4.52, compression-codecs0.4.47, Brotli9.0.0, flate2 1.1.9), validates100,007 characters through bothHTTP andWSS. Measured HTTP224,540ms andWS989,554ms on this slow link; the two independent large readback probes overlapped. Those are cold whole-history transfer times, **not** incremental editing latency. The32-test isolated host transport/durability harness and strictClippy pass, including real truncated-page retry and renewed-token WS-handshake checks.

## Capacity and limits

Local actual-workerd complete import/duplicate/backup/recovery used21,101 SQLite row writes and8,628 reads. Initial import itself used10,192 writes. The conservative pre-cloud allowance was26,101 writes /208,628 reads. After cloud service acceptance the shared account's UTC-day audit showed22,945 writes /15,592 reads, with zero exceededCPU and exceededMemory errors. Subsequent read-only native and separate UI tests add small usage; the figure is an audit timestamp, not a permanently current account total. Actual successful production import/recovery proves this scenario fits the platform limits; no exact production RSS value is claimed.

Packed indexing does not make Free unlimited: measured validator-only ordinary one-character packets cost about12.98 row writes each, before journal/receipt/catalog/backup overhead. The shared Free quota remains100,000 writes/day. Limits reject explicitly instead of truncating history.

The original large-upload deadline was too short:17,678,231 JSON bytes required197.279s. Native HTTP originally lacked content compression and a large read timed out after647.426s. Brotli/gzip, bounded per-packet deadlines, exact read-page retry, and fresh WS credentials corrected the client path. Original failures are retained in the local acceptance artifacts. A host coordinator must not preempt an already-authorized pending replay solely because its cached token expires while queued bytes are arriving; the service still enforces new-message expiry and revocation. Large replay completion and live UI scheduling are separate acceptance concerns.

## Evidence and scope

The repository workspace artifacts under `tasks/sumi-sync/` include `packed-capacity-budget.json`, `cloud-deployment.json`, `cloud-source-readback.json`, `cloud-acceptance-sequential.json`, `cloud-native-sequential-production.json`, `cloud-native-compression-diagnosis.json`, and test logs. They contain no usable credentials. Private raw credentials, responses, and invitation files are deliberately outside Git.

Formal owner space remains separate from testing. A separate small UI-only space was created for host/peer live editing; its current offline peer delta has been prepared but is not submitted until the UI concurrent edit is ready. Host integration, physical UI/IME acceptance, and host/plugin publication remain the parent release workflow's responsibility.
