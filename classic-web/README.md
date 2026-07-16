# Classic web

This directory is the tracked source of the static interface served at `/` on
the Go2Api deployment. The Vue application under `frontend/` is served at
`/new/`.

Deploy the directory contents to `/opt/image2api-g2a/web-user/`. Do not deploy
old `.b64` snapshots from the server; they are not runtime assets.
