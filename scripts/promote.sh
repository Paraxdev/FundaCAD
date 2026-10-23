#!/usr/bin/env bash
# Promote a green dev build to main, which publishes it as the beta
# (docs/ENGINE.md section 7).
#
#   scripts/promote.sh [--sha <commit on dev>] [--stable <1.minor.patch>] [--message <subject>] [--push]
#
# Checks that the dev head (or the given commit) has a dev build whose gating
# jobs are all green, merges it into main with --no-ff, and prints the push.
# dev itself may be red, a promotion may not. With --push it pushes main, and
# the main build publishes the beta once its own gating jobs are green.
# The beta page opens with docs/release-notes/beta.md, which is written by hand
# on dev before a promotion, and the script says when it did not change.
# Its "What's new" section is also the card Home shows after an update, so
# keep it short and written for makers.
# --stable also tags the merge v1.<minor>.<patch>, pushed atomically with main,
# and the tag's build publishes a stable release.
#
# The merge is made in a throwaway worktree on origin/main, so it works while
# main is checked out somewhere else, and your local main is left as it was.
set -euo pipefail

REPO=Paraxdev/FundaCAD
REMOTE=origin

usage() {
  echo "usage: $0 [--sha <commit on dev>] [--stable <1.minor.patch>] [--message <subject>] [--push]" >&2
  exit 2
}

die() {
  echo "promote: $*" >&2
  exit 1
}

version='' sha='' push=no message=''
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=yes ;;
    --sha) [ $# -ge 2 ] || usage; sha=$2; shift ;;
    --stable) [ $# -ge 2 ] || usage; version=${2#v}; shift ;;
    --message) [ $# -ge 2 ] || usage; message=$2; shift ;;
    *) usage ;;
  esac
  shift
done

tag=''
if [ -n "$version" ]; then
  # Minor 0 is the betas' 1.0.<run number>, which a stable 1.0.x would be older than.
  [[ "$version" =~ ^1\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || die "$version is not a stable version, those are 1.<minor>.<patch> with a minor of 1 or more"
  tag="v$version"
fi

cd "$(git rev-parse --show-toplevel)"
# --force because the rolling beta and development tags move on every release,
# and a plain --tags fetch refuses to update a moved tag and fails the script.
git fetch --quiet --force --tags "$REMOTE" main
git fetch --quiet "$REMOTE" dev \
  || die "could not fetch dev from $REMOTE. If it does not exist yet, create it from main first (docs/ENGINE.md section 7)."

if [ -n "$tag" ]; then
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag already exists"
  newest=$(git tag -l 'v1.*' | grep -E '^v1\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V | tail -1 || true)
  if [ -n "$newest" ] && [ "$(printf '%s\n%s\n' "$newest" "$tag" | sort -V | tail -1)" != "$tag" ]; then
    die "$tag is not newer than $newest"
  fi
fi

if [ -z "$sha" ]; then
  sha=$(git rev-parse "$REMOTE/dev")
else
  sha=$(git rev-parse --verify "$sha^{commit}") || die "no such commit: $sha"
  git merge-base --is-ancestor "$sha" "$REMOTE/dev" || die "${sha:0:7} is not on $REMOTE/dev"
fi
if git merge-base --is-ancestor "$sha" "$REMOTE/main"; then
  die "${sha:0:7} is already on main, there is nothing to promote. To release main as it is, tag it by hand (docs/ENGINE.md section 7)."
fi

# The gating jobs only: e2e is deliberately non-gating, and a flake there
# fails the run as a whole.
echo "checking for a green build of ${sha:0:7} on dev..."
runs=$(gh run list -R "$REPO" --branch dev --workflow build.yml --event push --commit "$sha" \
  --limit 5 --json databaseId --jq '.[].databaseId')
[ -n "$runs" ] || die "no build run on dev for ${sha:0:7}. A push that only touches manual/ starts none, so pass --sha with an older dev commit that has one, see: gh run list -R $REPO --branch dev"
run='' why=''
for id in $runs; do
  # shellcheck disable=SC2016
  why=$(gh run view "$id" -R "$REPO" --json jobs --jq '
    [.jobs[] | {n: (.name | sub(" [(].*"; "")), c: .conclusion}] as $j
    | [("test", "rust-geom", "bundle") as $k
       | [$j[] | select(.n == $k) | .c] as $cs
       | if ($cs | length) == 0 then "\($k) did not run"
         elif all($cs[]; . == "success") then empty
         else "\($k) is not green" end]
    | join(", ")')
  if [ -z "$why" ]; then run="https://github.com/$REPO/actions/runs/$id"; break; fi
done
[ -n "$run" ] || die "no green build of ${sha:0:7} on dev yet ($why). dev may publish a red build, main may not. See: gh run list -R $REPO --branch dev"
echo "green: $run"

if [ -z "$tag" ] && git diff --quiet "$REMOTE/main" "$sha" -- docs/release-notes/beta.md; then
  echo "note: docs/release-notes/beta.md is the same on ${sha:0:7} as on main. The beta page shows it above the generated part, so update it on dev first if this promotion changes what users see or need to do (docs/ENGINE.md section 7.1)."
fi

tmp=$(mktemp -d)
cleanup() { git worktree remove --force "$tmp" 2>/dev/null || { rm -rf "$tmp"; git worktree prune; }; }
trap cleanup EXIT
git worktree add --quiet --detach "$tmp" "$REMOTE/main"
[ -n "$message" ] || message="merge: dev is promoted to main and ships as the ${tag:-beta}"
git -C "$tmp" merge --no-ff --quiet -m "$message" "$sha" \
  || die "the merge into main failed, see git above. A conflict usually means a hotfix on main was never merged back: merge main into dev first, then try again."
merge=$(git -C "$tmp" rev-parse HEAD)
echo "merged ${sha:0:7} into main as ${merge:0:7}"

if [ -n "$tag" ]; then
  git tag -a "$tag" -m "FundaCAD $tag" "$merge"
  echo "tagged $tag on ${merge:0:7}"
  pushcmd=(git push --atomic "$REMOTE" "$merge:refs/heads/main" "refs/tags/$tag")
  undo="git tag -d $tag"
  published="the main build publishes the beta and the $tag build the stable release: gh run list -R $REPO --branch main"
else
  # Note: nothing references the merge once the worktree is gone. git keeps an
  # unreachable commit for two weeks (gc.pruneExpire), so the printed push works.
  pushcmd=(git push "$REMOTE" "$merge:refs/heads/main")
  undo=''
  published="the main build publishes the beta once it is green: gh run list -R $REPO --branch main"
fi

if [ "$push" = yes ]; then
  "${pushcmd[@]}" || die "the push failed and nothing is published.${undo:+ Undo before trying again: $undo}"
  echo "pushed, $published"
else
  echo "nothing is pushed yet. To publish:"
  echo "  ${pushcmd[*]}"
  if [ -n "$undo" ]; then
    echo "To undo instead:"
    echo "  $undo"
  fi
fi
echo "your local main is unchanged, update it with: git fetch $REMOTE && git checkout main && git merge --ff-only $REMOTE/main"
