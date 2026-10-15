# Onshape link

File, Import from Onshape link. Paste the link of an Onshape part studio, or of
a whole document, and its parts arrive as a STEP import with their names and
colours.

## Why these grants

`network` for `.onshape.com` only, which is `cad.onshape.com` and a company's
own `<name>.onshape.com`. The request goes through `plugin_web_request`, which
refuses any other host, plain http, and any name that resolves to a private
address. A redirect off Onshape is refused here too, so the keys never travel
to another host.

`document.write` because the downloaded STEP becomes an import feature. The
feature records the link without its query, never the local file and never a
key.

## Keys

Onshape API keys, created at dev-portal.onshape.com/keys with read access. They
are kept in the system's credential store (`plugin_secret_*`), never in a file,
the document or the log. Preferences, Onshape forgets them.

Each request is signed the way Onshape's reference client does it: HMAC-SHA256
over method, nonce, date, content type, path and query, lowercased. The test
vectors in `tests/plugins/onshapeSign.test.ts` use the example secret and date
from Onshape's API key page and were checked with openssl:

    printf 'get\n0123456789abcdefghijklm\nmon, 11 apr 2016 20:08:56 gmt\n\n/api/v10/translations/5d6f9ec8a6a7ce1a1e2a0b34\n\n' \
      | openssl dgst -sha256 -hmac abcdefghijklmnopqrstuvwxzy0123456789abcdefghijkl -binary | base64

## What is here

- `url.ts`, reads a link into document, workspace or version, and element.
- `sign.ts`, the request signature.
- `client.ts`, signed requests, a new signature for each 307 hop, waiting on 429.
- `translate.ts`, which part studios a link names, the STEP translation and its
  polling, about one request a second at most as Onshape asks.
- `flow.ts`, the menu row's whole job: ask, export, download, import, delete
  the download.
- `LinkDialog.vue`, the link, and the keys when none are stored.
- `KeysSection.vue`, the Preferences card that forgets the keys.

Assemblies and configured part studios other than their default configuration
are not imported yet.

## Checking it by hand

The unit tests run against a fake Onshape. With a real account:

1. Create an API key with read permission at dev-portal.onshape.com/keys.
2. File, Import from Onshape link, paste a part studio link and both keys.
3. Expect "Exporting <part studio> from Onshape", then one import feature with
   Onshape's part names and colours, whose source is the link.
4. Windows Credential Manager lists two FundaCAD entries, and the plugin's
   `plugin-data/FundaCAD.Onshape/downloads` folder is empty afterwards.
5. Try a `/v/<version>/e/<element>` link and a link with no `/e/`, which
   imports every part studio.
6. Preferences, Onshape, Forget keys, then a wrong secret: expect "Onshape
   refused the keys".
7. "is not one of the hosts this plugin may reach" means Onshape redirected
   the download off `*.onshape.com`, and that host needs adding.
