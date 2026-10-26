#!/bin/sh
set -eu
umask 077
root=/opt/votemachine
revision=${1:?Pass a commit hash}
case "$revision" in *[!0-9a-f]*|'') exit 2 ;; esac
[ "${#revision}" -eq 40 ] || exit 2
# Keep pushes and manual retries in one release order
exec 9>"$root/deploy.lock"
flock 9
export DEPLOY_REVISION="$revision" COMPOSE_PARALLEL_LIMIT=1
release="$root/releases/$revision"
mkdir -p "$release"
# Check archive creation before reading it so Git failures stop deployment
git --git-dir="$root/repo.git" archive --output="$release/source.tar" "$revision"
tar -xf "$release/source.tar" -C "$release"
rm "$release/source.tar"
# Use installed operator config so an application push cannot replace secrets
compose() {
  docker compose --project-name votemachine --project-directory "$release" \
    --env-file "$root/config/runtime.env" \
    -f "$release/compose.yaml" -f "$release/compose.production.yaml" \
    -f "$root/config/compose.yaml" "$@"
}
compose config --quiet
# Build first so a failed build leaves the running release alone
for service in migrate api web; do
  compose build "$service"
done
compose up -d --wait postgres garage
# Avoid mixing web releases or accepting writes during schema changes
compose stop edge web api asset-cleanup
compose run --rm --no-deps migrate
compose up -d --no-build --wait --wait-timeout 180 api web asset-cleanup edge
ln -sfn "$release" "$root/current"
printf '%s\n' "$revision" > "$root/deployed-revision"
echo "Deployed $revision"
