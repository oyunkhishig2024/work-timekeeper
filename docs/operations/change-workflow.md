# How a change gets from an idea to the server

Every change goes through a **pull request**: a proposed change on its own branch that must pass the automatic checks before it joins `main`. `main` is therefore always in a state that can be deployed, and a mistake can be undone by going back one step.

## The steps

1. **Ask for the change** (in the chat with Claude, or by a GitHub issue).
2. **Claude works on its own branch** named `claude/<topic>` (never on `main`) and opens a pull request. The description says what changed and why, how it was checked, what to do on the server afterwards, and whether it is safe to go back.
3. **The automatic checks run** (about 4 minutes): formatting, linting, types, all tests against a real database, the build, `shellcheck`, the script tests, the dependency check and the secret scan. A green tick on the pull request means all of them passed. A red cross means a check failed; Claude fixes it on the same branch (the pull request updates itself).
4. **You read the description and click "Squash and merge"** (green button, only active when the checks pass). Squash turns the branch into one clean commit on `main`.
5. **On the server:** `cd ~/work-timekeeper && bash infra/deploy/update.sh` (the description says if anything more is needed).
6. **If something is wrong:** `bash infra/deploy/update.sh --previous` goes back to the version that ran before (see `infra/deploy/README.md` for the database caveat).

## Rules

- No direct pushes to `main`.
- One topic per pull request, small enough to read. A fix and a feature are two pull requests.
- Never merge a red pull request. The checks are the only safety net a small team has.
- A **hotfix** follows the same steps; it is just small and quick.
- Pull requests from **Dependabot** (weekly dependency updates, at most 3 open): merge when green, close if unsure; nothing breaks by ignoring them for a while.
- Keep migrations additive (new tables, columns, indexes) so that going back to an older version still works.

## One-time GitHub settings (repository owner)

On GitHub: **Settings** of the repository.

1. **General → Pull Requests:** tick **Allow squash merging** and untick **Allow merge commits** and **Allow rebase merging**; tick **Automatically delete head branches**.
2. **Branches → Add branch protection rule** (or _Rules → Rulesets_), branch name pattern `main`:
   - tick **Require a pull request before merging** and set **Required approvals** to **0** (you are the only reviewer; GitHub does not let you approve your own pull request);
   - tick **Require status checks to pass before merging**, search for and add **`verify`** (it appears once the CI has run), and tick **Require branches to be up to date before merging**;
   - tick **Do not allow bypassing the above settings** (this includes you: it is what makes "no direct pushes" true);
   - leave **Allow force pushes** and **Allow deletions** unticked.
3. Check: a direct `git push origin main` is now refused, and the merge button of a pull request with a failing check stays grey.

If you ever need to bypass it in an emergency, untick **Do not allow bypassing** for the minutes you need and tick it again afterwards.
