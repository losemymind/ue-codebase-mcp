# TLS edge baseline

`nginx.conf` is paired with the exact-version, digest-pinned NGINX image supplied through `EDGE_PROXY_IMAGE`. It terminates TLS on container port 8443, disables access logging, bounds headers, bodies, connections, requests and upstream timeouts, forwards only the MCP endpoint, OAuth protected-resource metadata and liveness/readiness, and returns `404` for `/metrics` and every other path.

The MCP request body cap is one MiB at both the edge and application boundary. Client-provided forwarding chains are erased; the application continues to validate the original Host and optional Origin. The edge configuration contains no payload-bearing access-log fallback. Certificate trust, cipher policy, hostname, expiry, rotation and live TLS behavior still require operations approval and fixed-device evidence.
