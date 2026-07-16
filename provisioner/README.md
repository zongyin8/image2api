# image2api Provisioner

This service preserves the custom ChatGPT account provisioning UI without
running the legacy ChatGPT2API application.

It provides the `/api/register*` contract used by `ProvisionView.vue`, stores
registration and mailbox-pool state under `PROVISION_DATA_DIR`, and imports
successful access tokens directly through image2api's admin API. Failed imports
remain in `registered_accounts.json` and are retried every 60 seconds.

Required environment variables:

- `PROVISION_ADMIN_KEY`
- `IMAGE2API_ADMIN_PW`

Optional environment variables:

- `IMAGE2API_BASE` (default `http://127.0.0.1:2000`)
- `IMAGE2API_ADMIN` (default `admin`)
- `PROVISION_DATA_DIR` (default `/var/lib/image2api-provisioner`)

The included systemd unit binds the service to `127.0.0.1:18002`. Nginx must
authenticate the image2api admin session before forwarding `/register/api/`.

For production, prefer the tracked Compose definition:

```bash
cp provisioner.env.example provisioner.env
# Set both secrets in provisioner.env.
docker compose -f provisioner/docker-compose.yml up -d --build
```

It uses host networking so it can reach image2api on `127.0.0.1:2000`, binds
the API on `127.0.0.1:18002` through Uvicorn, and persists state in
`/var/lib/image2api-provisioner`.
