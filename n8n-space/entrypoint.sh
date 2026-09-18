#!/bin/sh
# Rebuild the instance from scratch on every boot.
#
# A free HF Space has no persistent disk, so this script treats n8n as a
# stateless appliance: the SQLite database starts empty each time, and both the
# owner account and the demo workflows are restored from env + image before the
# server accepts its first request. The upside of accepting that constraint
# rather than fighting it is that the Space is reproducible -- what a visitor
# sees is exactly what is committed to this repo, never leftover state from
# someone else's session.
set -e

# ---------------------------------------------------------------------------
# Owner account, provisioned from Space secrets.
#
# n8n 1.0 removed every "just turn auth off" switch, so an unclaimed public
# instance is claimed by its first visitor. These variables make n8n create
# (and on every reboot, re-create) a known owner instead, so the account is
# already taken before anyone reaches it.
#
# N8N_INSTANCE_OWNER_PASSWORD_HASH is a BCRYPT HASH, not a password. Generate
# one locally and paste it into the Space's secrets -- see SETUP.md.
# ---------------------------------------------------------------------------
if [ -n "$N8N_INSTANCE_OWNER_PASSWORD_HASH" ]; then
  export N8N_INSTANCE_OWNER_MANAGED_BY_ENV=true
  export N8N_INSTANCE_OWNER_EMAIL="${N8N_INSTANCE_OWNER_EMAIL:-demo@cadence.local}"
  export N8N_INSTANCE_OWNER_FIRST_NAME="${N8N_INSTANCE_OWNER_FIRST_NAME:-Cadence}"
  export N8N_INSTANCE_OWNER_LAST_NAME="${N8N_INSTANCE_OWNER_LAST_NAME:-Demo}"
  echo "[boot] owner account managed by env: $N8N_INSTANCE_OWNER_EMAIL"
else
  # Loud, because the failure mode is silent and bad: a public Space that any
  # passer-by can take ownership of.
  echo "[boot] WARNING: N8N_INSTANCE_OWNER_PASSWORD_HASH is not set."
  echo "[boot] WARNING: the first visitor to this Space will claim the owner account."
  echo "[boot] WARNING: set it in Space secrets, or make the Space private."
fi

# ---------------------------------------------------------------------------
# Public URL. n8n builds webhook URLs from this; without it they come out as
# http://localhost:7860/... and are useless to Shopify or anything external.
# HF exposes the Space at https://<owner>-<space>.hf.space.
#
# N8N_WEBHOOK_URL is the current name; WEBHOOK_URL is a deprecated alias that
# logs a startup warning from n8n 2.35.0 onward.
# ---------------------------------------------------------------------------
if [ -n "$SPACE_HOST" ]; then
  # SPACE_HOST is injected by Hugging Face, e.g. "yash-cadence-n8n.hf.space".
  export N8N_HOST="$SPACE_HOST"
  export N8N_WEBHOOK_URL="https://${SPACE_HOST}/"
  export N8N_EDITOR_BASE_URL="https://${SPACE_HOST}/"
  export N8N_PROTOCOL=https
  echo "[boot] public URL: https://${SPACE_HOST}/"
fi

# ---------------------------------------------------------------------------
# Demo workflows, re-imported from the image on every boot.
#
# NO --activeState=fromJson here, despite it being the obvious flag to reach
# for. It is rejected outside queue/multi-main mode ("workflow activation is
# not supported"), and n8n treats that as fatal to the WHOLE import -- the
# observed result was a Space that booted cleanly with an empty editor, which
# is exactly the kind of quiet failure you only notice mid-demo. Workflows
# therefore import deactivated and get toggled on in the UI; see SETUP.md.
#
# Each file carries a stable top-level `id`, which makes re-import an UPSERT
# rather than an insert. Without one, every restart on a host that DOES have a
# persistent volume (anything other than a free Space) adds another copy, and
# you are looking at nine workflows by Wednesday.
#
# Failure here is deliberately non-fatal: a malformed workflow should leave you
# with a running editor you can debug in, not a Space stuck in a crash loop.
# ---------------------------------------------------------------------------
if [ -d /demo/workflows ] && [ -n "$(ls -A /demo/workflows 2>/dev/null)" ]; then
  echo "[boot] importing demo workflows..."
  if n8n import:workflow --separate --input=/demo/workflows/; then
    echo "[boot] workflows imported (inactive — activate them in the editor)"
  else
    echo "[boot] WARNING: workflow import failed; starting with an empty editor"
  fi
fi

echo "[boot] starting n8n on :${N8N_PORT}"
exec n8n start
