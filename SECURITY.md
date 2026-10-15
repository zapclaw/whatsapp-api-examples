# Security

## Never paste credentials into an issue

Issues here are **public and permanently mirrored**. Anything pasted into one is
scraped within minutes, and deleting the issue does not recall it.

Never include in a public issue:

- a ZapClaw API key (`zc_live_...`)
- a webhook signing secret (`whsec_...`)
- a real customer phone number or `user_id`
- your webhook URL, when it carries a token
- a WABA id or phone number id belonging to someone else

The secret in `webhook-signature/fixture/fixture.json` is a test value. It signs
nothing real, and you can paste it freely.

**If you have already pasted a key or a secret somewhere public, treat it as
compromised.** Revoke the key in the ZapClaw dashboard under *API Keys*, or generate a
new signing secret on the *Webhook* page. Deleting the comment is not enough.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Write to **[contato@zapclaw.app](mailto:contato@zapclaw.app)** with the subject line
starting `SECURITY:`. Include what you found, how to reproduce it, and what you think
the impact is. You will get an acknowledgement within three business days.

This repository is example code, so most reports will concern the ZapClaw service
itself rather than this repository. Send those to the same address.

## Scope of this repository

It contains no credentials. The send examples talk to `https://api.zapclaw.app` with a
key you supply through the environment, and the tests only ever call a local mock. Read
any script before running it with a real key.
