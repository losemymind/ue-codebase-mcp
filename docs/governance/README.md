# Ownership governance

`ownership.json` contains both the current solo model and the future team model. Application and deployment code refer to stable role names; this file maps those roles to identities. `active_mode` is the only mode selector.

The current solo mode maps all five roles to `personal_libo`, displayed as `LIBO`, with the user-confirmed GitHub subject `github:losemymind`. Its corresponding GitHub CODEOWNERS identity is `@losemymind`. The committed CODEOWNERS file is derived from the active roles; `npm run governance:check` rejects drift.

Solo mode is deliberately `self_attested`, records risk acceptance `PERSONAL-1`, and is never Phase 1 G1 eligible. This permits personal technical ownership, release self-review and deployment work without misrepresenting them as independent acceptance.

The inactive team mode already separates control-plane, security/release, operations, fixed-device quality and G1 review roles. Its principals are deliberately `UNCONFIGURED` and cannot become active. To prepare a team once:

1. Replace each `github-team:UNCONFIGURED/...` value with the exact `github-team:<organization>/<team>` subject.
2. Set each corresponding `configured` field to `true`.
3. Run `npm run governance:check` while solo mode is still active.
4. Change only `active_mode` from `solo` to `team`.
5. Run `npm run governance:sync`; this validates team readiness, updates CODEOWNERS from the active roles and verifies the result.
6. Update the GitHub branch ruleset and issue new approval records. Existing solo approvals remain historical self-attestations and are not promoted automatically.

Switching back to solo also changes only `active_mode`, but it lowers assurance and makes G1 ineligible. Mode policy fields must not be edited to bypass that boundary.

CODEOWNERS routes code review but cannot enforce the project's five-way approval separation by itself. On GitHub, a repository administrator must create a branch ruleset for the protected branch, require the `ci / verify` status check, prevent bypass as appropriate, and select the required review count. Solo mode must not label the owner's own review as independent approval. When team mode becomes active, the ruleset must require independent reviewers consistent with the configured security/release and G1 roles.
