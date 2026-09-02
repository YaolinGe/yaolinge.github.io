#!/usr/bin/env bash
# Run the whole suite. No dependencies: python3 and git are enough.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m unittest discover -s tests -t tests "$@"
