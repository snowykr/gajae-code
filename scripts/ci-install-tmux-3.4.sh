#!/usr/bin/env bash
# Build the pinned tmux source fixture used by the strict restart CI proof.
set -euo pipefail

readonly tmux_version="3.4"
readonly tmux_url="https://github.com/tmux/tmux/releases/download/${tmux_version}/tmux-${tmux_version}.tar.gz"
readonly tmux_sha256="551ab8dea0bf505c0ad6b7bb35ef567cdde0ccb84357df142c254f35a23e19aa"

if [[ -n "${TMUX_INSTALL_PREFIX:-}" ]]; then
   prefix="$TMUX_INSTALL_PREFIX"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
   prefix="$RUNNER_TEMP/tmux-${tmux_version}-prefix"
else
   prefix="${TMPDIR:-/tmp}/tmux-${tmux_version}-prefix"
fi
prefix="${prefix%/}"
if [[ -z "$prefix" || "$prefix" == "/" || "$prefix" == "${HOME:-}" ]]; then
   echo "ci-install-tmux: refusing unsafe install prefix '$prefix'" >&2
   exit 1
fi

case "$(uname -s)" in
   Darwin) platform="macos" ;;
   Linux) platform="linux" ;;
   *)
      echo "ci-install-tmux: unsupported platform '$(uname -s)'" >&2
      exit 1
      ;;
esac


work_dir="$(mktemp -d "${TMPDIR:-/tmp}/tmux-${tmux_version}.XXXXXX")"
cleanup() {
   rm -rf "$work_dir"
}
trap cleanup EXIT

archive="$work_dir/tmux-${tmux_version}.tar.gz"
source_dir="$work_dir/tmux-${tmux_version}"

for required_tool in curl tar make cc; do
   if ! command -v "$required_tool" >/dev/null 2>&1; then
      echo "ci-install-tmux: $required_tool is required to build tmux" >&2
      exit 1
   fi
done

case "$platform" in
   macos)
      if ! command -v brew >/dev/null 2>&1; then
         echo "ci-install-tmux: Homebrew is required on macOS" >&2
         exit 1
      fi
      if ! brew install libevent ncurses pkg-config; then
         echo "ci-install-tmux: failed to install libevent, ncurses, and pkg-config with Homebrew" >&2
         exit 1
      fi
      for dependency in libevent ncurses; do
         dependency_prefix="$(brew --prefix "$dependency")"
         CPPFLAGS="${CPPFLAGS:-} -I${dependency_prefix}/include"
         LDFLAGS="${LDFLAGS:-} -L${dependency_prefix}/lib"
         PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}${PKG_CONFIG_PATH:+:}${dependency_prefix}/lib/pkgconfig"
      done
      export CPPFLAGS LDFLAGS PKG_CONFIG_PATH
      ;;
   linux)
      if ! command -v pkg-config >/dev/null 2>&1; then
         echo "ci-install-tmux: pkg-config is required on Linux; install the pkg-config package" >&2
         exit 1
      fi
      if ! pkg-config --exists libevent; then
         echo "ci-install-tmux: libevent development metadata is required on Linux; install libevent-dev or the equivalent package" >&2
         exit 1
      fi
      if ! pkg-config --exists ncursesw && ! pkg-config --exists ncurses; then
         echo "ci-install-tmux: ncurses development metadata is required on Linux; install libncurses-dev or the equivalent package" >&2
         exit 1
      fi
      ;;
esac
curl --fail --location --retry 3 --retry-all-errors --silent --show-error \
   "$tmux_url" --output "$archive"

if command -v sha256sum >/dev/null 2>&1; then
   printf '%s  %s\n' "$tmux_sha256" "$archive" | sha256sum --check --status
elif command -v shasum >/dev/null 2>&1; then
   printf '%s  %s\n' "$tmux_sha256" "$archive" | shasum --algorithm 256 --check --status
else
   echo "ci-install-tmux: sha256sum or shasum is required" >&2
   exit 1
fi

tar -xzf "$archive" -C "$work_dir"
mkdir -p "$prefix"

(
   cd "$source_dir"
   ./configure --prefix="$prefix"
   make -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2')"
   make install
)

version="$("${prefix}/bin/tmux" -V)"
if [[ "$version" != "tmux ${tmux_version}" ]]; then
   echo "ci-install-tmux: expected 'tmux ${tmux_version}', got '$version'" >&2
   exit 1
fi
printf '%s\n' "$version"

if [[ -n "${GITHUB_PATH:-}" ]]; then
   printf '%s/bin\n' "$prefix" >> "$GITHUB_PATH"
fi
export PATH="$prefix/bin:$PATH"
