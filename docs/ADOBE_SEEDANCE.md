# Adobe Seedance 2.0 Integration Notes

Last verified: 2026-07-17

## Status

- Adobe exposes Seedance through the third-party video endpoint:
  `POST https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async`.
- The standard model is `modelId=seedance`, `modelVersion=seedance_2.0`.
- The fast model is `modelVersion=seedance_2.0_fast`.
- Both standard and fast generation completed successfully with no proxy. The
  Firefly website's model picker is region gated, but the API call itself did
  not require a Japan exit during live verification.
- Both engines are implemented in the provider and exposed as managed model
  IDs `seedance-2.0` and `seedance-2.0-fast`.

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

- Standard through Japan proxy: 1280x720, 16:9, 4 seconds, completed in about
  122 seconds with a valid `video_url`.
- Standard direct: completed in about 143 seconds with a valid `video_url`.
- Fast direct: completed in about 101 seconds with a valid `video_url`.
- All tests used no reference media and no generated audio. A standard 4-second
  test consumed 360 Adobe credits.

An older account returned `408 timeout_error: system under load`. Adobe's live
credit endpoint showed that account had `available=0`, even though image2api's
cached balance still showed 910. The account was marked quota-limited in the
production database so it is no longer scheduled.

## Production Notes

1. Prefer direct access for Seedance accounts while the direct API remains
   healthy. A Japan proxy is only needed to expose the model in the Firefly web
   UI, not for the verified API flow.
2. If an individual account needs a regional route, set its `proxy_url` from
   account management instead of changing the node-wide `proxy.url`.
3. Do not commit account tokens, cookies, proxy credentials, or subscription
   URLs. Import them through account management or production secrets only.
4. Keep standard and fast as separate managed models so their health, pricing,
   and scheduling can be changed independently.

## Account Refresh Caveat

- Reject cookie exchanges whose token subject is empty or ends in `@GuestID`.
  Such a token is a guest session and must never overwrite a working AdobeID
  access token.
- The production account imported on 2026-07-17 uses a verified `FF-iOS`
  access token. Its supplied cookie only exchanged to a GuestID token, so that
  account's refresh profile is intentionally disabled until renewable AdobeID
  credentials are imported.
