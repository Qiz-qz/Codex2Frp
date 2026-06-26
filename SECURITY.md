# Security

Codex2Frp bridges a local Codex Desktop session to a mobile app and an optional browser console. Treat the service URL and token as local secrets.

## Do Not Commit

- `.runtime/` contents
- Logs that include access links or tokens
- Remote-link credentials or private tunnel details
- Signing material, private keys, certificates, or keystores
- Personal device IDs, account names, or local-only configuration

The repository uses placeholder domains and paths in tests and documentation. Replace them only in local runtime configuration, not in committed files.

## Deployment Notes

- Bind remote access only to trusted remote-link routes.
- Do not publish screenshots that include full access URLs with tokens.
- Stop the service before replacing the installed backend executable.
- Enable Codex control only on a trusted desktop session.

## Reporting

If you find a token leak, unsafe default, or remote-control bypass, report it privately first and include reproduction steps without publishing active credentials.
