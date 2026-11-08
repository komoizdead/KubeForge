# Hooks

Lifecycle drivers around KubeForge runs.

Hooks fall into two groups:

- **Repository hooks** — checks that run before commits or in CI (for example, requiring
  `pnpm typecheck` to pass).
- **Agent lifecycle hooks** — code that runs before or after an agent execution, with the agent name
  and report passed in.

Keep hook scripts portable across POSIX shells and Windows, and document every hook alongside the
script that implements it.
