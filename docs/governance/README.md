# Ownership governance

`ownership.json` contains both the current solo model and the future team model. Application and deployment code refer to stable role names; this file maps those roles to identities. `active_mode` is the only mode selector.

The current solo mode maps all five roles to `personal_libo`, displayed as `LIBO`, with the user-supplied opaque subject `github:losemymind.libo@gmail.com`. Because that subject is email-shaped rather than a normal GitHub `@login`, it is not emitted as a CODEOWNERS entry. Replace it with the actual GitHub login before adding personal CODEOWNERS enforcement.

Solo mode is deliberately `self_attested`, records risk acceptance `PERSONAL-1`, and is never Phase 1 G1 eligible. This permits personal technical ownership, release self-review and deployment work without misrepresenting them as independent acceptance.

The inactive team mode already separates control-plane, security/release, operations, fixed-device quality and G1 review roles. Its principals are deliberately `UNCONFIGURED` and cannot become active. To prepare a team once:

1. Replace each `github-team:UNCONFIGURED/...` value with the exact `github-team:<organization>/<team>` subject.
2. Set each corresponding `configured` field to `true`.
3. Run `node tools/validate-ownership.mjs docs/governance/ownership.json` while solo mode is still active.
4. Change only `active_mode` from `solo` to `team` and run the validator again.
5. Update branch protection/CODEOWNERS from the same resolved team subjects and issue new approval records. Existing solo approvals remain historical self-attestations and are not promoted automatically.

Switching back to solo also changes only `active_mode`, but it lowers assurance and makes G1 ineligible. Mode policy fields must not be edited to bypass that boundary.
