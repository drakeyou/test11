#!/bin/sh
# Remove what can be regenerated. Never touches collected data.
#
#   ./clean.sh          show what would go
#   ./clean.sh --yes    remove it
#
# Kept deliberately: data/ (the collection), the CSVs the collectors append to,
# node_modules/ (reinstallable but slow), and samples*/ — those are the recorded
# fixtures the test suite runs against, not leftovers.

set -e
DISPOSABLE="__pycache__ export export.zip captures .pytest_cache"

echo "regenerable:"
for path in $DISPOSABLE; do
  [ -e "$path" ] && echo "  $(du -sh "$path" 2>/dev/null | cut -f1)	$path"
done
echo
echo "kept — collected data:"
for path in data odds-history.csv changes.csv mapping.csv pm-resolutions.csv pm-position-gaps.csv; do
  [ -e "$path" ] && echo "  $(du -sh "$path" 2>/dev/null | cut -f1)	$path"
done
echo
echo "kept — test fixtures, the suite fails without them:"
for path in samples samples2 samples-pm; do
  [ -e "$path" ] && echo "  $(du -sh "$path" 2>/dev/null | cut -f1)	$path"
done

if [ "$1" = "--yes" ]; then
  for path in $DISPOSABLE; do rm -rf "$path"; done
  echo
  echo "removed the regenerable files."
else
  echo
  echo "nothing removed. Run './clean.sh --yes' to remove the regenerable files."
fi
