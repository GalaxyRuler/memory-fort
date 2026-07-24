# ADR 0002: Node runtime and install configuration contract

- Status: accepted
- Date: 2026-07-24

## Context

Node 20 reached end of life on 2026-04-30. Node 22 remains Maintenance LTS through 2027-04-30, while Node 24 is the current release line used for packaging and remains supported through 2028-04-30. The authoritative schedule is maintained by the [Node.js Release working group](https://github.com/nodejs/Release) and summarized on the [Node.js previous releases page](https://nodejs.org/en/about/previous-releases).

The project ships the root package and `memory-fort-sdk`, so their manifests and lockfile root records must declare the same supported floor. A newer release runtime alone does not prove the minimum runtime still works.

The pinned `onnxruntime-node` 1.22.0 installer reads `ONNXRUNTIME_NODE_INSTALL` and treats `skip` as the explicit no-download setting. npm 11.2 and later warn about unknown keys in `.npmrc`; npm's [configuration documentation](https://docs.npmjs.com/files/npmrc/) directs third-party tools to use environment variables instead of unrecognized npm config keys.

## Decision

- Shipped npm packages and their lockfile root metadata require Node `>=22`.
- The primary Vitest jobs run on Node 22 and 24. Static analysis, blocking evaluations, SDK validation, desktop release packaging, and publication stay pinned to Node 24.
- Controlled install jobs set `ONNXRUNTIME_NODE_INSTALL=skip`. The unsupported `onnxruntime-node-install` project config key is not used.
- `npm run smoke:install-contract` is a bounded, non-installing check: it fails on npm unknown-config warnings and verifies that the installed pinned ONNX package implements the environment-variable `skip` seam.

## Consequences

Changes to package engines, quality matrices, release runtimes, install environment configuration, or the pinned ONNX installer must update the contract test in the same change. Local contributors must set `ONNXRUNTIME_NODE_INSTALL=skip` for repository dependency installation. The smoke requires dependencies to be installed first and performs no network or package mutation.
