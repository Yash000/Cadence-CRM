# Running the automation layer

Local Docker. Verified working on n8n 2.39.7.

## It is already running

```
http://localhost:5678
```

Login: `yash.baidya27@bimtech.ac.in` / `CadenceDemo2026!`

## Everyday commands

```powershell
docker start cadence     # after a reboot (it also restarts on its own)
docker stop cadence
docker logs -f cadence
docker ps --filter name=cadence
```

State lives in the `cadence-n8n-data` volume, so anything you create in the
editor survives a restart. The three committed workflows are re-imported from
the image on every boot and will overwrite edits you made to *them* in the UI —
edit the JSON in `workflows/` and rebuild instead.

## Rebuilding after changing a workflow file

```powershell
cd "e:\Cadence CRM\n8n-space"
docker build -t cadence-n8n:local .
docker rm -f cadence
# then re-run the command in "Recreating from scratch" below
```

## Recreating from scratch

Generate a password hash (n8n stores bcrypt, never plaintext). Note
`--entrypoint node` — without it Docker passes `node -e ...` as arguments to
`entrypoint.sh`, which ignores them and boots n8n instead, and the command
appears to hang:

```powershell
docker run --rm --entrypoint node cadence-n8n:local -e "const b=require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/bcryptjs@2.4.3/node_modules/bcryptjs');console.log(b.hashSync('YOUR-PASSWORD',10))"
```

Then:

```powershell
docker volume create cadence-n8n-data
docker run -d --name cadence --restart unless-stopped `
  -p 5678:7860 `
  -v cadence-n8n-data:/home/node/.n8n `
  -e N8N_INSTANCE_OWNER_EMAIL=you@example.com `
  -e "N8N_INSTANCE_OWNER_PASSWORD_HASH=<the `$2a`$10`$... hash>" `
  -e N8N_INSTANCE_OWNER_FIRST_NAME=Yash `
  -e N8N_INSTANCE_OWNER_LAST_NAME=Baidya `
  -e N8N_ENCRYPTION_KEY=cadence-local-dev-key-change-if-shared `
  cadence-n8n:local
```

Keep `N8N_ENCRYPTION_KEY` stable — it encrypts stored credentials, and changing
it makes every saved credential unreadable.

## Attaching credentials

Open each Postgres / HTTP node once and create the credential (see README for
which role goes where). **Connect WARP first** — the campus firewall blocks
Postgres 5432/6543, and without it the connection test hangs rather than
failing cleanly.

## Activating

Workflows import deactivated. Toggle **Active** on 02 and 03 for the schedules.
Workflow 01 activates once a real Shopify webhook points at its URL.

## A public URL, when you need one

Only required if something outside your machine must reach n8n — a real Shopify
webhook, say. Manual "Execute Workflow" runs and calls from the Next.js app on
localhost do not need it.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:5678
```

That prints a free `https://<random>.trycloudflare.com` URL, no account needed.
Recreate the container with `-e N8N_WEBHOOK_URL=https://<that-url>/` so n8n
builds webhook URLs against it. (`N8N_WEBHOOK_URL` is current;
`WEBHOOK_URL` is a deprecated alias that warns at startup from 2.35.0.)

## Demo notes

The **Executions** tab is the thing worth showing — every run, per-node input
and output, retries. It is a visual audit log, and it makes the "agentic"
argument better than a code walkthrough does.

Export workflows with Workflow → Download and commit them to `workflows/` if
you need them as submittable artifacts.
