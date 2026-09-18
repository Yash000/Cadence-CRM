# n8n on Hugging Face Spaces (Docker SDK).
#
# Why this file is shaped the way it is:
#
#   * A free Space has an EPHEMERAL filesystem. Every restart, rebuild and
#     wake-from-sleep gives you a clean /home/node/.n8n. Anything a visitor
#     creates in the editor is gone by the next boot. So both the things that
#     normally live in that directory -- the owner account and the workflows --
#     are instead reconstructed from the image + env on every single start.
#     See entrypoint.sh.
#
#   * n8n removed N8N_BASIC_AUTH_* and N8N_USER_MANAGEMENT_DISABLED in 1.0.
#     There is no supported way to run without a login screen, which on a
#     PUBLIC Space means whoever loads it first claims the instance. The
#     N8N_INSTANCE_OWNER_MANAGED_BY_ENV vars in entrypoint.sh close that hole.
#
#   * HF routes traffic to a single port declared as `app_port` in README.md.
#     7860 is the HF convention; n8n's own default (5678) is overridden to
#     match rather than changing app_port, so the README stays idiomatic.
# Docker Hub rather than n8n's own docker.n8n.io mirror: the mirror returned
# 429 Too Many Requests on an ordinary first build, and HF's builder is a far
# busier IP than this laptop. Version pinned so the Space you demo is the one
# that was tested, not whatever :latest became that morning.
FROM n8nio/n8n:2.39.7

USER root

# Workflows are baked into the IMAGE, not the volume, precisely because the
# volume does not survive. entrypoint.sh re-imports them on every boot.
COPY workflows/ /demo/workflows/
COPY entrypoint.sh /demo/entrypoint.sh

RUN chmod +x /demo/entrypoint.sh && chown -R node:node /demo

# The n8n image already defines uid 1000 as `node`, which is what HF Spaces
# expects a Docker Space to run as. Nothing to create.
USER node

ENV N8N_PORT=7860 \
    N8N_LISTEN_ADDRESS=0.0.0.0 \
    N8N_USER_FOLDER=/home/node \
    GENERIC_TIMEZONE=Asia/Kolkata \
    N8N_DIAGNOSTICS_ENABLED=false \
    N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    N8N_TEMPLATES_ENABLED=false \
    N8N_ONBOARDING_FLOW_DISABLED=true

EXPOSE 7860

ENTRYPOINT ["/demo/entrypoint.sh"]
