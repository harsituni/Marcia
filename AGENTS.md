# AGENTS.md

Rules for AI coding agents working in this repo. Read [README.md](README.md)
first for the project overview and team split.

## When told "build Mxx"

1. **Find the issue.** Look it up by milestone number, then read all of it:

   ```sh
   gh issue list --search "Mxx in:title"
   gh issue view <number>
   ```

   The issue's **What**, **Done when**, **Contract** and **Blocked by**
   sections are the spec. Do not invent requirements beyond them. If something
   is unclear or a blocker is still open, ask instead of guessing.

2. **Branch.** Create a branch from the latest `origin/main` named
   `mxx-short-name` (lowercase), for example `m03-readme-agents`:

   ```sh
   git fetch origin
   git switch -c mxx-short-name origin/main
   ```

3. **Build only what the issue asks for.** Keep diffs small and focused on
   that milestone. Don't reformat, rename or "tidy up" unrelated files.

4. **Check before opening a PR:**

   ```sh
   npm run typecheck
   npm test
   ```

5. **Open a PR** whose body includes `Closes #<number>` (the issue number, not
   the milestone number) so merging it closes the issue.

## `src/contracts.ts` is off-limits

**Never edit `src/contracts.ts` unless the issue says to.** It is the shared
boundary between the engine track (Akileash) and the UI track (Harsit). Any
change to it needs the other person's PR approval.

If the task looks like it needs a contract change and the issue doesn't call
for one, stop and say so. Don't work around it.

## Git hygiene

- Never force-push and never rewrite `main`.
- Don't change dependencies (`package.json`, `package-lock.json`) unless the
  issue calls for it.
- Don't regenerate `fixtures/` unless the issue calls for it.
