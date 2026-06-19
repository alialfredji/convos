# Agent Instructions

- Before pushing or telling the user work is ready to push, explain exactly how to test the change and how that validation proves the intended behavior works.
- Prefer real end-to-end checks for resume behavior, not only unit tests. For example, use `npm run dev -- resume <session-id> --print-cmd` to inspect the command and `npm run dev -- resume <session-id>` to confirm it launches.
- Always run the relevant automated tests, usually `npm test`, and report if a test could not be run.
- Keep changes surgical and match the existing TypeScript style.
