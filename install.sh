#!/bin/sh
# Installs the latest droid-models from GitHub Releases, and checks the download against its published checksum.
# Set DROID_MODELS_INSTALL_DIR to install somewhere other than ~/.local/bin.
set -eu

main() {
	repo="DanielOu1208/droid-external-models"
	dir="${DROID_MODELS_INSTALL_DIR:-$HOME/.local/bin}"

	case "$(uname -s)" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		*) fail "droid-models runs on macOS and Linux, not $(uname -s)." ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch=arm64 ;;
		x86_64 | amd64) arch=x64 ;;
		*) fail "droid-models has no build for $(uname -m)." ;;
	esac
	# A terminal running under Rosetta reports Intel on Apple Silicon.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi

	archive="droid-models-$os-$arch.tar.gz"
	base="https://github.com/$repo/releases/latest/download"
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT

	echo "Downloading $archive"
	curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "Couldn't download $base/$archive"
	curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "Couldn't download the checksums."

	grep " $archive\$" "$tmp/checksums.txt" >"$tmp/expected" || fail "$archive isn't in the checksums."
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "$tmp" && sha256sum -c expected >/dev/null) || fail "The download doesn't match its checksum, so nothing was installed."
	else
		(cd "$tmp" && shasum -a 256 -c expected >/dev/null) || fail "The download doesn't match its checksum, so nothing was installed."
	fi

	tar -xzf "$tmp/$archive" -C "$tmp" droid-models
	chmod 755 "$tmp/droid-models"
	version="$("$tmp/droid-models" --version 2>/dev/null)" || fail "The downloaded app won't run on this computer, so nothing was installed. On Linux it needs glibc, so Alpine won't work."

	mkdir -p "$dir"
	# Moved into place so that a running copy, or a model in Droid using it, is never left with half a file.
	mv "$tmp/droid-models" "$dir/.droid-models.tmp"
	mv "$dir/.droid-models.tmp" "$dir/droid-models"
	echo "Installed droid-models $version to $dir/droid-models"

	case ":$PATH:" in
		*":$dir:"*) echo "Run droid-models to start." ;;
		*)
			echo "Your shell can't find that folder yet. Add this line to your shell's startup file, then open a new terminal:"
			echo "  export PATH=\"$dir:\$PATH\""
			;;
	esac
}

fail() {
	echo "$1" >&2
	exit 1
}

main
