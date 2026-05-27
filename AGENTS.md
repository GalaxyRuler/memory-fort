# memory-system

<!-- BEGIN CODEX HOMELAB RUNNER INTEGRATION -->
## Homelab Runner Integration

This project may use the central Homelab runner for isolated, noisy, GUI, installer, VM, container, or long-running validation.

Project runner config:
- .codex/homelab-runner.json

Before running noisy tests, GUI automation, installers, VM jobs, or long-running validation:
1. Read .codex/homelab-runner.json.
2. Use the configured Homelab runner route.
3. Prefer containers for CLI, API, unit, integration, and headless checks.
4. Do not run GUI automation, MSI install/uninstall, or destructive validation on the active WHITEDRAGON desktop unless explicitly approved.
5. Keep project-specific runner profiles inside this repo, not in Homelab core.

<!-- END CODEX HOMELAB RUNNER INTEGRATION -->

