#!/usr/bin/env bash
# Promote a green dev build to a stable release (docs/ENGINE.md section 7).
#
#   scripts/promote-stable.sh 1.2.0 [--sha <commit on dev>] [--push]
#
# Merges the dev head (or the given commit) into main with --no-ff, tags the
# merge v1.2.0, and prints the push. With --push it pushes main and the tag in
# one atomic push, and the tag's build publishes the release.
#
# The merge is made in a throwaway worktree on origin/main, so it works while
# main is checked out somewhere else, and your local main is left as it was.
set -euo pipefail

REPO=Paraxdev/FundaCAD
REMOTE=origin

usage() {
  echo "usage: $0 <1.minor.patch> [--sha <commit on dev>] [--push]" >&2
  exit 2
}

die() {
  echo "promote-stable: $*" >&2
  exit 1
}

version='' sha='' push=no
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=yes ;;
    --sha) [ $# -ge 2 ] || usage; sha=$2; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$version" ] || usage; version=${1#v} ;;
  esac
  shift
done
[ -n "$version" ] || usage
# Minor 0 is the betas' 1.0.<run number>, which a stable 1.0.x would be older than.
[[ "$version" =~ ^1\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "$version is not a stable version, those are 1.<minor>.<patch> with a minor of 1 or more"
tag="v$version"

cd "$(git rev-parse --show-toplevel)"
git fetch --quiet --tags "$REMOTE" main
git fetch --quiet "$REMOTE" dev \
  || die "could not fetch dev from $REMOTE. If it does not exist yet, create it from main first (docs/ENGINE.md section 7)."

git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag already exists"

newest=$(git tag -l 'v1.*' | grep -E '^v1\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V | tail -1 || true)
if [ -n "$newest" ] && [ "$(printf '%s\n%s\n' "$newest" "$tag" | sort -V | tail -1)" != "$tag" ]; then
  die "$tag is not newer than $newest"
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
[ -n "$run" ] || die "no green build of ${sha:0:7} on dev yet ($why), see: gh run list -R $REPO --branch dev"
echo "green: $run"

tmp=$(mktemp -d)
cleanup() { git worktree remove --force "$tmp" 2>/dev/null || { rm -rf "$tmp"; git worktree prune; }; }
trap cleanup EXIT
git worktree add --quiet --detach "$tmp" "$REMOTE/main"
git -C "$tmp" merge --no-ff --quiet -m "merge: dev into main for $tag" "$sha" \
  || die "the merge into main failed, see git above. A conflict usually means a hotfix on main was never merged back: merge main into dev first, then try again."
merge=$(git -C "$tmp" rev-parse HEAD)

git tag -a "$tag" -m "FundaCAD $tag" "$merge"
echo "tagged $tag on ${merge:0:7}, the merge of ${sha:0:7} into main"

pushcmd=(git push --atomic "$REMOTE" "$merge:refs/heads/main" "refs/tags/$tag")
if [ "$push" = yes ]; then
  "${pushcmd[@]}"
  echo "pushed, the $tag build publishes the release: gh run list -R $REPO --branch $tag"
else
  echo "nothing is pushed yet. To publish:"
  echo "  ${pushcmd[*]}"
  echo "To undo instead:"
  echo "  git tag -d $tag"
fi
echo "your local main is unchanged, update it with: git fetch $REMOTE && git checkout main && git merge --ff-only $REMOTE/main"
