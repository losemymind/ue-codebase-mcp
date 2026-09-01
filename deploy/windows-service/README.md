# Windows Agent service baseline

`manage-agent-service.ps1` manages only the fixed `UECodebaseMcpAgent` service. It defaults to `Plan`, confines the packaged executable and configuration below an explicit install root, rejects reparse-point inputs, verifies both approved SHA-256 values before installation or update, and accepts only the service virtual account or a strictly named gMSA. It never accepts, stores, or forwards a password. Install and update configure two delayed service restarts followed by a stopped state, avoiding an unbounded crash loop.

Production installation requires the signed `ue-codebase-mcp-agent.exe`, a validated configuration containing only `secret_ref`, the approved service identity, install root, TLS endpoint, and host ACLs. This repository does not claim that a service was installed on the development machine.
