Implement #{{issue.iid}}, "{{issue.title}}", in {{project.path}}: {{issue.url}}

## 1. Start

- Read the ticket and its comments with `glab issue view {{issue.iid}} --comments`, then the docs it links.
- Load the project's workflow skills, if any, and follow them where the Unattended rules allow.

## 2. Earlier work

- Look for a branch with `git branch -r --list 'origin/{{issue.iid}}-*'`. Follow New branch without one, Existing
  branch with one. Continue it; never restart.

### New branch

1. Branch `{{issue.iid}}-<short-slug>` from the default branch.

### Existing branch

1. Check it out, and find its merge request with `glab mr list --source-branch <branch>`.
2. Read the merge request's unresolved discussions with `glab mr view <mr> --unresolved`. Treat each one opened by
   `$MR_REVIEWER` or by you as part of the ticket, and ignore the rest.
3. Rebase onto the target branch where the merge request conflicts with it, and push with `--force-with-lease`.

## 3. Plan

- Name what you will touch and what it builds on. Pick a test, at the lowest layer that proves it, for each
  acceptance criterion and each discussion.
- Build the slice that stands alone where the ticket is too big for one merge request, and say what is left.

## 4. Build

- Match the code around you. Reuse what exists before you add.
- Commit and push each slice once the project's checks pass on it, so a retry can continue from it.

## 5. Check

1. Run the checks the project's `CLAUDE.md` and skills name, unit and integration both.
2. Run `/security-review` where the ticket carries a `security` label.
3. Fix each failure and run them again until they pass.

## 6. Hand over

1. Open the merge request against the default branch, ready for review, with `--assignee "$MR_REVIEWER"`. List each
   call a person might make differently, each starting `Assumed:`. On a re-run, update the open one's description
   instead.
2. Tick each acceptance criterion on the ticket that the branch meets.
3. Reply on each discussion you picked up, saying what changed or why it stays. Resolve the ones you fixed.
4. Wait for the pipeline with `glab ci status --branch <branch> --wait` and a 10-minute Bash `timeout`, again until it
   finishes. Fix and push until it passes. Note a failure outside your change in the merge request instead.
5. Add `workflow::review` to the ticket, removing `workflow::in-progress`, as your last act.
