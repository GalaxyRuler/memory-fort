# License Notice

**Memory Fort**
Copyright (c) 2026 Abdullah Al Kulaib
Contact: Abdullah@alkulaib.io

Memory Fort is licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE) for the authoritative license text.

---

## Quick summary (not legal advice)

### You may

- Use Memory Fort for personal, research, educational, nonprofit, internal, or commercial purposes.
- Study, modify, and redistribute Memory Fort.
- Redistribute modified versions, provided you comply with GPLv3's source, copyright notice, and license requirements.

### You must

- Keep the copyright and license notices intact.
- Provide the corresponding source code when distributing covered binaries or modified versions.
- License covered derivative works under GPLv3 when you distribute them.
- Follow the GPLv3 patent, anti-circumvention, and installation-information requirements where they apply.

There is no separate commercial license requirement for this repository. Commercial use is permitted under the GPLv3 terms.

---

## Authorship

Memory Fort was authored by Abdullah Al Kulaib with assistance from AI coding agents (Claude Code and Codex CLI). See [AUTHORSHIP.md](AUTHORSHIP.md) for details on AI-assisted contributions and IP ownership.

## Open source

GPLv3 is an OSI-approved and FSF-approved copyleft open-source license. The full license text in [LICENSE](LICENSE) controls over this summary.

## Third-party notices

Memory Fort ships `sqlite-vec` (`vec0`) as a SQLite loadable extension for native vector search capability checks.

- Project: `sqlite-vec`
- Author: Alex Garcia and contributors
- Repository: https://github.com/asg017/sqlite-vec
- License: Apache-2.0 OR MIT

The vendored Windows ARM64 `vec0.dll` is built from the upstream sqlite-vec amalgamation. Its provenance and SHA-256 are recorded in `vendor/sqlite-vec/win32-arm64/manifest.json`.

Memory Fort ships `onnxruntime-node` for local ONNX embedding runtime capability checks and the Phase 5 packaged contention gate.

- Project: `onnxruntime-node` / ONNX Runtime
- Author: Microsoft and contributors
- Repository: https://github.com/microsoft/onnxruntime
- NPM package: https://www.npmjs.com/package/onnxruntime-node
- Version: 1.22.0
- License: MIT
- Retained notice: `vendor/notices/onnxruntime-node-LICENSE.txt`

The npm package metadata declares MIT but the installed `onnxruntime-node` package does not include a LICENSE file, so Memory Fort retains the upstream ONNX Runtime MIT license text under `vendor/notices/`.

Memory Fort ships `BAAI/bge-small-en-v1.5` ONNX model and tokenizer assets for the local default Phase 5 embedding gate.

- Project: `BAAI/bge-small-en-v1.5`
- Author: BAAI / FlagEmbedding contributors
- Model repository: https://huggingface.co/BAAI/bge-small-en-v1.5
- Upstream project: https://github.com/FlagOpen/FlagEmbedding
- Model revision: `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`
- License: MIT
- Retained notice: `assets/embedding-models/bge-small-en-v1.5/LICENSE`
- Asset manifest: `assets/embedding-models/bge-small-en-v1.5/manifest.json`

The model card declares the model MIT-licensed. The Hugging Face model repository does not expose a raw `LICENSE` file at the model path, so Memory Fort vendors the upstream FlagEmbedding MIT license text next to the redistributed model bytes and pins it in the model manifest.
