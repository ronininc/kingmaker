---
name: formatting-commits
description: Generates a well-structured, conventional Git commit message from the user's staged changes or a description of what they did. Use when the user says "write a commit message", "format my commit", or "help me commit this". Outputs a ready-to-paste commit message following the Conventional Commits specification.
---

# Git Commit Formatting SOP

## Execution Steps

### Step 1: Gather Staged Changes
If the user has not provided a description, run:
```
!`git diff --staged`
```
to capture the actual code changes as context.

### Step 2: Classify the Change Type
Determine the correct Conventional Commits type based on the diff or description:
- `feat` — A new feature
- `fix` — A bug fix
- `docs` — Documentation only changes
- `style` — Formatting, missing semi-colons, etc.
- `refactor` — Code change that is neither a fix nor a feature
- `chore` — Build process, dependency updates
- `test` — Adding or fixing tests

### Step 3: Extract Scope
Identify the affected module, component, or file area (e.g., `auth`, `api`, `ui`). Use `(scope)` in the commit header.

### Step 4: Write the Commit Message
Compose the full commit message following this structure:
```
<type>(<scope>): <short imperative summary under 72 chars>

<optional body: what changed and why, not how>

<optional footer: BREAKING CHANGE: ... or Closes #issue>
```

**Examples:**

Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

Input: Fixed bug where dates displayed incorrectly in reports
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

Input: Updated dependencies and refactored error handling
Output:
```
chore: update dependencies and refactor error handling

- Upgrade lodash to 4.17.21
- Standardize error response format across endpoints
```

### Step 5: Deliver
Output the final commit message in a single code block, ready to copy-paste into the terminal.
