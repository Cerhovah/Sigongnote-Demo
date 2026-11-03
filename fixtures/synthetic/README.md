# C08 synthetic case corpus

`source-structures-v1.json` contains synthetic structural surrogates for the I04–I10 descriptions and the I12 simulation. `source_locator_hint` records only the publicly documented range or section; `locator` identifies a span in this synthetic JSON. Neither is a verified locator into a private original. The source-ID-to-private-file map stays outside Git.

`case-oracles-v1.json` gives typed expected values and forbidden outcomes for T01–T30. It pins the original 30 prose cases in `handoff/CASE_INDEX.json`; the manifest pins the corpus, unit registry and source index hashes. The shared `split_group` keeps related revisions and representations together when later parser/model evaluation sets are made. No parser or acceptance test is marked passed by fixture validation.

`unit-registries-v1.json` pins the current base units and the proposed joinery `panel`/`frame` units. T05/T06 depend on the C26 joinery pack registering those units; the current base contract intentionally rejects them. T10 has an occurrence before the 18:00 cutoff and a later 18:05 knowledge/record time, so occurrence-only filtering must fail.

Run `npm run test:fixtures` for corpus structure and provenance consistency. `npm run test:case -- T01` selects a case and returns `NOT_RUN` with exit code 2 until an executable adapter is implemented. C19–C22 must add valid format-specific HWP5/XLS/XLSX/PDF golden binaries with reviewed SHA256 allowlist entries and separate real parser results. A JSON surrogate alone cannot prove format support.
