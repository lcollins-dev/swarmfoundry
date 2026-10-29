Review #{{issue.iid}}, "{{issue.title}}", in {{project.path}}: {{issue.url}}

## 1. Start

1. Read the ticket and its comments with `glab issue view {{issue.iid}} --comments`, then the docs it links.
2. Find the branch with `git branch -r --list 'origin/{{issue.iid}}-*'`, and its merge request with
   `glab mr list --source-branch <branch>`. Hand the ticket to a person where there is none.
3. Check out the branch and install the dependencies as the project describes.

## 2. Earlier work

- List the earlier verdicts, oldest first:
  `glab api --paginate "projects/:id/merge_requests/<mr>/notes?sort=asc" | jq -r '.[].body | select(startswith("Swarmfoundry review:")) | split("\n")[0]'`
- Count the send-backs: the `Swarmfoundry review: changes requested` lines after the last
  `Swarmfoundry review: handed to a person`.
- Check that each discussion the implement agent resolved is fixed in the code.

## 3. Findings

1. Start these subagents in parallel, each given only the branch, the merge request and the issue number. A subagent
   only reports.
   - Tests: map each acceptance criterion and each rule the change touches to a test at the lowest layer, by name.
     Report the gaps, a test that asserts what it mocked, and a behaviour tested at two layers.
   - Security: run `/security-review`, only where the ticket carries a `security` label.
   - Docs: check every claim in the docs the branch touches against the code, and report each the code does not
     bear out.
2. Meanwhile, run `/code-review` at `high` on the branch against the target, and check it merges cleanly.
3. Check the pipeline with `glab ci status --branch <branch> --wait` and a 10-minute Bash `timeout`, again until it
   finishes. Where none passed, run the checks the project's `CLAUDE.md` and skills name.
4. Confirm each finding yourself before you use it, and drop one you cannot. A blocking finding is a confirmed bug,
   an acceptance criterion unmet or untested, a failing check, a broken project rule, a false docs claim, a merge
   conflict, or an unresolved discussion you agree with. Every other finding is a note.

## 4. Hand over

1. Post each blocking finding as its own discussion, on its diff line where it has one, and skip one already open:
   `glab api -X POST "projects/:id/merge_requests/<mr>/discussions" -f body=<finding> -F 'position=<json>'`, with the
   position built from the merge request's `diff_refs` as
   `{"position_type":"text","base_sha":"<sha>","start_sha":"<sha>","head_sha":"<sha>","new_path":"<path>","new_line":<line>}`.
2. Post a verdict note on the merge request, its first line one of these, listing the notes worth a follow-up:
   - `Swarmfoundry review: approved`, where nothing blocks.
   - `Swarmfoundry review: changes requested (<n> of 2)`, where something blocks and there are fewer than two
     send-backs.
   - `Swarmfoundry review: handed to a person`, where something blocks and there are two send-backs already.
3. Apply the verdict's label as your last act: add `workflow::approved` or `workflow::ready`, removing
   `workflow::review`, or add `foundry::needs-human` and leave `workflow::review` for a hand-over.
