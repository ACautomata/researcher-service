FROM searxng/searxng@sha256:9dc6d0472930d981f5955f0379e107257383be2d81897b25df89cf37d789f152
COPY settings.yml /etc/searxng/settings.yml
# Instance-only signing key; generated inside the container, never baked into an image.
ENTRYPOINT ["/bin/sh", "-c", "export SEARXNG_SECRET=$(python -c 'import secrets; print(secrets.token_hex(32))'); exec /usr/local/searxng/entrypoint.sh"]
