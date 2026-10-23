# Third-party notices and source provenance

The two Advisor plugins are derived from Daniel McAteer's MIT-licensed projects:

| Project | Original source | Local customized snapshot |
| --- | --- | --- |
| Astra Advisor | https://github.com/DannyMac180/astra-advisor | 0.2.1+renna.3; local baseline commit c72d3280551f |
| Sol Advisor | https://github.com/DannyMac180/sol-advisor | 0.8.1+renna.2; recipient should compare upstream before upgrades |

Each `advisors/*/LICENSE` retains the original copyright and full MIT permission
notice. Plugin author metadata continues to identify the original author. The
public source distribution and private machine configuration are distinct.

The `reference-runtime` source and source-kit documentation are David Renna's
local-fleet integration, released under the root MIT license. Third-party model
weights, inference engines, native sandbox binaries, client applications and
dependencies are not distributed here; their own licenses still apply when
installed separately. A model's availability does not establish its licensing or
task quality. No upstream endorsement is implied.

Machine bindings were replaced with inert placeholders. Source hashes in
`SOURCE-MANIFEST.json` describe the public sanitized files, not the author's private
filesystem. Original Git histories, personal policies, private registries,
credential files, state, receipts and logs were not copied.
