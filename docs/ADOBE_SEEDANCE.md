# Adobe Seedance 2.0 Integration Notes

Last verified: 2026-07-17

## Status

- Adobe exposes Seedance through the third-party video endpoint:
  `POST https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async`.
- The standard model is `modelId=seedance`, `modelVersion=seedance_2.0`.
- The fast model is `modelVersion=seedance_2.0_fast`, but Adobe discovery
  reported it as `CRITICAL` during verification. Do not enable the fast model
  until its health status is stable.
- Seedance discovery and the Firefly model picker are region gated. A verified
  Japan exit showed the model; the production-wide `proxy.url` setting was
  empty at the time of testing.
- The provider payload is implemented and unit tested, but no managed model is
  created and no production deployment has been made yet.

## Verified Standard Payload

The successful text-to-video test used:

```json
{
  "modelId": "seedance",
  "modelVersion": "seedance_2.0",
  "prompt": "A paper boat floating on a calm pond at sunrise, gentle camera movement",
  "seeds": [123456],
  "size": {"width": 1280, "height": 720},
  "generationSettings": {"aspectRatio": "16:9"},
  "generateAudio": false,
  "duration": 4,
  "generationMetadata": {
    "module": "text2video",
    "submodule": "ff-video-generate"
  },
  "output": {"storeInputs": true}
}
```

Do not send the fixed 24 FPS label from the Firefly UI. Adobe's Seedance
discovery schema does not accept `fps` for this model version.

## Live Verification

- Exit region: Japan.
- Output: 1280x720, 16:9, 4 seconds, no reference media, no generated audio.
- Completion time: about 122 seconds.
- Result: completed with a valid `video_url`.
- Adobe credit cost: 360 credits.

An older account returned `408 timeout_error: system under load`. Adobe's live
credit endpoint showed that account had `available=0`, even though image2api's
cached balance still showed 910. The account was marked quota-limited in the
production database so it is no longer scheduled.

## Remaining Work Before Production

1. Add `seedance2` to `resolveAdobeVideoEngine` and create a managed video model.
2. Enforce the supported duration range (4-15 seconds), resolution tiers, aspect
   ratios, optional audio, and reference-media limits in the API and frontend.
3. Configure a Japan proxy independently on each generation node. Do not commit
   proxy credentials or subscription URLs.
4. Import a credited Adobe account through account management and verify quota
   refresh before enabling the model for users.
5. Run one admin-pinned smoke test, then enable the model without restarting
   unrelated nodes.
