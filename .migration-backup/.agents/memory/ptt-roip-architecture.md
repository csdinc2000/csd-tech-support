---
name: PTT and RoIP architecture
description: The current voice console uses browser WebRTC floor control and deliberately avoids pretending to support a specific physical-radio vendor protocol.
---

The selected physical bridge is a fixed-address Twilio SIP Domain using authenticated SIP INVITEs, bidirectional PCMU/8000 Media Streams, and the CSD-RoIP/1 dispatch boundary. Browser operators retain peer-to-peer WebRTC audio with server-enforced floor control.

**Why:** Replit does not expose a raw SIP/RTP UDP edge, so Twilio terminates SIP and forwards media over authenticated WebSockets. Process-local stream tokens and floor state also require one always-on production instance.

**How to apply:** Run RoIP on one Reserved VM, keep SIP credential mappings exclusive to the one gateway identity, and configure the hardware for PCMU/8000 RTP with VOX/RTP keying. Never enable RoIP on a scaling deployment.